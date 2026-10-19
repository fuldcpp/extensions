'use strict';

// Moves files and folders to the Windows Recycle Bin. Never deletes.
//
// Node has no Recycle Bin call, so this runs Windows PowerShell with a FIXED script
// (-EncodedCommand). The paths never become part of any command text: they travel as JSON in an
// environment variable, read by the script with ConvertFrom-Json.
//
// The shell's own "send to Recycle Bin" deletes PERMANENTLY, without asking, when the bin cannot
// take the item: on a network or removable drive, on a drive whose bin is switched off, or when the
// item is larger than that drive's bin. So each of those is checked first and refused, and an item
// is only reported as recycled once it is gone from its place AND found in the bin.

const { execFile } = require('child_process');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$req = $env:WC_RECYCLE_REQUEST | ConvertFrom-Json
Add-Type -AssemblyName Microsoft.VisualBasic
$results = @()
$volumes = @{}
# "Do not move deleted files to the Recycle Bin" (group policy): every move would be a delete
$noRecycle = $false
foreach ($hive in @('HKCU:', 'HKLM:')) {
  $pol = Get-ItemProperty -LiteralPath ($hive + '\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer') -ErrorAction SilentlyContinue
  if ($pol -and $null -ne $pol.NoRecycleFiles -and [int]$pol.NoRecycleFiles -ne 0) { $noRecycle = $true }
}
foreach ($one in @($req.items)) {
  $p = [string]$one.path
  $r = [ordered]@{ path = $p; ok = $false; reason = ''; in_bin = $false }
  try {
    if ($p.Length -lt 4 -or $p.StartsWith('\\') -or -not ($p -match '^[A-Za-z]:\\.+')) { throw 'not a local path' }
    $isDir = Test-Path -LiteralPath $p -PathType Container
    $isFile = Test-Path -LiteralPath $p -PathType Leaf
    if (-not ($isDir -or $isFile)) { throw 'not found' }
    if ([bool]$one.is_dir -ne $isDir) { throw 'changed from file to folder or back' }
    if ($noRecycle) { throw 'a policy on this computer switches the recycle bin off' }
    $drive = [System.IO.Path]::GetPathRoot($p)
    $di = New-Object System.IO.DriveInfo $drive
    if ([string]$di.DriveType -ne 'Fixed') { throw ('no recycle bin on this kind of drive (' + $di.DriveType + ')') }
    # Reached through a junction, a link or a mounted folder, the item lives on another volume than
    # the one checked below, whose bin may not take it
    $walk = [System.IO.Path]::GetDirectoryName($p.TrimEnd('\'))
    while ($walk -and $walk.Length -gt 3) {
      if (((Get-Item -LiteralPath $walk -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reached through a link or a mounted folder' }
      $walk = [System.IO.Path]::GetDirectoryName($walk)
    }
    if (((Get-Item -LiteralPath $p -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'a link, not a plain file or folder' }
    $letter = $drive.Substring(0, 2)
    if (-not $volumes.ContainsKey($letter)) {
      $cap = $null; $nuke = 0
      $vol = Get-CimInstance Win32_Volume -Filter ("DriveLetter='" + $letter + "'")
      # No volume of its own (a SUBST letter): the shell DELETED such a file outright when tried
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
      if ($null -eq $cap) { $cap = [double]$di.TotalSize * 0.05 }
      $volumes[$letter] = @{ cap = $cap; nuke = $nuke }
    }
    $v = $volumes[$letter]
    if ($v.nuke -eq 2) { throw 'this drive letter is not a volume of its own (SUBST?): no recycle bin to trust' }
    if ($v.nuke -ne 0) { throw 'the recycle bin is switched off on this drive' }
    if ([double]$one.size -gt $v.cap * 0.9) { throw 'larger than the recycle bin of this drive' }
    # Something open by a player or the uploader would fail half way; refused before starting
    $files = if ($isDir) { @(Get-ChildItem -LiteralPath $p -Recurse -File -Force | Select-Object -First 500) } else { @(Get-Item -LiteralPath $p -Force) }
    foreach ($f in $files) {
      try { $h = [System.IO.File]::Open($f.FullName, 'Open', 'Read', 'None'); $h.Close() } catch { throw 'in use' }
    }
    if ($isDir) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin', 'DoNothing')
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin', 'DoNothing')
    }
    if (Test-Path -LiteralPath $p) { throw 'still in place after the move' }
    $r.ok = $true
    $trimmed = $p.TrimEnd('\')
    $parent = [System.IO.Path]::GetDirectoryName($trimmed)
    $leaf = [System.IO.Path]::GetFileName($trimmed)
    $bin = (New-Object -ComObject Shell.Application).Namespace(10)
    foreach ($it in $bin.Items()) {
      $from = [string]$it.ExtendedProperty('System.Recycle.DeletedFrom')
      if ($from.TrimEnd('\') -ieq $parent.TrimEnd('\')) {
        $nm = [string]$bin.GetDetailsOf($it, 0)
        if ($nm -ieq $leaf -or ($nm.Length -gt 0 -and $leaf.Length -gt $nm.Length -and $leaf.StartsWith($nm, [StringComparison]::OrdinalIgnoreCase) -and $leaf[$nm.Length] -eq '.')) { $r.in_bin = $true; break }
      }
    }
  } catch {
    $r.reason = [string]$_.Exception.Message
    if (-not $r.reason) { $r.reason = [string]$_ }
  }
  $results += [pscustomobject]$r
}
ConvertTo-Json -InputObject @($results) -Compress -Depth 3
`;

const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

// items: [{ path, is_dir, size }] -> [{ path, ok, reason, in_bin }] in the same order
const createRecycler = ({ execFileImpl = execFile, timeoutMs = 10 * 60 * 1000 } = {}) => {
  const recycle = (items) => new Promise((resolve, reject) => {
    if (process.platform !== 'win32' && execFileImpl === execFile) {
      reject(new Error('The Recycle Bin is only available on Windows'));
      return;
    }

    execFileImpl('powershell.exe', [ '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED ], {
      env: { ...process.env, WC_RECYCLE_REQUEST: JSON.stringify({ items }) },
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(new Error(`PowerShell failed: ${error.killed ? 'timed out' : (error.code || error.message)}`));
        return;
      }

      try {
        const text = String(stdout || '').replace(/^﻿/, '').trim();
        const parsed = JSON.parse(text);
        const results = Array.isArray(parsed) ? parsed : [ parsed ];
        if (results.length !== items.length) throw new Error('count');
        resolve(results);
      } catch (e) {
        reject(new Error('PowerShell answered something unreadable'));
      }
    });
  });

  return { recycle };
};

module.exports = { createRecycler, SCRIPT };
