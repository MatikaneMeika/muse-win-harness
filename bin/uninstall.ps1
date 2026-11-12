<#
.SYNOPSIS
    Muse-Win-Harness (MWH) Uninstaller & Cleanup Script
.DESCRIPTION
    Stops running MWH daemons (dist\cli.js, src\cli.ts, muse-win-harness tsx
    runtime), stops/deletes matching Windows services if present, cleans up
    scheduled tasks, removes temporary git worktrees, and restores Medium
    integrity level ACLs.
    Fail-closed: if ACL restoration fails, the script exits with a non-zero
    code and never prints [UNINSTALL_COMPLETE].
#>

param(
    [string]$WorkspaceDir = (Resolve-Path "$PSScriptRoot\..").Path,
    [string]$TargetAclDir = ""
)

$ErrorActionPreference = "Continue"

Write-Host "==============================================================="
Write-Host "  MUSE-WIN-HARNESS (MWH) UNINSTALLATION & CLEANUP"
Write-Host "  Target Workspace: $WorkspaceDir"
Write-Host "==============================================================="

# -----------------------------------------------------------------------------
# STEP 1: Stop MWH Daemon Processes (dist\cli.js, src\cli.ts, muse-win-harness
# incl. tsx runtime states)
# -----------------------------------------------------------------------------
Write-Host "`n[1/5] Stopping MWH daemon processes..."
$mwhProcs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    # Match ONLY the daemon entrypoints (dist\cli.js / src\cli.ts via tsx).
    # Never match by repo folder name: that would kill ANY node process whose
    # command line mentions this repo (gate suites, verify.mjs children, ...).
    $_.CommandLine -match 'dist[/\\]cli\.js|src[/\\]cli\.ts'
}

if ($mwhProcs) {
    foreach ($p in $mwhProcs) {
        Write-Host "  -> Terminating MWH process PID $($p.ProcessId)"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "  -> No running MWH daemon processes found."
}

# -----------------------------------------------------------------------------
# STEP 2: Stop & Delete Windows Services Matching muse-win-harness*
# (user-level installs normally have no service — existence is checked first)
# -----------------------------------------------------------------------------
Write-Host "`n[2/5] Checking for Windows services matching muse-win-harness*..."
$services = Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -like 'muse-win-harness*' -or $_.DisplayName -like 'muse-win-harness*'
}

if ($services) {
    foreach ($svc in $services) {
        Write-Host "  -> Stopping service: $($svc.Name)"
        & sc.exe stop "$($svc.Name)" 2>$null | Out-Null
        Write-Host "  -> Deleting service: $($svc.Name)"
        & sc.exe delete "$($svc.Name)" 2>$null | Out-Null
    }
} else {
    Write-Host "  -> No matching Windows services found."
}

# -----------------------------------------------------------------------------
# STEP 3: Remove Scheduled Tasks Matching Muse-Win-Harness*
# -----------------------------------------------------------------------------
Write-Host "`n[3/5] Removing scheduled tasks matching Muse-Win-Harness*..."
$tasks = Get-ScheduledTask -TaskName "Muse-Win-Harness*" -ErrorAction SilentlyContinue
if ($tasks) {
    foreach ($t in $tasks) {
        Write-Host "  -> Unregistering task: $($t.TaskName)"
        Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "  -> No matching scheduled tasks found."
}

# -----------------------------------------------------------------------------
# STEP 4: Clean up Git Worktrees under .mwh\worktrees
# -----------------------------------------------------------------------------
Write-Host "`n[4/5] Cleaning up Git worktrees under $WorkspaceDir\.mwh\worktrees..."
if (Test-Path (Join-Path $WorkspaceDir ".git")) {
    try {
        & git -C "$WorkspaceDir" worktree prune 2>$null
    } catch {}
}

$worktreesDir = Join-Path $WorkspaceDir ".mwh\worktrees"
if (Test-Path $worktreesDir) {
    $subtrees = Get-ChildItem -Path $worktreesDir -Directory -ErrorAction SilentlyContinue
    foreach ($st in $subtrees) {
        Write-Host "  -> Removing worktree: $($st.Name)"
        try {
            & git -C "$WorkspaceDir" worktree remove --force "$($st.FullName)" 2>$null
        } catch {}
        Remove-Item -Path $st.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "  -> No worktrees directory found."
}

# -----------------------------------------------------------------------------
# STEP 5: Restore Medium Integrity ACL on Workspace & Target Directory
# P3-R2 fail-closed semantics:
#   - icacls command execution failure (exit code != 0)  -> [UNINSTALL_FAILED] + exit 1
#     (restoration could not be confirmed == failure; NEVER downgraded to a warning)
#   - probe (icacls query) failure                        -> [UNINSTALL_FAILED] + exit 1
#   - Low Mandatory Level residue confirmed and icacls restore succeeds -> verified, then OK
#   - Low residue confirmed but restore fails / still Low after restore   -> [UNINSTALL_FAILED] + exit 1
#   - explicit Medium label already present               -> nothing to do
#   - icacls succeeds but NO explicit integrity label line (system default Medium) -> [WARN] only
# -----------------------------------------------------------------------------
Write-Host "`n[5/5] Restoring Medium integrity level ACL via icacls..."

function Get-MandatoryLevelInfo([string]$Path) {
    # Returns @{ Ok = <bool>; Level = 'Low'|'High'|'Medium'|'None' }.
    # Ok=$false means the probe itself failed (cannot confirm the current level).
    $out = (& icacls "$Path" 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0) {
        return @{ Ok = $false; Level = 'None' }
    }
    if ($out -match 'Low Mandatory Level') { return @{ Ok = $true; Level = 'Low' } }
    if ($out -match 'High Mandatory Level') { return @{ Ok = $true; Level = 'High' } }
    if ($out -match 'Medium Mandatory Level') { return @{ Ok = $true; Level = 'Medium' } }
    return @{ Ok = $true; Level = 'None' } # no explicit label = system default (Medium)
}

function Restore-MediumIntegrity([string]$Path) {
    # Returns $null on success, or a failure message string.
    $probe = Get-MandatoryLevelInfo $Path
    if (-not $probe.Ok) {
        return "cannot probe integrity level of '$Path' (icacls query failed); restoration state UNCONFIRMED"
    }
    switch ($probe.Level) {
        'Low' {
            # Confirmed Low residue: restore Medium, then verify the result.
            & icacls "$Path" /setintegritylevel "(OI)(CI)Medium" 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) {
                return "icacls /setintegritylevel failed on '$Path' (exit code $LASTEXITCODE); Low Mandatory Level residue could NOT be restored"
            }
            $after = Get-MandatoryLevelInfo $Path
            if (-not $after.Ok) {
                return "icacls restore ran on '$Path' but post-restore verification failed; restoration state UNCONFIRMED"
            }
            if ($after.Level -eq 'Low') {
                return "icacls reported success on '$Path' but the directory is STILL at Low Mandatory Level"
            }
            Write-Host "  -> Low residue on '$Path' restored to Medium (verified: $($after.Level) Mandatory Level)"
            return $null
        }
        'Medium' {
            Write-Host "  -> '$Path' already at Medium Mandatory Level, nothing to restore"
            return $null
        }
        'High' {
            return "unexpected High Mandatory Level on '$Path'; Medium restoration could not be confirmed"
        }
        default {
            # No explicit integrity label line: system default applies (Medium).
            Write-Host "  -> [WARN] no explicit integrity label on '$Path' (system default Medium); nothing to restore"
            return $null
        }
    }
}

$aclFailures = @()

if ($TargetAclDir) {
    if (Test-Path $TargetAclDir) {
        Write-Host "  -> Restoring Medium integrity level on $TargetAclDir"
        $fail = Restore-MediumIntegrity $TargetAclDir
        if ($fail) { $aclFailures += $fail }
    } else {
        Write-Host "  -> TargetAclDir '$TargetAclDir' does not exist, skipping."
    }
}

if ($WorkspaceDir) {
    if (Test-Path $WorkspaceDir) {
        Write-Host "  -> Restoring Medium integrity level on $WorkspaceDir"
        $fail = Restore-MediumIntegrity $WorkspaceDir
        if ($fail) { $aclFailures += $fail }
    } else {
        Write-Host "  -> WorkspaceDir '$WorkspaceDir' does not exist, skipping."
    }
}

if ($aclFailures.Count -gt 0) {
    Write-Host "`n==============================================================="
    Write-Host "[UNINSTALL_FAILED] ACL restoration failed -- cleanup is INCOMPLETE:"
    foreach ($f in $aclFailures) {
        Write-Host "  -> $f"
    }
    Write-Host "Fix the ACL failures (permissions/ownership) and re-run the uninstaller."
    Write-Host "==============================================================="
    exit 1
}

Write-Host "`n==============================================================="
Write-Host "[UNINSTALL_COMPLETE] Muse-Win-Harness uninstalled successfully."
Write-Host "==============================================================="
exit 0
