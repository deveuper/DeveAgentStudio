// OS-level window inventory for the Computer Use runtime. The controlled
// `desktop.*` actions only drive DeveAgent's own window; an agent that must work
// with a native app first needs to see which windows exist and bring one to the
// front. Windows uses a small user32 P/Invoke through PowerShell (no native
// dependency); other platforms report unavailable instead of pretending.

import { execFile } from "node:child_process"

export type DesktopWindow = {
  handle: string
  title: string
  pid: number
  bounds: { x: number; y: number; width: number; height: number }
  focused: boolean
}

const MAX_WINDOWS = 50
const TIMEOUT_MS = 8_000

export const WINDOW_LIST_SCRIPT = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DeveWindows {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint procId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$foreground = [DeveWindows]::GetForegroundWindow()
$items = New-Object System.Collections.ArrayList
$callback = {
  param($hWnd, $lParam)
  if (-not [DeveWindows]::IsWindowVisible($hWnd)) { return $true }
  $length = [DeveWindows]::GetWindowTextLength($hWnd)
  if ($length -le 0) { return $true }
  $builder = New-Object System.Text.StringBuilder ($length + 1)
  [void][DeveWindows]::GetWindowText($hWnd, $builder, $builder.Capacity)
  # $pid is a read-only automatic variable in PowerShell; use $procId.
  $procId = [uint32]0
  [void][DeveWindows]::GetWindowThreadProcessId($hWnd, [ref]$procId)
  $rect = New-Object DeveWindows+RECT
  [void][DeveWindows]::GetWindowRect($hWnd, [ref]$rect)
  [void]$items.Add([pscustomobject]@{
    handle = $hWnd.ToInt64().ToString()
    title = $builder.ToString()
    pid = [int]$procId
    x = $rect.Left
    y = $rect.Top
    width = $rect.Right - $rect.Left
    height = $rect.Bottom - $rect.Top
    focused = ($hWnd -eq $foreground)
  })
  return $true
}
[void][DeveWindows]::EnumWindows($callback, [IntPtr]::Zero)
$items | Select-Object -First ${MAX_WINDOWS} | ConvertTo-Json -Compress
`.trim()

/** Parse the PowerShell JSON inventory; tolerate a single-object payload. */
export function parseDesktopWindows(raw: string): DesktopWindow[] {
  const text = raw.trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as unknown
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.flatMap((item): DesktopWindow[] => {
      if (!item || typeof item !== "object") return []
      const value = item as Record<string, unknown>
      const handle = typeof value.handle === "string" ? value.handle : typeof value.handle === "number" ? String(value.handle) : ""
      const title = typeof value.title === "string" ? value.title.trim() : ""
      const pid = typeof value.pid === "number" && Number.isFinite(value.pid) ? Math.max(0, Math.floor(value.pid)) : 0
      if (!handle || !title) return []
      const number = (input: unknown) => (typeof input === "number" && Number.isFinite(input) ? Math.round(input) : 0)
      return [
        {
          handle,
          title: title.slice(0, 200),
          pid,
          bounds: { x: number(value.x), y: number(value.y), width: number(value.width), height: number(value.height) },
          focused: value.focused === true,
        },
      ]
    })
  } catch {
    return []
  }
}

/** Window handles are decimal Int64 strings; anything else is rejected. */
export function assertDesktopWindowHandle(value: unknown): string {
  const handle = typeof value === "number" ? String(Math.floor(value)) : typeof value === "string" ? value.trim() : ""
  if (!/^\d{1,20}$/.test(handle)) throw new Error("Window handle must be a decimal window id")
  return handle
}

export type WindowFilter = {
  /** Case-insensitive substring match on the window title. */
  title?: string
  /** Exact process id match. */
  pid?: number
}

/** Pure filter so matching rules are unit-testable without Windows. */
export function filterDesktopWindows(windows: DesktopWindow[], filter: WindowFilter | undefined): DesktopWindow[] {
  if (!filter) return windows
  const title = typeof filter.title === "string" ? filter.title.trim().toLowerCase() : ""
  const pid = typeof filter.pid === "number" && Number.isFinite(filter.pid) ? Math.floor(filter.pid) : undefined
  return windows.filter((item) => {
    if (title && !item.title.toLowerCase().includes(title)) return false
    if (pid !== undefined && item.pid !== pid) return false
    return true
  })
}

export async function listDesktopWindows(filter?: WindowFilter): Promise<{ available: boolean; reason?: string; windows: DesktopWindow[] }> {
  if (process.platform !== "win32") return { available: false, reason: "window inventory is only implemented on Windows", windows: [] }
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOW_LIST_SCRIPT],
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
  })
  return { available: true, windows: filterDesktopWindows(parseDesktopWindows(raw), filter) }
}

/** Pure conversion: window-relative point -> screen point (unit-tested). */
export function windowRelativeToScreen(rect: { x: number; y: number; width: number; height: number }, x: number, y: number) {
  return { x: Math.round(rect.x) + Math.round(x), y: Math.round(rect.y) + Math.round(y) }
}

export type FocusResult = {
  ok: boolean
  handle: string
  reason?: string
}

/**
 * Best-effort foreground switch. Windows denies focus changes to processes
 * without foreground rights (common in RDP/automation sessions), so the result
 * is verified after the call and refusal is reported honestly instead of
 * throwing — the agent can then fall back to coordinates and tell the user.
 */
export type WindowElement = {
  name: string
  role: string
  enabled: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

/** Parse the UIA element JSON; drop unusable entries and cap the count. */
export function parseWindowElements(raw: string, max: number): WindowElement[] {
  const text = raw.trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as unknown
    const list = Array.isArray(parsed) ? parsed : [parsed]
    const out: WindowElement[] = []
    for (const item of list) {
      if (!item || typeof item !== "object") continue
      const value = item as Record<string, unknown>
      const name = typeof value.name === "string" ? value.name.trim().slice(0, 200) : ""
      const role = typeof value.role === "string" ? value.role.replace(/^ControlType\./i, "").trim().slice(0, 60) : ""
      if (!name && !role) continue
      const number = (input: unknown) => (typeof input === "number" && Number.isFinite(input) ? Math.round(input) : 0)
      out.push({
        name,
        role,
        enabled: value.enabled !== false,
        bounds: { x: number(value.x), y: number(value.y), width: number(value.w), height: number(value.h) },
      })
      if (out.length >= max) break
    }
    return out
  } catch {
    return []
  }
}

const MAX_ELEMENTS = 200

export type ElementsResult = {
  ok: boolean
  handle: string
  reason?: string
  windowBounds?: { x: number; y: number; width: number; height: number }
  elements?: WindowElement[]
}

export async function listWindowElements(handle: string): Promise<ElementsResult> {
  if (process.platform !== "win32") return { ok: false, handle, reason: "element inventory is only implemented on Windows" }
  const safe = assertDesktopWindowHandle(handle)
  const script = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$target = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([int64]${safe}))
$wr = $target.Current.BoundingRectangle
$window = @{ x = [int]$wr.X; y = [int]$wr.Y; width = [int]$wr.Width; height = [int]$wr.Height }
$out = New-Object System.Collections.ArrayList
$all = $target.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($el in $all) {
  if ($out.Count -ge ${MAX_ELEMENTS}) { break }
  try {
    $c = $el.Current
    if ($c.IsOffscreen) { continue }
    $r = $c.BoundingRectangle
    if ($r.Width -le 1 -or $r.Height -le 1) { continue }
    [void]$out.Add([pscustomobject]@{
      name = $c.Name
      role = $c.ControlType.ProgrammaticName
      enabled = $c.IsEnabled
      x = [int]$r.X
      y = [int]$r.Y
      w = [int]$r.Width
      h = [int]$r.Height
    })
  } catch { continue }
}
@{ window = $window; elements = $out } | ConvertTo-Json -Compress -Depth 3
`.trim()
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: TIMEOUT_MS + 12_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
  })
  let windowBounds: { x: number; y: number; width: number; height: number } | undefined
  let elements: WindowElement[] = []
  try {
    const parsed = JSON.parse(raw.trim()) as { window?: { x?: number; y?: number; width?: number; height?: number }; elements?: unknown }
    if (parsed.window && typeof parsed.window === "object") {
      const number = (input: unknown) => (typeof input === "number" && Number.isFinite(input) ? Math.round(input) : 0)
      windowBounds = { x: number(parsed.window.x), y: number(parsed.window.y), width: number(parsed.window.width), height: number(parsed.window.height) }
    }
    elements = parseWindowElements(JSON.stringify(parsed.elements ?? []), MAX_ELEMENTS)
  } catch {
    elements = parseWindowElements(raw, MAX_ELEMENTS)
  }
  return { ok: true, handle: safe, windowBounds, elements }
}

export async function focusDesktopWindow(handle: string): Promise<FocusResult> {
  if (process.platform !== "win32") return { ok: false, handle, reason: "window focus is only implemented on Windows" }
  const safe = assertDesktopWindowHandle(handle)
  const script = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeveFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$handle = [IntPtr]::new([int64]${safe})
if (-not [DeveFocus]::IsWindow($handle)) { "gone"; exit 0 }
if ([DeveFocus]::GetForegroundWindow() -eq $handle) { "already-foreground"; exit 0 }
[void][DeveFocus]::ShowWindow($handle, 9)
# Attach to the foreground thread's input queue so SetForegroundWindow is allowed.
$foreThread = [DeveFocus]::GetWindowThreadProcessId([DeveFocus]::GetForegroundWindow(), [IntPtr]::Zero)
$thisThread = [DeveFocus]::GetCurrentThreadId()
$attached = $false
if ($foreThread -ne $thisThread -and $foreThread -ne 0) { $attached = [DeveFocus]::AttachThreadInput($thisThread, $foreThread, $true) }
[void][DeveFocus]::BringWindowToTop($handle)
$set = [DeveFocus]::SetForegroundWindow($handle)
if ($attached) { [void][DeveFocus]::AttachThreadInput($thisThread, $foreThread, $false) }
Start-Sleep -Milliseconds 80
if (-not $set -or [DeveFocus]::GetForegroundWindow() -ne $handle) { "denied"; exit 0 }
"ok"
`.trim()
  const outcome = await new Promise<string>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout.trim())
      },
    )
  })
  if (outcome === "ok" || outcome === "already-foreground") return { ok: true, handle: safe }
  if (outcome === "gone") return { ok: false, handle: safe, reason: "window no longer exists" }
  return { ok: false, handle: safe, reason: "Windows denied the foreground change (foreground lock); the window was restored but not activated" }
}

export async function getWindowRect(handle: string): Promise<{ ok: boolean; handle: string; reason?: string; rect?: { x: number; y: number; width: number; height: number } }> {
  if (process.platform !== "win32") return { ok: false, handle, reason: "window rect is only implemented on Windows" }
  const safe = assertDesktopWindowHandle(handle)
  const script = `
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeveRect {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$h = [IntPtr]::new([int64]${safe})
if (-not [DeveRect]::IsWindow($h)) { throw "window no longer exists" }
$r = New-Object DeveRect+RECT
[void][DeveRect]::GetWindowRect($h, [ref]$r)
@{ x = $r.Left; y = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top } | ConvertTo-Json -Compress
`.trim()
  const raw = await new Promise<string>((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
  const parsed = JSON.parse(raw.trim()) as { x?: number; y?: number; width?: number; height?: number }
  const number = (input: unknown) => (typeof input === "number" && Number.isFinite(input) ? Math.round(input) : 0)
  return { ok: true, handle: safe, rect: { x: number(parsed.x), y: number(parsed.y), width: number(parsed.width), height: number(parsed.height) } }
}

export async function clickScreen(x: number, y: number): Promise<{ ok: boolean; x: number; y: number }> {
  if (process.platform !== "win32") throw new Error("screen click is only implemented on Windows")
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < -40_000 || x > 40_000 || y < -40_000 || y > 40_000) {
    throw new Error("click coordinates are out of range")
  }
  const sx = Math.round(x)
  const sy = Math.round(y)
  const script = `
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeveClick {
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT {
    [FieldOffset(0)] public uint type;
    // 64-bit PowerShell: the input union starts at offset 8.
    [FieldOffset(8)] public MOUSEINPUT mi;
    [FieldOffset(8)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
"@
if (-not [DeveClick]::SetCursorPos(${sx}, ${sy})) { throw "SetCursorPos failed" }
$down = New-Object DeveClick+INPUT
$down.type = 0
$down.mi.dwFlags = 2
$up = New-Object DeveClick+INPUT
$up.type = 0
$up.mi.dwFlags = 4
$inputs = [DeveClick+INPUT[]]@($down, $up)
$sent = [DeveClick]::SendInput(2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][DeveClick+INPUT]))
if ($sent -ne 2) { throw "SendInput delivered $sent of 2 events" }
"ok"
`.trim()
  await new Promise<string>((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
  return { ok: true, x: sx, y: sy }
}

const MAX_TYPE_CHARS = 500

/** Pure plan for a Unicode type action (unit-tested): caps the text length. */
export function typeInputPlan(text: string): { chars: string[]; truncated: boolean } {
  const capped = typeof text === "string" ? text.slice(0, MAX_TYPE_CHARS) : ""
  const chars = [...capped].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0
    return code >= 32 || code === 10
  })
  return { chars, truncated: [...capped].length !== chars.length || (typeof text === "string" && text.length > MAX_TYPE_CHARS) }
}

const HOTKEY_VK: Record<string, number> = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, escape: 0x1b, space: 0x20,
  pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  delete: 0x2e, insert: 0x2d,
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48, i: 0x49, j: 0x4a, k: 0x4b, l: 0x4c, m: 0x4d,
  n: 0x4e, o: 0x4f, p: 0x50, q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58, y: 0x59, z: 0x5a,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  f13: 0x7c, f14: 0x7d, f15: 0x7e, f16: 0x7f,
  "0": 0x30, "1": 0x31, "2": 0x32, "3": 0x33, "4": 0x34, "5": 0x35, "6": 0x36, "7": 0x37, "8": 0x38, "9": 0x39,
}

/**
 * Pure hotkey combo parser (unit-tested): "ctrl+shift+s" -> VK sequence with
 * modifiers first, base last. Rejects unknown keys and duplicate modifiers.
 */
export function parseHotkeyCombo(combo: string): { vks: number[] } | { error: string } {
  if (typeof combo !== "string") return { error: "keys must be a string" }
  const parts = combo.split("+").map((part) => part.trim().toLowerCase()).filter(Boolean)
  if (parts.length === 0) return { error: "keys is empty" }
  if (parts.length > 5) return { error: "too many keys in the combo" }
  const modifiers = new Set<string>()
  let base: number | undefined
  for (const part of parts) {
    if (part === "ctrl" || part === "alt" || part === "shift" || part === "win") {
      if (modifiers.has(part)) return { error: `duplicate modifier ${part}` }
      modifiers.add(part)
      continue
    }
    if (base !== undefined) return { error: `only one base key is allowed (got ${part})` }
    const vk = HOTKEY_VK[part]
    if (vk === undefined) return { error: `unsupported key "${part.slice(0, 20)}"` }
    base = vk
  }
  const MODIFIER_VK: Record<string, number> = { ctrl: 0x11, alt: 0x12, shift: 0x10, win: 0x5b }
  const vks = [...modifiers].map((name) => MODIFIER_VK[name])
  if (base !== undefined) vks.push(base)
  return { vks }
}

export type InputResult = {
  ok: boolean
  reason?: string
  characters?: number
  truncated?: boolean
  keys?: string
  vks?: number[]
}

/** SendInput keyboard injection is refused by UIPI when the focused window has higher integrity. */
function uiPIHint(message: string): string {
  if (message.includes("SENDINPUT-FAILED") || message.includes("0 of") || message.includes("SendInput delivered")) {
    return "Windows refused keyboard injection (UIPI): the focused window runs at a higher integrity level than DeveAgent."
  }
  return message
}

function execErrorMessage(error: unknown): string {
  const err = error as { message?: unknown; stderr?: unknown }
  // execFile appends the PowerShell throw text to stderr; the raw message is
  // dominated by the echoed command, so prefer stderr when present.
  // execFile without an encoding option returns Buffers.
  const stderrRaw = typeof err?.stderr === "string" ? err.stderr : Buffer.isBuffer(err?.stderr) ? err.stderr.toString("utf8") : ""
  const stderr = stderrRaw.trim()
  const message = typeof err?.message === "string" ? err.message : String(error)
  return uiPIHint(stderr.slice(0, 300) || message.slice(0, 300))
}

export async function typeScreenText(text: string): Promise<InputResult> {
  if (process.platform !== "win32") return { ok: false, reason: "typing is only implemented on Windows" }
  const plan = typeInputPlan(text)
  if (plan.chars.length === 0) return { ok: false, reason: "nothing to type after filtering" }
  const events: { scan: number; flagsDown: number }[] = plan.chars.map((ch) => ({ scan: ch.codePointAt(0) ?? 0, flagsDown: 4 }))
  const script = `
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeveType {
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
}
"@
try {
  $inputs = New-Object 'DeveType+INPUT[]' ${events.length * 2}
  $i = 0
  foreach ($code in @(${events.map((event) => event.scan).join(",")})) {
    $inputs[$i].type = 0
    $inputs[$i].ki.wScan = [uint16]$code
    $inputs[$i].ki.dwFlags = 4
    $i++
    $inputs[$i].type = 0
    $inputs[$i].ki.wScan = [uint16]$code
    $inputs[$i].ki.dwFlags = 6
    $i++
  }
  $sent = [DeveType]::SendInput(${events.length * 2}, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][DeveType+INPUT]))
  if ($sent -ne ${events.length * 2}) { "SENDINPUT-FAILED"; exit 0 }
  "ok"
} catch { "SENDINPUT-FAILED"; exit 0 }
`.trim()
  let outcome: string
  try {
    outcome = await new Promise<string>((resolve, reject) => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: TIMEOUT_MS + (events.length > 100 ? 10_000 : 0), windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderrText: typeof stderr === "string" ? stderr : "" }))
        else resolve(stdout)
      })
    })
  } catch (error) {
    return { ok: false, reason: execErrorMessage(error), characters: plan.chars.length, truncated: plan.truncated }
  }
  if (outcome.trim() !== "ok") return { ok: false, reason: uiPIHint(outcome), characters: plan.chars.length, truncated: plan.truncated }
  return { ok: true, characters: plan.chars.length, truncated: plan.truncated }
}

export async function hotkeyScreen(combo: string): Promise<InputResult> {
  if (process.platform !== "win32") return { ok: false, reason: "hotkeys are only implemented on Windows" }
  const parsed = parseHotkeyCombo(combo)
  if ("error" in parsed) return { ok: false, reason: parsed.error }
  if (parsed.vks.length === 0) return { ok: false, reason: "nothing to press" }
  const ordered = parsed.vks.join(",")
  const script = `
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeveHotkey {
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
}
"@
try {
  $codes = @(${ordered})
  $inputs = New-Object 'DeveHotkey+INPUT[]' ($codes.Length * 2)
  $i = 0
  foreach ($code in $codes) {
    $inputs[$i].type = 0
    $inputs[$i].ki.wVk = [uint16]$code
    $inputs[$i].ki.dwFlags = 0
    $i++
  }
  for ($j = $codes.Length - 1; $j -ge 0; $j--) {
    $inputs[$i].type = 0
    $inputs[$i].ki.wVk = [uint16]$codes[$j]
    $inputs[$i].ki.dwFlags = 2
    $i++
  }
  $sent = [DeveHotkey]::SendInput($inputs.Length, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][DeveHotkey+INPUT]))
  if ($sent -ne $inputs.Length) { "SENDINPUT-FAILED"; exit 0 }
  "ok"
} catch { "SENDINPUT-FAILED"; exit 0 }
`.trim()
  let outcome: string
  try {
    outcome = await new Promise<string>((resolve, reject) => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderrText: typeof stderr === "string" ? stderr : "" }))
        else resolve(stdout)
      })
    })
  } catch (error) {
    return { ok: false, reason: execErrorMessage(error), keys: combo, vks: parsed.vks }
  }
  if (outcome.trim() !== "ok") return { ok: false, reason: uiPIHint(outcome), keys: combo, vks: parsed.vks }
  return { ok: true, keys: combo, vks: parsed.vks }
}
