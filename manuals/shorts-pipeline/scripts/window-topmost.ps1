# Lift one Chrome window above the others WITHOUT stealing focus.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File window-topmost.ps1 -Match "Instagram"
#   powershell -NoProfile -ExecutionPolicy Bypass -File window-topmost.ps1 -Match "Instagram" -Off
#
# Why this exists. A Chrome tab that is fully covered by another window reports
# visibilityState "hidden" and Chrome stops decoding video in it, so the Instagram
# uploader sits on the drop screen forever with no error. SetForegroundWindow does
# not help: it returns True and the window still does not come up when another
# process owns the foreground. What does work is uncovering the window without
# touching focus, with HWND_TOPMOST + SWP_NOACTIVATE.
#
# Use this on a popup this agent opened. Do not pin a window the user is working in;
# run with -Off to release the pin as soon as the upload is done.
#
# Keep this file ASCII only. Windows PowerShell 5 reads a BOM-less .ps1 as ANSI and
# mangles non-ASCII literals, which is why window titles are matched, never written.

param([string]$Match = "", [switch]$Off)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WT {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  // CharSet.Unicode is required. Without it the StringBuilder marshals as ANSI while the
  // W function writes UTF-16, so every title comes back as its first letter.
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@

$found = New-Object System.Collections.ArrayList

$cb = [WT+EnumWindowsProc]{
  param($h, $p)
  $cls = New-Object System.Text.StringBuilder 256
  [void][WT]::GetClassNameW($h, $cls, 256)
  if ($cls.ToString() -eq "Chrome_WidgetWin_1" -and [WT]::IsWindowVisible($h)) {
    $t = New-Object System.Text.StringBuilder 1024
    [void][WT]::GetWindowTextW($h, $t, 1024)
    if ($t.ToString() -ne "") {
      [void]$found.Add([pscustomobject]@{ Handle = $h; Title = $t.ToString() })
    }
  }
  return $true
}
[void][WT]::EnumWindows($cb, [IntPtr]::Zero)

if ($found.Count -eq 0) { Write-Output "NO_CHROME_WINDOW"; exit 2 }

$target = $null
if ($Match -ne "") {
  $target = $found | Where-Object { $_.Title -like "*$Match*" } | Select-Object -First 1
} elseif ($found.Count -eq 1) {
  $target = $found[0]
}

if (-not $target) {
  if ($Match -eq "") { Write-Output "AMBIGUOUS" } else { Write-Output "NO_MATCH" }
  $found | ForEach-Object { Write-Output ("  candidate: " + $_.Title) }
  exit 3
}

# HWND_TOPMOST = -1, HWND_NOTOPMOST = -2
# SWP_NOSIZE(0x0001) | SWP_NOMOVE(0x0002) | SWP_NOACTIVATE(0x0010) | SWP_SHOWWINDOW(0x0040)
$after = if ($Off) { [IntPtr](-2) } else { [IntPtr](-1) }
$flags = 0x0001 -bor 0x0002 -bor 0x0010 -bor 0x0040
$ok = [WT]::SetWindowPos($target.Handle, $after, 0, 0, 0, 0, $flags)

Write-Output ("HANDLE=" + $target.Handle)
Write-Output ("TITLE=" + $target.Title)
Write-Output ("TOPMOST=" + (-not $Off))
Write-Output ("OK=" + $ok)
