'use strict';

// Moves files to the Windows Recycle Bin (used only when "remove the archives after unpacking"
// is on). Runs Windows PowerShell with SHFileOperation(FO_DELETE, FOF_ALLOWUNDO).
//
// The shell's "send to the Recycle Bin" DELETES PERMANENTLY, without asking, where the bin cannot
// take the file. So every such case is refused first (the archives are kept and reported):
//  - a network path, or a drive that is not Fixed (removable drives have no bin)
//  - a SUBST drive letter: it reports Fixed but has no volume of its own; the shell deleted the
//    file outright there (reproduced, review 2026-10-18)
//  - a path through a junction, a symlink or a mounted folder: the file lives on another volume
//    than the one whose bin is checked
//  - the "do not move deleted files to the Recycle Bin" policy (NoRecycleFiles), or the bin
//    switched off for that drive (NukeOnDelete)
//  - a file larger than the drive's bin
// FOF_WANTNUKEWARNING stays as a last guard (Windows asks instead of deleting silently). Each file
// is checked afterwards; the result says which ones are gone.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = String.raw`
param([string]$ListFile, [string]$OutFile)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FuldcRecycle {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SHFILEOPSTRUCT {
    public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags;
    public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
  public static int Recycle(string file) {
    var op = new SHFILEOPSTRUCT();
    op.wFunc = 3; // FO_DELETE
    op.pFrom = file + "\0\0";
    // FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING
    op.fFlags = (ushort)(0x40 | 0x10 | 0x4 | 0x400 | 0x4000);
    return SHFileOperation(ref op);
  }
}
'@
$paths = Get-Content -LiteralPath $ListFile -Raw -Encoding UTF8 | ConvertFrom-Json
# "Do not move deleted files to the Recycle Bin" (group policy): every move would be a delete
$noRecycle = $false
foreach ($hive in @('HKCU:', 'HKLM:')) {
  $pol = Get-ItemProperty -LiteralPath ($hive + '\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer') -ErrorAction SilentlyContinue
  if ($pol -and $null -ne $pol.NoRecycleFiles -and [int]$pol.NoRecycleFiles -ne 0) { $noRecycle = $true }
}
$volumes = @{}
$out = @()
foreach ($p in $paths) {
  try {
    $p = [string]$p
    if ($p.StartsWith('\\') -or -not ($p -match '^[A-Za-z]:\\.+')) { throw 'network path' }
    if ($noRecycle) { throw 'a policy on this computer switches the Recycle Bin off' }
    $root = [System.IO.Path]::GetPathRoot($p)
    $drive = New-Object System.IO.DriveInfo($root)
    if ($drive.DriveType -ne [System.IO.DriveType]::Fixed) { throw 'no Recycle Bin on this drive' }
    # Through a junction, a link or a mounted folder the file is on another volume
    $walk = [System.IO.Path]::GetDirectoryName($p)
    while ($walk -and $walk.Length -gt 3) {
      if (((Get-Item -LiteralPath $walk -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reached through a link or a mounted folder' }
      $walk = [System.IO.Path]::GetDirectoryName($walk)
    }
    $item = Get-Item -LiteralPath $p -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'a link, not a plain file' }
    if ($item.PSIsContainer) { throw 'a folder, not a file' }
    $letter = $root.Substring(0, 2).ToUpper()
    if (-not $volumes.ContainsKey($letter)) {
      $cap = $null; $nuke = 0
      $vol = Get-CimInstance Win32_Volume -Filter ("DriveLetter='" + $letter + "'")
      if (-not $vol) { $nuke = 2 }
      if ($vol) {
        $guid = ([string]$vol.DeviceID) -replace '^.*(\{[^}]+\}).*$', '$1'
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\' + $guid
        if (Test-Path -LiteralPath $key) {
          $props = Get-ItemProperty -LiteralPath $key
          if ($null -ne $props.NukeOnDelete) { $nuke = [int]$props.NukeOnDelete }
          if ($null -ne $props.MaxCapacity) { $cap = [double]$props.MaxCapacity * 1MB }
        }
      }
      if ($null -eq $cap) { $cap = [double]$drive.TotalSize * 0.05 }
      $volumes[$letter] = @{ cap = $cap; nuke = $nuke }
    }
    $v = $volumes[$letter]
    if ($v.nuke -eq 2) { throw 'this drive letter is not a volume of its own (SUBST?): no Recycle Bin to trust' }
    if ($v.nuke -ne 0) { throw 'the Recycle Bin is switched off on this drive' }
    if ([double]$item.Length -gt $v.cap * 0.9) { throw 'larger than the Recycle Bin of this drive' }
    $code = [FuldcRecycle]::Recycle($p)
    if (Test-Path -LiteralPath $p) { $out += @{ path = $p; ok = $false; why = "not removed ($code)" } } else { $out += @{ path = $p; ok = $true } }
  } catch {
    $why = [string]$_.Exception.Message
    if (-not $why) { $why = $_.Exception.GetType().Name }
    $out += @{ path = $p; ok = $false; why = $why }
  }
}
ConvertTo-Json -InputObject @($out) -Compress | Set-Content -LiteralPath $OutFile -Encoding UTF8
`;

const TIMEOUT_MS = 15 * 60 * 1000; // a "delete for good?" question may wait for the user

// paths -> Promise<[{ path, ok, why }]>
const recycleFiles = (paths, workDir = os.tmpdir()) => new Promise((resolve) => {
  if (process.platform !== 'win32') {
    resolve(paths.map((p) => ({ path: p, ok: false, why: 'only on Windows' })));
    return;
  }

  const stamp = `${process.pid}-${Date.now()}`;
  const script = path.join(workDir, `recycle-${stamp}.ps1`);
  const list = path.join(workDir, `recycle-${stamp}.json`);
  const out = path.join(workDir, `recycle-${stamp}.out.json`);
  const cleanup = () => [ script, list, out ].forEach((f) => fs.rm(f, { force: true }, () => {}));
  try {
    fs.writeFileSync(script, SCRIPT);
    fs.writeFileSync(list, JSON.stringify(paths));
  } catch (error) {
    cleanup();
    resolve(paths.map((p) => ({ path: p, ok: false, why: 'could not start' })));
    return;
  }

  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFile(exe, [ '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, list, out ], { timeout: TIMEOUT_MS, windowsHide: true }, () => {
    let result = null;
    try {
      const text = fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(text);
      result = Array.isArray(parsed) ? parsed : [ parsed ];
    } catch (error) {
      result = null;
    }

    cleanup();
    if (!result) {
      // Unknown outcome: say so per file, from what is still on disk
      resolve(paths.map((p) => ({ path: p, ok: !fs.existsSync(p), why: 'no answer from PowerShell' })));
      return;
    }

    resolve(result.map((r) => ({ path: r.path, ok: !!r.ok, why: r.why || '' })));
  });
});

module.exports = { recycleFiles, SCRIPT };
