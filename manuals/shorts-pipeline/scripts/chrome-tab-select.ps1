# Activate a background Chrome tab without keys or mouse (MSAA accDoDefaultAction).
# Used by shorts-pipeline P6: set document.title to a marker first, then
#   chrome-tab-select.ps1                  list windows, tab groups, tabs
#   chrome-tab-select.ps1 -Tab WBREEL      select the tab whose name starts with WBREEL
# -Raise pins the window topmost and unpins at once (does NOT keep it on top).
# Keep ASCII only (Windows PowerShell 5 reads BOM-less .ps1 as ANSI).
param([string]$Tab = "", [switch]$Raise)

$ErrorActionPreference = "Stop"
Add-Type -ReferencedAssemblies Accessibility @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Accessibility;
public class M {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr h, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  [DllImport("oleacc.dll")] public static extern int AccessibleChildren(IAccessible p, int start, int count, [Out] object[] kids, out int got);
  public static List<IntPtr> Chromes() {
    var l = new List<IntPtr>();
    EnumWindows((h, p) => { var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      if (c.ToString() == "Chrome_WidgetWin_1" && IsWindowVisible(h)) { var t = new StringBuilder(1024); GetWindowTextW(h, t, 1024); if (t.Length > 0) l.Add(h); } return true; }, IntPtr.Zero);
    return l;
  }
  public static string Title(IntPtr h) { var t = new StringBuilder(1024); GetWindowTextW(h, t, 1024); return t.ToString(); }
  public static IAccessible Root(IntPtr h) { var g = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); object o; AccessibleObjectFromWindow(h, 0xFFFFFFFC, ref g, out o); return (IAccessible)o; }
  public static List<object[]> Scan(IntPtr h) { var l = new List<object[]>(); Walk(Root(h), 0, l); return l; }
  public static void Act(object o) { ((IAccessible)o).accDoDefaultAction(0); }
  public static void Walk(IAccessible a, int depth, List<object[]> outl) {
    if (depth > 14) return;
    int n = 0; try { n = a.accChildCount; } catch { return; }
    if (n <= 0 || n > 400) return;
    var kids = new object[n]; int got;
    if (AccessibleChildren(a, 0, n, kids, out got) != 0) return;
    for (int i = 0; i < got; i++) {
      var k = kids[i] as IAccessible;
      if (k == null) continue;
      int role = 0; string name = ""; int state = 0;
      try { role = Convert.ToInt32(k.get_accRole(0)); } catch {}
      try { name = k.get_accName(0) ?? ""; } catch {}
      try { state = Convert.ToInt32(k.get_accState(0)); } catch {}
      if (role == 37 || role == 60) outl.Add(new object[] { role, name, state, k });
      if (role == 15) continue; // document: skip page content
      Walk(k, depth + 1, outl);
    }
  }
}
"@

foreach ($h in [M]::Chromes()) {
  $title = [M]::Title($h)
  $items = New-Object 'System.Collections.Generic.List[object[]]'
  try { $items = [M]::Scan($h) } catch { continue }
  $tabs = @($items | Where-Object { $_[0] -eq 37 })
  if ($tabs.Count -eq 0) { continue }
  Write-Output ("WINDOW " + $h + " | " + $title)
  foreach ($it in $items) {
    $sel = if (($it[2] -band 2) -ne 0) { " [selected]" } else { "" }
    Write-Output ("  role=" + $it[0] + " state=0x" + ('{0:x}' -f $it[2]) + $sel + " | " + $it[1])
  }
  if ($Tab -ne "") {
    $mine = $tabs | Where-Object { $_[1] -like "$Tab*" } | Select-Object -First 1
    if ($mine) {
      [M]::Act($mine[3])
      Write-Output ("SELECTED " + $mine[1])
      if ($Raise) {
        # HWND_TOPMOST then NOTOPMOST, NOSIZE|NOMOVE|NOACTIVATE|SHOWWINDOW
        [void][M]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0053)
        [void][M]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0053)
        Write-Output "RAISED"
      }
      exit 0
    }
  }
}
if ($Tab -ne "") { Write-Output "TAB_NOT_FOUND"; exit 3 }
