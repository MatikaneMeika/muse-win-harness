/**
 * Lazy-Loaded Resident Windows UI Automation (UIA) Bridge
 * - Spawns a single persistent PowerShell + inline C# UIAutomationClient worker
 *   only when `inspect` or UIA `act` is first called.
 * - Assigned to MWH's Win32JobObject so it terminates cleanly on exit or emergency kill.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { Win32JobObject } from '../pipeline/win32Job.js';

export interface UiaNode {
  name: string;
  automationId: string;
  controlType: string;
  bounds: { x: number; y: number; width: number; height: number };
  patterns: string[];
  isEnabled: boolean;
  isOffscreen: boolean;
  value?: string;
  children?: UiaNode[];
}

interface PendingReq {
  resolve: (val: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const UIA_CSHARP_HOST_SCRIPT = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Web.Extensions
$ErrorActionPreference = 'Stop'

$code = @"
using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Automation;

public static class MwhUiaHelper {
    public static Dictionary<string, object> Inspect(long hwndVal, int maxDepth, int maxNodes) {
        AutomationElement root = hwndVal > 0
            ? AutomationElement.FromHandle(new IntPtr(hwndVal))
            : AutomationElement.RootElement;
        if (root == null) throw new Exception("UIA_ROOT_NOT_FOUND");
        int count = 0;
        var tree = Walk(root, 0, maxDepth, maxNodes, ref count);
        return new Dictionary<string, object> {
            { "nodeCount", count },
            { "tree", tree }
        };
    }

    private static Dictionary<string, object> Walk(AutomationElement el, int depth, int maxDepth, int maxNodes, ref int count) {
        count++;
        var info = el.Current;
        Rect r = info.BoundingRectangle;
        var patterns = new List<string>();
        string val = null;
        try {
            foreach (var p in el.GetSupportedPatterns()) {
                patterns.Add(p.ProgrammaticName.Replace("Identifiers.Pattern", ""));
            }
            object vpObj;
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vpObj)) {
                var vp = vpObj as ValuePattern;
                if (vp != null && !info.IsPassword) val = vp.Current.Value;
            }
        } catch {}

        var node = new Dictionary<string, object> {
            { "name", info.Name ?? "" },
            { "automationId", info.AutomationId ?? "" },
            { "controlType", info.ControlType != null ? info.ControlType.ProgrammaticName.Replace("ControlType.", "") : "" },
            { "bounds", new Dictionary<string, object> {
                { "x", double.IsInfinity(r.X) ? 0 : (int)Math.Round(r.X) },
                { "y", double.IsInfinity(r.Y) ? 0 : (int)Math.Round(r.Y) },
                { "width", double.IsInfinity(r.Width) ? 0 : (int)Math.Round(r.Width) },
                { "height", double.IsInfinity(r.Height) ? 0 : (int)Math.Round(r.Height) }
            }},
            { "patterns", patterns },
            { "isEnabled", info.IsEnabled },
            { "isOffscreen", info.IsOffscreen }
        };
        if (val != null) node["value"] = val.Length > 200 ? val.Substring(0, 200) : val;

        if (depth < maxDepth && count < maxNodes) {
            var children = new List<object>();
            var walker = TreeWalker.ControlViewWalker;
            AutomationElement child = null;
            try { child = walker.GetFirstChild(el); } catch {}
            while (child != null && count < maxNodes) {
                children.Add(Walk(child, depth + 1, maxDepth, maxNodes, ref count));
                try { child = walker.GetNextSibling(child); } catch { child = null; }
            }
            if (children.Count > 0) node["children"] = children;
        }
        return node;
    }

    public static Dictionary<string, object> Act(long hwndVal, string automationId, string name, string controlType, string op, string value) {
        AutomationElement root = hwndVal > 0
            ? AutomationElement.FromHandle(new IntPtr(hwndVal))
            : AutomationElement.RootElement;
        if (root == null) throw new Exception("UIA_WINDOW_NOT_FOUND");

        var conds = new List<Condition>();
        if (!string.IsNullOrEmpty(automationId)) conds.Add(new PropertyCondition(AutomationElement.AutomationIdProperty, automationId));
        if (!string.IsNullOrEmpty(name)) conds.Add(new PropertyCondition(AutomationElement.NameProperty, name));
        Condition cond = conds.Count == 0 ? Condition.TrueCondition : (conds.Count == 1 ? conds[0] : new AndCondition(conds.ToArray()));

        AutomationElement target = root.FindFirst(TreeScope.Descendants, cond);
        if (target == null) throw new Exception("UIA_ELEMENT_NOT_FOUND");

        if (op == "invoke") {
            object p;
            if (!target.TryGetCurrentPattern(InvokePattern.Pattern, out p)) throw new Exception("UIA_PATTERN_UNSUPPORTED: InvokePattern");
            ((InvokePattern)p).Invoke();
        } else if (op == "set_value") {
            object p;
            if (!target.TryGetCurrentPattern(ValuePattern.Pattern, out p)) throw new Exception("UIA_PATTERN_UNSUPPORTED: ValuePattern");
            ((ValuePattern)p).SetValue(value ?? "");
        } else if (op == "toggle") {
            object p;
            if (!target.TryGetCurrentPattern(TogglePattern.Pattern, out p)) throw new Exception("UIA_PATTERN_UNSUPPORTED: TogglePattern");
            ((TogglePattern)p).Toggle();
        } else if (op == "select") {
            object p;
            if (!target.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) throw new Exception("UIA_PATTERN_UNSUPPORTED: SelectionItemPattern");
            ((SelectionItemPattern)p).Select();
        } else if (op == "focus") {
            target.SetFocus();
        } else {
            throw new Exception("UNKNOWN_UIA_OP: " + op);
        }

        return new Dictionary<string, object> {
            { "ok", true },
            { "op", op },
            { "targetName", target.Current.Name ?? "" },
            { "automationId", target.Current.AutomationId ?? "" }
        };
    }
}
"@

Add-Type -TypeDefinition $code -ReferencedAssemblies UIAutomationClient,UIAutomationTypes,WindowsBase
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = 16777216

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $req = $null
    try {
        $req = $ser.DeserializeObject($line)
        $id = $req["id"]
        $cmd = $req["cmd"]
        if ($cmd -eq "inspect") {
            $hwnd = [long]($req["hwnd"])
            $depth = if ($req.ContainsKey("maxDepth")) { [int]$req["maxDepth"] } else { 4 }
            $nodes = if ($req.ContainsKey("maxNodes")) { [int]$req["maxNodes"] } else { 120 }
            $res = [MwhUiaHelper]::Inspect($hwnd, $depth, $nodes)
            $out = @{ id = $id; ok = $true; data = $res }
            [Console]::Out.WriteLine($ser.Serialize($out))
        } elseif ($cmd -eq "act") {
            $hwnd = [long]($req["hwnd"])
            $aid = if ($req.ContainsKey("automationId")) { [string]$req["automationId"] } else { "" }
            $nm = if ($req.ContainsKey("name")) { [string]$req["name"] } else { "" }
            $ct = if ($req.ContainsKey("controlType")) { [string]$req["controlType"] } else { "" }
            $op = [string]($req["op"])
            $val = if ($req.ContainsKey("value")) { [string]$req["value"] } else { "" }
            $res = [MwhUiaHelper]::Act($hwnd, $aid, $nm, $ct, $op, $val)
            $out = @{ id = $id; ok = $true; data = $res }
            [Console]::Out.WriteLine($ser.Serialize($out))
        } else {
            $out = @{ id = $id; ok = $false; error = "UNKNOWN_CMD" }
            [Console]::Out.WriteLine($ser.Serialize($out))
        }
    } catch {
        $idVal = if ($req -ne $null -and $req.ContainsKey("id")) { $req["id"] } else { "" }
        $out = @{ id = $idVal; ok = $false; error = $_.Exception.Message }
        [Console]::Out.WriteLine($ser.Serialize($out))
    }
    [Console]::Out.Flush()
}
`;

export class UiaBridge {
  private static child: ChildProcessWithoutNullStreams | null = null;
  private static job: Win32JobObject | null = null;
  private static pending = new Map<string, PendingReq>();
  private static seq = 0;

  private static ensureStarted(): ChildProcessWithoutNullStreams {
    if (process.platform !== 'win32') {
      throw new Error('PLATFORM_NOT_SUPPORTED: UIA bridge only supports Windows');
    }
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }

    const encoded = Buffer.from(UIA_CSHARP_HOST_SCRIPT, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );

    if (child.pid) {
      try {
        if (!this.job) this.job = new Win32JobObject('MWH_UIA_BRIDGE');
        this.job.assignPid(child.pid);
      } catch {
        // Best-effort job containment
      }
    }

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        const req = this.pending.get(String(msg.id));
        if (!req) return;
        this.pending.delete(String(msg.id));
        clearTimeout(req.timer);
        if (msg.ok) req.resolve(msg.data);
        else req.reject(new Error(msg.error || 'UIA_BRIDGE_ERROR'));
      } catch {
        // Ignore malformed non-JSON lines
      }
    });

    child.on('exit', () => {
      for (const [id, req] of this.pending.entries()) {
        clearTimeout(req.timer);
        req.reject(new Error('UIA_BRIDGE_EXITED'));
        this.pending.delete(id);
      }
      if (this.child === child) this.child = null;
    });

    this.child = child;
    return child;
  }

  public static dispose(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
    if (this.job) {
      try {
        this.job.terminate();
      } catch {}
      this.job = null;
    }
  }

  private static request(payload: Record<string, any>, timeoutMs = 10000): Promise<any> {
    const child = this.ensureStarted();
    const id = `uia_${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('UIA_BRIDGE_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, ...payload }) + '\n', 'utf-8');
    });
  }

  public static async inspect(params: {
    hwnd: number;
    maxDepth?: number;
    maxNodes?: number;
  }): Promise<{ nodeCount: number; tree: UiaNode }> {
    const maxDepth = Math.max(1, Math.min(8, Math.trunc(params.maxDepth ?? 4)));
    const maxNodes = Math.max(10, Math.min(300, Math.trunc(params.maxNodes ?? 120)));
    return this.request({
      cmd: 'inspect',
      hwnd: params.hwnd,
      maxDepth,
      maxNodes
    });
  }

  public static async act(params: {
    hwnd: number;
    automationId?: string;
    name?: string;
    controlType?: string;
    op: 'invoke' | 'set_value' | 'toggle' | 'select' | 'focus';
    value?: string;
  }): Promise<any> {
    return this.request({
      cmd: 'act',
      hwnd: params.hwnd,
      automationId: params.automationId || '',
      name: params.name || '',
      controlType: params.controlType || '',
      op: params.op,
      value: params.value ?? ''
    });
  }
}
