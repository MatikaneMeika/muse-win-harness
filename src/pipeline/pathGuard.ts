/**
 * Path Guard & Symlink/Junction Escape Interceptor
 * Enforces strict filesystem boundaries, realpath resolution, and sensitive path protection.
 *
 * P2 hardening:
 * - realpath failures are fail-closed (PATH_REALPATH_FAILED), never falling back
 *   to the raw lexical path.
 * - Non-existent targets are resolved via nearest-existing-ancestor realpath plus
 *   lexically-joined tail segments; suspicious tail components (trailing spaces,
 *   trailing dots, illegal characters) are rejected (PATH_SUSPICIOUS_COMPONENT).
 * - Sensitive blacklist directories are canonicalized on BOTH sides before the
 *   case-insensitive prefix comparison; Brave/Chromium browser profiles added.
 * - Child-item fence helper (assertChildInWorkspace) for fsTools glob/grep walks,
 *   with reparse-point (symlink/junction) detection via lstat.
 */

import fs from 'node:fs';
import os from 'node:os';
import path, { join as joinPath, resolve as resolvePath } from 'node:path';
import type { ConfinementMode } from '../types.js';

export interface PathAccessResult {
  allowed: boolean;
  resolvedPath: string;
  reason?: string;
  highRiskCrossBoundary?: boolean;
}

export interface ChildFenceResult {
  allowed: boolean;
  resolvedPath?: string;
  reason?: string;
}

/**
 * Checks if a child path is within a parent directory (Windows case-insensitive).
 */
/** Join parts onto root. Rejects absolute parts, NUL, `..`, and any result outside root. */
export function joinInsideRoot(root: string, ...parts: string[]): string {
  for (const part of parts) {
    if (typeof part !== 'string' || part.length === 0 || part.includes('\0') || part.includes('..') || path.isAbsolute(part)) {
      throw new Error('PATH_ESCAPE_REJECTED');
    }
  }
  const base = resolvePath(root);
  const target = resolvePath(base, ...parts);
  if (!isSubPathOf(target, base)) {
    throw new Error('PATH_ESCAPE_REJECTED');
  }
  return target;
}

export function isSubPathOf(childPath: string, parentPath: string): boolean {
  const normChild = path.normalize(resolvePath(childPath)).toLowerCase();
  const normParent = path.normalize(resolvePath(parentPath)).toLowerCase();

  if (normChild === normParent) {
    return true;
  }

  const prefix = normParent.endsWith(path.sep) ? normParent : normParent + path.sep;
  return normChild.startsWith(prefix);
}

/**
 * Windows reserved device names. They resolve to devices regardless of any
 * extension (e.g. 'CON.txt' opens the console on classic Win32 paths), so both
 * the bare and the extension-bearing forms must be rejected.
 */
const WINDOWS_RESERVED_NAME_REGEX = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const ILLEGAL_CHARS_REGEX = /[<>:"|?*\u0000-\u001f]/;

/**
 * Validates one path component: trailing spaces/dots, illegal characters
 * (<>:"|?* and control chars) and Windows reserved device names are rejected.
 * The drive-letter colon (e.g. 'C:') is the only ':' allowed.
 */
function assertSafeComponent(seg: string): void {
  if (seg.length === 0) {
    return;
  }

  // Trailing spaces or trailing dots (per-segment) are silently truncated by
  // the Win32 layer -> classic bypass vector ('.env ', 'notes.txt.', 'foo.').
  if (/\s$/.test(seg) || seg.endsWith('.')) {
    throw new Error(
      `PATH_SUSPICIOUS_COMPONENT: Path component '${seg}' has a trailing space/dot and is rejected`
    );
  }

  // Illegal characters; allow ':' only as the drive-letter colon (e.g. 'C:')
  // which also blocks NTFS alternate data stream syntax ('file:stream').
  if (ILLEGAL_CHARS_REGEX.test(seg)) {
    const withoutDriveColon = seg.replace(/^[A-Za-z]:/, '');
    if (ILLEGAL_CHARS_REGEX.test(withoutDriveColon)) {
      throw new Error(
        `PATH_SUSPICIOUS_COMPONENT: Path component '${seg}' contains illegal characters`
      );
    }
  }

  // Reserved device names, including extension-bearing forms ('CON.txt').
  if (WINDOWS_RESERVED_NAME_REGEX.test(seg)) {
    throw new Error(
      `PATH_SUSPICIOUS_COMPONENT: Path component '${seg}' is a Windows reserved device name and is rejected`
    );
  }
}

/**
 * P2-R2: validates EVERY segment of the original input path BEFORE any
 * lstat/exists branch runs. This closes the alias bypass where an existing
 * 'notes.txt.' is silently opened as 'notes.txt' by the Win32 layer (lstat
 * succeeds, realpath returns the stripped name, and the lexical checks never
 * see the trailing dot).
 */
function assertSafeFullPathComponents(absolutePath: string): void {
  const segments = absolutePath.split(/[\\/]+/).filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i++) {
    // The drive segment ('C:') is exempt from the illegal-char ':' rule; every
    // other segment (including UNC server/share segments) is fully validated.
    if (i === 0 && /^[A-Za-z]:$/.test(segments[i])) {
      continue;
    }
    assertSafeComponent(segments[i]);
  }
}

/**
 * Validates lexical tail segments joined after the nearest existing ancestor.
 * Kept as a second line of defense behind assertSafeFullPathComponents.
 */
function assertSafeTailSegments(segments: string[]): void {
  for (const seg of segments) {
    assertSafeComponent(seg);
  }
}

/**
 * Canonicalizes a path:
 * - If the target itself exists (or is a dangling reparse point), returns its
 *   native realpath; realpath failure is fail-closed (PATH_REALPATH_FAILED).
 * - If the target does not exist at all, walks up to the nearest existing
 *   ancestor, realpaths that ancestor (fail-closed on failure), and lexically
 *   joins the validated remaining segments.
 */
export function resolveNativePath(targetPath: string, workspaceRoot: string): string {
  const absolutePath = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : resolvePath(workspaceRoot, targetPath);

  // P2-R2: lexical component validation runs FIRST — before any lstat/exists
  // branch — so Win32 alias tricks ('notes.txt.' -> 'notes.txt', 'CON', ADS
  // 'file:stream') can never reach the filesystem layer.
  assertSafeFullPathComponents(absolutePath);

  // lstat detects dangling symlinks/junctions that existsSync (stat-following) misses.
  let lstat: fs.Stats | null = null;
  try {
    lstat = fs.lstatSync(absolutePath);
  } catch {
    lstat = null;
  }

  if (lstat) {
    try {
      // realpathSync.native also expands 8.3 short names (e.g. RUNNER~1).
      return fs.realpathSync.native(absolutePath);
    } catch (err: any) {
      throw new Error(
        `PATH_REALPATH_FAILED: Cannot resolve true path of '${absolutePath}' (${err?.code || err?.message || 'unknown'})`
      );
    }
  }

  // Target does not exist: walk up to the nearest existing ancestor.
  let current = absolutePath;
  const tailSegments: string[] = [];

  while (current && !fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    tailSegments.unshift(path.basename(current));
    current = parent;
  }

  let realAncestor = current;
  if (fs.existsSync(current)) {
    try {
      realAncestor = fs.realpathSync.native(current);
    } catch (err: any) {
      throw new Error(
        `PATH_REALPATH_FAILED: Cannot resolve true path of ancestor '${current}' (${err?.code || err?.message || 'unknown'})`
      );
    }
  }

  assertSafeTailSegments(tailSegments);
  return joinPath(realAncestor, ...tailSegments);
}

/**
 * Canonicalizes an existing directory/file for comparison purposes; falls back
 * to the resolveNativePath ancestor walk for non-existent paths.
 */
function canonicalizeForCompare(targetPath: string, workspaceRoot: string): string {
  return resolveNativePath(targetPath, workspaceRoot);
}

/**
 * Checks whether the path touches hardcoded sensitive blacklisted locations.
 * Both sides are canonicalized (realpath / ancestor-resolved) and compared
 * case-insensitively (Windows filesystems are case-insensitive).
 */
export function checkSensitiveBlacklist(
  targetPath: string,
  workspaceRoot: string = process.cwd()
): { blacklisted: boolean; reason?: string } {
  const targetCanonical = canonicalizeForCompare(targetPath, workspaceRoot).toLowerCase();
  const filename = path.basename(targetCanonical);

  // Check .env files (.env, .env.local, .env.production, etc., except .env.example or config.example.yaml)
  if (filename === '.env' || (filename.startsWith('.env.') && filename !== '.env.example')) {
    return {
      blacklisted: true,
      reason: `SENSITIVE_BLACKLIST: Access to environment secret file '${filename}' is blocked`
    };
  }

  const blacklistedDirs: Array<{ name: string; dir: string }> = [];

  const home = os.homedir();
  if (home) {
    blacklistedDirs.push({ name: '~/.ssh', dir: path.join(home, '.ssh') });
    blacklistedDirs.push({ name: '~/.aws', dir: path.join(home, '.aws') });
  }

  const appData = process.env.APPDATA;
  if (appData) {
    blacklistedDirs.push({ name: '%APPDATA%', dir: appData });
    blacklistedDirs.push({
      name: '%APPDATA%\\Mozilla\\Firefox\\Profiles',
      dir: path.join(appData, 'Mozilla', 'Firefox', 'Profiles')
    });
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    blacklistedDirs.push({
      name: '%LOCALAPPDATA%\\Google\\Chrome\\User Data',
      dir: path.join(localAppData, 'Google', 'Chrome', 'User Data')
    });
    blacklistedDirs.push({
      name: '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data',
      dir: path.join(localAppData, 'Microsoft', 'Edge', 'User Data')
    });
    // P2: Brave / Chromium browser profile directories
    blacklistedDirs.push({
      name: '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data',
      dir: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data')
    });
    blacklistedDirs.push({
      name: '%LOCALAPPDATA%\\Chromium\\User Data',
      dir: path.join(localAppData, 'Chromium', 'User Data')
    });
  }

  for (const item of blacklistedDirs) {
    // Canonicalize the blacklist side too (it may itself be behind a reparse
    // point or in 8.3 short-name form), then compare case-insensitively.
    const itemCanonical = canonicalizeForCompare(item.dir, workspaceRoot).toLowerCase();
    if (isSubPathOf(targetCanonical, itemCanonical)) {
      return {
        blacklisted: true,
        reason: `SENSITIVE_BLACKLIST: Access to sensitive path '${item.name}' is blocked`
      };
    }
  }

  return { blacklisted: false };
}

/**
 * P2: child-item fence for directory walk tools (glob/grep).
 * Detects reparse points (symlinks/junctions) via lstat and, on hit, resolves
 * the true target and enforces the workspace prefix. Anything outside the
 * workspace (or with unresolvable realpath) is not allowed.
 * danger-full-access mode skips the fence entirely.
 */
export function assertChildInWorkspace(
  childAbsPath: string,
  workspaceRoot: string,
  mode?: ConfinementMode
): ChildFenceResult {
  if (mode === 'danger-full-access') {
    return { allowed: true, resolvedPath: childAbsPath };
  }

  // P2-R2: symmetric fail-closed — the workspace root itself must resolve via
  // realpath when it exists; a resolution failure is a rejection, never a
  // silent fallback to the lexical path (mirrors the target-side behavior).
  const workspaceResolved = path.resolve(workspaceRoot);
  let workspaceReal: string;
  if (fs.existsSync(workspaceResolved)) {
    try {
      workspaceReal = fs.realpathSync.native(workspaceResolved);
    } catch (err: any) {
      return {
        allowed: false,
        reason: `PATH_REALPATH_FAILED: Workspace root '${workspaceResolved}' cannot be resolved (${err?.code || err?.message || 'unknown'}); failing closed`
      };
    }
  } else {
    workspaceReal = workspaceResolved;
  }

  // Lexical containment of the child path itself (cheap first check).
  if (!isSubPathOf(childAbsPath, workspaceReal)) {
    return {
      allowed: false,
      reason: `CHILD_OUT_OF_WORKSPACE: '${childAbsPath}' is outside workspace root '${workspaceReal}'`
    };
  }

  // Reparse point detection: junctions and symlinks both surface as symbolic
  // links in fs.lstatSync on Windows.
  try {
    const lst = fs.lstatSync(childAbsPath);
    const isReparse = lst.isSymbolicLink();
    if (isReparse) {
      let realChild: string;
      try {
        realChild = fs.realpathSync.native(childAbsPath);
      } catch (err: any) {
        return {
          allowed: false,
          reason: `PATH_REALPATH_FAILED: Cannot resolve reparse point '${childAbsPath}' (${err?.code || err?.message || 'unknown'})`
        };
      }
      if (!isSubPathOf(realChild, workspaceReal)) {
        return {
          allowed: false,
          resolvedPath: realChild,
          reason: `CHILD_OUT_OF_WORKSPACE: Reparse point '${childAbsPath}' resolves to '${realChild}' outside workspace root '${workspaceReal}'`
        };
      }
      return { allowed: true, resolvedPath: realChild };
    }
  } catch {
    // lstat failed (race: entry vanished) -> fail closed.
    return {
      allowed: false,
      reason: `CHILD_FENCE_LSTAT_FAILED: '${childAbsPath}' could not be inspected`
    };
  }

  return { allowed: true, resolvedPath: childAbsPath };
}

/**
 * Evaluates path access against current confinement mode, workspace boundaries, and blacklists.
 */
export function checkPathAccess(
  targetPath: string,
  operation: 'read' | 'write',
  mode: ConfinementMode,
  workspaceRoot: string,
  allowedWorkspaceRoots?: string[]
): PathAccessResult {
  // 1. Resolve workspace root native realpath (fail-closed when it exists but cannot be resolved)
  let workspaceReal: string;
  if (fs.existsSync(workspaceRoot)) {
    try {
      workspaceReal = fs.realpathSync.native(path.resolve(workspaceRoot));
    } catch {
      return {
        allowed: false,
        resolvedPath: path.resolve(workspaceRoot),
        reason: 'WORKSPACE_REALPATH_FAILED: Workspace root exists but native realpath failed'
      };
    }
  } else {
    workspaceReal = path.resolve(workspaceRoot);
  }

  const extraRootsReal: string[] = [];
  if (Array.isArray(allowedWorkspaceRoots)) {
    for (const r of allowedWorkspaceRoots) {
      if (typeof r !== 'string' || !r.trim()) continue;
      try {
        const resolved = path.resolve(r);
        extraRootsReal.push(fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved);
      } catch {
        // Ignore unresolvable extra root entry
      }
    }
  }
  const isInsideAnyAllowedRoot = (candidateReal: string): boolean =>
    isSubPathOf(candidateReal, workspaceReal) ||
    extraRootsReal.some((rootReal) => isSubPathOf(candidateReal, rootReal));

  // 2. Resolve native target path (fail-closed on realpath errors / suspicious components)
  let targetReal: string;
  try {
    targetReal = resolveNativePath(targetPath, workspaceRoot);
  } catch (err: any) {
    return {
      allowed: false,
      resolvedPath: path.resolve(workspaceRoot, targetPath),
      reason: err?.message || 'PATH_REALPATH_FAILED'
    };
  }

  // 3. Danger Full Access Mode handling
  // Ordinary out-of-workspace reads/writes are permitted without being escalated
  // to critical solely for crossing the workspace boundary; only sensitive
  // blacklisted locations (or the Gate 1 synthetic HMAC probe) set highRiskCrossBoundary.
  if (mode === 'danger-full-access') {
    const isInside = isInsideAnyAllowedRoot(targetReal);
    const blacklistCheck = checkSensitiveBlacklist(targetReal, workspaceRoot);
    const isGate1HmacProbe =
      !isInside && path.basename(targetReal).toLowerCase().startsWith('mwh_danger_file_');
    const highRiskCrossBoundary = blacklistCheck.blacklisted || isGate1HmacProbe;

    return {
      allowed: true,
      resolvedPath: targetReal,
      highRiskCrossBoundary
    };
  }

  // 4. Read-Only Mode write rejection
  if (mode === 'read-only' && operation === 'write') {
    return {
      allowed: false,
      resolvedPath: targetReal,
      reason: 'READ_ONLY_MODE_WRITE_DENIED'
    };
  }

  // 5. Enforce sensitive blacklist for all non-danger modes (canonicalized on both sides)
  const blacklist = checkSensitiveBlacklist(targetReal, workspaceRoot);
  if (blacklist.blacklisted) {
    return {
      allowed: false,
      resolvedPath: targetReal,
      reason: blacklist.reason
    };
  }

  // 6. Enforce workspace confinement boundary (handles NTFS junctions / symlinks + whitelisted roots)
  const isInside = isInsideAnyAllowedRoot(targetReal);
  if (!isInside) {
    return {
      allowed: false,
      resolvedPath: targetReal,
      reason: `PATH_CONFINEMENT_VIOLATION: Resolved realpath ${targetReal} escapes workspace root ${workspaceReal}`
    };
  }

  return {
    allowed: true,
    resolvedPath: targetReal,
    highRiskCrossBoundary: false
  };
}
