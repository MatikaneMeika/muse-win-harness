/**
 * Declarations and JSON Schemas for the 8 Muse Tools
 */

import type { ToolMetaCategory } from '../types.js';

export interface ToolDefinition {
  name: string;
  category: ToolMetaCategory;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export const MUSE_TOOLS: ToolDefinition[] = [
  {
    name: 'pc_status',
    category: 'read',
    description: 'Retrieves host machine telemetry, confinement mode, approval policy, security boundary, and available local CLIs.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'fs_explore',
    category: 'read',
    description: 'Safely explores the filesystem with boundary enforcement (read, list, glob, grep).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'list', 'glob', 'grep'],
          description: 'The exploration action to perform'
        },
        path: {
          type: 'string',
          description: 'Relative or absolute path to inspect'
        },
        pattern: {
          type: 'string',
          description: 'Pattern for glob or grep'
        },
        offset: {
          type: 'number',
          description: 'Line offset for file reading'
        },
        limit: {
          type: 'number',
          description: 'Maximum lines to read'
        }
      },
      required: ['action', 'path']
    }
  },
  {
    name: 'fs_mutate',
    category: 'write',
    description: 'Safely mutates filesystem files (write, edit, move, delete) with automatic pre-mutation git snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['write', 'edit', 'move', 'delete'],
          description: 'Mutation operation'
        },
        path: {
          type: 'string',
          description: 'Target path'
        },
        content: {
          type: 'string',
          description: 'Content for write operation'
        },
        oldText: {
          type: 'string',
          description: 'Existing text to replace in edit mode'
        },
        newText: {
          type: 'string',
          description: 'Replacement text in edit mode'
        },
        destination: {
          type: 'string',
          description: 'Target destination for move operation'
        },
        recursive: {
          type: 'boolean',
          description: 'Recursive deletion flag'
        }
      },
      required: ['action', 'path']
    }
  },
  {
    name: 'exec_command',
    category: 'sensitive_write',
    description: 'Executes a shell command with Win32 Job Object containment and fast/slow dual-track execution.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command line to execute'
        },
        cwd: {
          type: 'string',
          description: 'Working directory'
        },
        yieldTimeMs: {
          type: 'number',
          description: 'Foreground threshold before backgrounding (default: 8000ms)'
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum command execution timeout in milliseconds'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'job_control',
    category: 'write',
    description: 'Controls background jobs (poll, events, steer, stdin, abort, status) and resolves conversational confirmation approvals (approve, reject).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['poll', 'events', 'steer', 'stdin', 'abort', 'approve', 'reject', 'status'],
          description: 'Action to perform'
        },
        jobId: {
          type: 'string',
          description: 'Target Job ID for poll, events, steer, stdin, or abort'
        },
        afterSeq: {
          type: 'number',
          description: 'Event sequence cursor for action="events" (default: 0)'
        },
        waitMs: {
          type: 'number',
          description: 'Bounded long-poll duration in ms for action="events" (0..25000)'
        },
        limit: {
          type: 'number',
          description: 'Maximum events to return for action="events" (1..512)'
        },
        page: {
          type: 'number',
          description: 'Log page number for poll (chunks of <=8192 bytes)'
        },
        pageSize: {
          type: 'number',
          description: 'Maximum bytes per page for poll (max: 8192)'
        },
        input: {
          type: 'string',
          description: 'Standard input or live steer prompt string to deliver to running process'
        },
        approvalId: {
          type: 'string',
          description: 'Approval ID to approve or reject'
        },
        sig: {
          type: 'string',
          description: 'One-time HMAC signature required for critical approvals'
        },
        granularity: {
          type: 'string',
          enum: ['once', 'session', 'workspace'],
          description: 'Approval memory scope'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'subagent_dispatch',
    category: 'sensitive_write',
    description:
      'Invokes and controls a profile-addressed local subagent (ACP stdio agent, custom profile ID, or builtin kernel) with privilege ceiling enforcement, git worktree isolation, incremental event ring streaming (action="events"/"wait"), live mid-run steering (action="steer"), and cooperative gradient teardown (action="interrupt"). Any profile ID is directly addressable via agent or profile (no fixed enum). Default timeoutMs is 600000 (10 minutes).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'resume', 'events', 'wait', 'steer', 'send', 'interrupt', 'cancel', 'list', 'profiles'],
          description: 'Subagent lifecycle action (default: "run"; use "resume" with jobId/runId to continue a dead/terminated session from disk)'
        },
        agent: {
          type: 'string',
          description:
            'Target ACP profile ID or engine name (any configured ACP profile id such as "agy", "codebuddy", or "acp", "builtin"; default: "builtin")'
        },
        profile: {
          type: 'string',
          description: 'Explicit ACP profile ID (aliases "agent" when addressing a profile directly, or defaults to the configured default profile when agent is "acp")'
        },
        prompt: {
          type: 'string',
          description: 'Task instructions for action="run"/"resume" (or follow-up text for action="steer")'
        },
        input: {
          type: 'string',
          description: 'Follow-up prompt text for action="steer"/"send"'
        },
        jobId: {
          type: 'string',
          description: 'Target jobId for events, wait, steer, or interrupt'
        },
        runId: {
          type: 'string',
          description: 'Alias of jobId for events, wait, steer, or interrupt'
        },
        afterSeq: {
          type: 'number',
          description: 'Event sequence cursor for action="events"/"wait" (default: 0)'
        },
        waitMs: {
          type: 'number',
          description: 'Long-poll wait window in ms for action="events"/"wait" (max: 25000)'
        },
        limit: {
          type: 'number',
          description: 'Maximum events or jobs to return (default: 100 for events, 20 for list)'
        },
        childMode: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'workspace-acl-experimental', 'danger-full-access'],
          description: 'Confinement mode ceiling for the child'
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the subagent (must stay inside the workspace fence)'
        },
        isolateWorktree: {
          type: 'boolean',
          description: 'Whether to isolate execution in a dedicated Git worktree'
        },
        maxSteps: {
          type: 'number',
          description: 'Maximum autonomous ReAct steps (default: 15)'
        },
        timeoutMs: {
          type: 'number',
          description: 'Subagent timeout in milliseconds (default: 600000)'
        },
        async: {
          type: 'boolean',
          description: 'Return a RUNNING_ASYNC receipt after yieldTimeMs instead of blocking (default: true for MCP/REST calls)'
        },
        yieldTimeMs: {
          type: 'number',
          description: 'Foreground yield window before backgrounding (default: 500ms)'
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string' },
              params: { type: 'object' }
            },
            required: ['tool', 'params']
          },
          description: 'Optional structured execution steps for builtin mode'
        }
      }
    }
  },
  {
    name: 'git_checkpoint',
    category: 'write',
    description: 'Creates deterministic snapshots of tracked and untracked files and provides 1-click rollback.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'diff', 'create', 'rollback'],
          description: 'Git checkpoint operation'
        },
        checkpointId: {
          type: 'string',
          description: 'Target checkpoint ID for rollback'
        },
        label: {
          type: 'string',
          description: 'Optional descriptive label for create action'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'desktop_hands',
    category: 'sensitive_write',
    description:
      'Native Windows desktop automation (windows, inspect UIA tree with elementToken and head+tail value preservation, screenshot with multimodal image output [unified full virtual-screen capture in Per-Monitor Aware V2 physical pixels, 1:1 source-space redaction of sensitive windows first, then proportional downsampling to <=3840x2160 with scaleFactor], background-first act [background type_text resolves child Edit/RichEditD2DPT/UIA text surfaces and enforces read-back tail verification returning verified/tailMatched/readBackLength/targetHwnd or failing with BACKGROUND_TYPE_TEXT_UNVERIFIED], and emergency-stoppable batch [aborted batches return outer status SUCCESS with [ABORTED] summary to carry step results while approval receipts record executionStatus ERROR / terminalStatus TERMINATED to prevent false-positive completion]). For native desktop apps only—use Resource Library MCP tools for web/browser tasks. Disabled by default.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['windows', 'inspect', 'screenshot', 'act', 'batch', 'mouse_move', 'click', 'type_text'],
          description: 'Desktop operation: windows (enumerate), inspect (UIA tree), screenshot (capture), act (single input/UIA op), batch (multi-step sequence)'
        },
        hwnd: {
          type: 'number',
          description: 'Target window handle (HWND) from windows action'
        },
        titleFilter: {
          type: 'string',
          description: 'Optional substring filter on window title for windows action'
        },
        processFilter: {
          type: 'string',
          description: 'Optional substring filter on process executable name for windows action'
        },
        includeMinimized: {
          type: 'boolean',
          description: 'Include minimized windows in windows action (default true)'
        },
        maxDepth: {
          type: 'number',
          description: 'Max UIA tree depth for inspect (1-8, default 4)'
        },
        maxNodes: {
          type: 'number',
          description: 'Max UIA nodes for inspect (10-300, default 120)'
        },
        region: {
          type: 'object',
          description: 'Optional screen capture region { x, y, width, height } in physical pixels. Default omitted or sentinel oversized region (e.g. 99999x99999) both capture the full multi-monitor virtual desktop, redact sensitive windows in 1:1 source pixels, and proportionally downsample to <=3840x2160 (returning physical bounds and scaleFactor).'
        },
        delivery: {
          type: 'string',
          enum: ['auto', 'background', 'foreground'],
          description: 'Delivery channel: auto (background-first), background (UIA/PostMessage only), foreground (SendInput fallback, requires setting/approval)'
        },
        op: {
          type: 'string',
          enum: ['click', 'double_click', 'right_click', 'move', 'type_text', 'hotkey', 'scroll', 'invoke', 'set_value', 'toggle', 'select', 'focus', 'wait'],
          description: 'Operation for act action'
        },
        x: {
          type: 'number',
          description: 'Screen X coordinate (physical pixels)'
        },
        y: {
          type: 'number',
          description: 'Screen Y coordinate (physical pixels)'
        },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button for click'
        },
        text: {
          type: 'string',
          description: 'Text string to type or set_value. For background type_text with hwnd, MWH resolves the child text-input control (Edit/RichEditD2DPT/UIA ValuePattern), appends text atomically (including on minimized windows), and verifies read-back tail match (returning verified, tailMatched, readBackLength, targetHwnd; throws BACKGROUND_TYPE_TEXT_UNVERIFIED if unverified).'
        },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key combo for hotkey (e.g. ["ctrl", "c"])'
        },
        delta: {
          type: 'number',
          description: 'Scroll wheel delta (positive up, negative down)'
        },
        automationId: {
          type: 'string',
          description: 'UIA AutomationId selector for UIA ops'
        },
        name: {
          type: 'string',
          description: 'UIA Name selector for UIA ops'
        },
        controlType: {
          type: 'string',
          description: 'UIA ControlType filter'
        },
        elementToken: {
          type: 'string',
          description: 'Session elementToken returned by inspect for direct UIA/pointer targeting'
        },
        value: {
          type: 'string',
          description: 'Value for UIA set_value'
        },
        durationMs: {
          type: 'number',
          description: 'Wait duration in ms (max 10000)'
        },
        steps: {
          type: 'array',
          description: 'Ordered step list for batch action (max 30 steps). If interrupted by kill/emergency-stop, data.status is ABORTED (outer transport status SUCCESS with [ABORTED] summary; receipt executionStatus is ERROR / terminalStatus TERMINATED).',
          items: { type: 'object' }
        }
      },
      required: ['action']
    }
  }
];

/**
 * Conditionally exposed built-in: only listed when at least one local Skill in
 * the resource library is enabled (same pattern as `desktop_hands`). Kept out of
 * `MUSE_TOOLS` so the 7/8 core tool contract in the gates stays unchanged.
 */
export const SKILL_READ_TOOL: ToolDefinition = {
  name: 'skill_read',
  category: 'read',
  description:
    'Reads the full SKILL.md text of an enabled local Skill registered in the MWH resource library. Disabled or unknown Skills are rejected.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Registered Skill name (as listed in SKILL.md / pc_status)'
      }
    },
    required: ['name']
  }
};

/**
 * Returns the active Muse tools exposed over MCP (/mcp), REST (/api/v1/tools),
 * and SKILL.md. `desktop_hands` is only exposed when explicitly enabled in
 * configuration (`desktopHands.enabled === true`). `extras` carries the resource
 * library's contributions: tools of enabled and healthy MCP servers, plus
 * `skill_read` when at least one local Skill is enabled.
 */
export function getExposedMuseTools(
  desktopHandsEnabled = false,
  extras: ToolDefinition[] = []
): ToolDefinition[] {
  const base = desktopHandsEnabled
    ? MUSE_TOOLS
    : MUSE_TOOLS.filter((t) => t.name !== 'desktop_hands');
  const taken = new Set(base.map((t) => t.name));
  const extraTools = extras.filter((t) => {
    if (!t || !t.name || taken.has(t.name)) return false;
    taken.add(t.name);
    return true;
  });
  return [...base, ...extraTools];
}
