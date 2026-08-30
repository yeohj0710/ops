# Bring one Chrome window to the front. Used by P6 before an Instagram video upload.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File chrome-front.ps1 -Match "n8n"
#   powershell -NoProfile -ExecutionPolicy Bypass -File chrome-front.ps1        # only window, if there is exactly one
#
# Why this exists. A minimized Chrome window makes the tab visibilityState "hidden"
# and Chrome stops decoding video in it, so the Instagram uploader sits forever on
# the drop screen with no error. Restoring the window fixes it.
#
# Keep this file ASCII only. Windows PowerShell 5 reads a BOM-less .ps1 as ANSI and
# mangles non-ASCII literals, which is why window titles are matched, never written.
#
# Pick ONE window. Restoring every Chrome window puts the last one in front instead.

param([string]$Match = "")

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  // CharSet.Unicode is required. Without it the StringBuilder marshals as ANSI while the
  // W function writes UTF-16, so every title comes back as its first letter ("C" for Chrome).
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@

$found = New-Object System.Collections.ArrayList

$cb = [W+EnumWindowsProc]{
  param($h, $p)
  $cls = New-Object System.Text.StringBuilder 256
  [void][W]::GetClassNameW($h, $cls, 256)
  if ($cls.ToString() -eq "Chrome_WidgetWin_1" -and [W]::IsWindowVisible($h)) {
    $t = New-Object System.Text.StringBuilder 1024
    [void][W]::GetWindowTextW($h, $t, 1024)
    $title = $t.ToString()
    if ($title -ne "") {
      [void]$found.Add([pscustomobject]@{ Handle = $h; Title = $title; Minimized = [W]::IsIconic($h) })
    }
  }
  return $true
}
[void][W]::EnumWindows($cb, [IntPtr]::Zero)

if ($found.Count -eq 0) { Write-Output "NO_CHROME_WINDOW"; exit 2 }

$target = $null
if ($Match -ne "") {
  $target = $found | Where-Object { $_.Title -like "*$Match*" } | Select-Object -First 1
  if (-not $target) {
    Write-Output "NO_MATCH"
    $found | ForEach-Object { Write-Output ("  candidate: " + $_.Title) }
    exit 3
  }
} elseif ($found.Count -eq 1) {
  $target = $found[0]
} else {
  Write-Output "AMBIGUOUS"
  $found | ForEach-Object { Write-Output ("  candidate: " + $_.Title) }
  exit 3
}

# 9 = SW_RESTORE. Restore first, then raise; a minimized window ignores the raise.
[void][W]::ShowWindow($target.Handle, 9)
Start-Sleep -Milliseconds 400
$raised = [W]::SetForegroundWindow($target.Handle)

Write-Output ("HANDLE=" + $target.Handle)
Write-Output ("WAS_MINIMIZED=" + $target.Minimized)
Write-Output ("RAISED=" + $raised)
Write-Output ("TITLE=" + $target.Title)
Write-Output ""
Write-Output "Now check the page: window.outerWidth must not be 0 and visibilityState must be visible."
