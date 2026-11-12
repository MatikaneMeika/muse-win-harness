/**
 * Desktop Hands (Win32 GUI Automation)
 * Provides DPI-aware screenshot, mouse control, and keyboard input via Win32 / .NET APIs.
 * Disabled by default.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { joinInsideRoot } from '../pipeline/pathGuard.js';

export interface DesktopHandsParams {
  action: 'screenshot' | 'mouse_move' | 'click' | 'type_text';
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  text?: string;
}

export class DesktopHands {
  public static execute(params: DesktopHandsParams, enabled = false): any {
    if (!enabled) {
      throw new Error('DESKTOP_HANDS_DISABLED: Desktop Hands is disabled in configuration.');
    }

    if (process.platform !== 'win32') {
      throw new Error('PLATFORM_NOT_SUPPORTED: Desktop Hands only supports Windows platform.');
    }

    switch (params.action) {
      case 'screenshot': {
        const tempPath = joinInsideRoot(os.tmpdir(), `screenshot_${Date.now()}.png`);
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::SetHighDpiMode([System.Windows.Forms.HighDpiMode]::PerMonitorV2) | Out-Null
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bitmap.Save("${tempPath.replace(/\\/g, '/')}", [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`;
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        return {
          action: 'screenshot',
          path: tempPath,
          format: 'png'
        };
      }

      case 'mouse_move': {
        const rawX = Number(params.x ?? 0);
        const rawY = Number(params.y ?? 0);
        if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
          throw new Error('INVALID_COORDINATES: mouse_move requires finite numeric x and y coordinates');
        }
        const x = Math.trunc(rawX);
        const y = Math.trunc(rawY);
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
`;
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        return { action: 'mouse_move', x, y };
      }

      case 'click': {
        const button = params.button || 'left';
        let flagDown = 0x0002; // MOUSEEVENTF_LEFTDOWN
        let flagUp = 0x0004;   // MOUSEEVENTF_LEFTUP

        if (button === 'right') {
          flagDown = 0x0008;
          flagUp = 0x0010;
        } else if (button === 'middle') {
          flagDown = 0x0020;
          flagUp = 0x0040;
        }

        const psScript = `
$signature = @"
[DllImport("user32.dll", CharSet=CharSet.Auto, CallingConvention=CallingConvention.StdCall)]
public static extern void mouse_event(long dwFlags, long dx, long dy, long cButtons, long dwExtraInfo);
"@
$mouse = Add-Type -memberDefinition $signature -name "Win32Mouse" -namespace Win32Functions -passThru
$mouse::mouse_event(${flagDown}, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
$mouse::mouse_event(${flagUp}, 0, 0, 0, 0)
`;
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        return { action: 'click', button };
      }

      case 'type_text': {
        const text = params.text || '';
        if (text.length > 4096) {
          throw new Error('TEXT_TOO_LONG: type_text text exceeds the 4096 character limit');
        }
        // Escape special SendKeys characters: + ^ % ~ ( ) { }
        const escaped = text.replace(/[{}+^%~()]/g, '{$&}');
        // Pass the text as a PowerShell single-quoted literal: inside '...' no
        // interpolation/backtick expansion happens; only ' needs doubling.
        const psLiteral = escaped.replace(/'/g, "''");
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${psLiteral}')
`;
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        return { action: 'type_text', length: text.length };
      }

      default:
        throw new Error(`UNKNOWN_DESKTOP_HANDS_ACTION: ${params.action}`);
    }
  }
}
