# Rebuilds the fixture archives. Needs Rar.exe 6.x (the last version that writes RAR4: -ma4) and
# 7-Zip. Pass their paths. The fixtures are committed; this only documents how they were made.
param(
  [Parameter(Mandatory)] [string] $Rar6,
  [string] $Rar7 = $Rar6,
  [string] $SevenZip = 'C:\Program Files\7-Zip\7z.exe'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$src = Join-Path $root '_src'
Remove-Item -Recurse -Force $src -ErrorAction SilentlyContinue
New-Item -ItemType Directory $src | Out-Null
node (Join-Path $root 'payload.js') $src
Set-Location $src

function Fresh($name) {
  $d = Join-Path $root $name
  Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
  New-Item -ItemType Directory $d | Out-Null
  return $d
}

function Sfv($dir) {
  # CRC32 of each volume, the way scene SFV files list them
  $lines = @('; made by make-fixtures.ps1')
  Get-ChildItem $dir -File | Where-Object { $_.Extension -ne '.sfv' } | Sort-Object Name | ForEach-Object {
    $crc = (& $SevenZip h -scrcCRC32 $_.FullName | Select-String -Pattern 'CRC32  for data:\s+([0-9A-F]{8})').Matches[0].Groups[1].Value
    $lines += "$($_.Name) $crc"
  }
  Set-Content -Path (Join-Path $dir 'rel.sfv') -Value $lines -Encoding ascii
}

# RAR4, old volume names (.rar .r00 .r01), compressed, with an nfo and a subtitle
$d = Fresh 'rar4'
& $Rar6 a -idq -ep -ma4 -m3 -v20k -vn "$d\rel.rar" movie.mkv movie.nfo movie.srt
Sfv $d
# RAR5 .partN.rar, compressed
$d = Fresh 'rar5'
& $Rar7 a -idq -ep -ma5 -m3 -v20k "$d\rel.rar" movie.mkv movie.srt
# RAR5 stored: the media server already plays it
$d = Fresh 'rar5stored'
& $Rar7 a -idq -ep -ma5 -m0 -v100k "$d\rel.rar" movie.mkv
# Encrypted file data
$d = Fresh 'encrypted'
& $Rar7 a -idq -ep -ma5 -m3 -psecret "$d\rel.rar" movie.mkv
# Encrypted headers (names hidden too)
$d = Fresh 'encheaders'
& $Rar7 a -idq -ep -ma5 -m3 -hpsecret "$d\rel.rar" movie.mkv
# A volume missing (rel.r01 taken out after the SFV was written)
$d = Fresh 'missing'
& $Rar6 a -idq -ep -ma4 -m3 -v20k -vn "$d\rel.rar" movie.mkv
Sfv $d
Remove-Item "$d\rel.r01"
# ZIP and 7z
$d = Fresh 'zip'
& $SevenZip a -bd "$d\rel.zip" movie.mkv movie.nfo | Out-Null
$d = Fresh 'sevenzip'
& $SevenZip a -bd "$d\rel.7z" movie.mkv | Out-Null
# Old scene: zips each holding one RAR volume
$d = Fresh 'nested'
$tmp = Join-Path $src 'n'
New-Item -ItemType Directory $tmp | Out-Null
& $Rar6 a -idq -ep -ma4 -m3 -v25k -vn "$tmp\inner.rar" movie.mkv
& $SevenZip a -bd "$d\disk1.zip" "$tmp\inner.rar" | Out-Null
& $SevenZip a -bd "$d\disk2.zip" "$tmp\inner.r00" | Out-Null
& $SevenZip a -bd "$d\disk3.zip" "$tmp\inner.r01" | Out-Null
Set-Location $root
Remove-Item -Recurse -Force $src
Get-ChildItem -Recurse $root -File | Where-Object { $_.Extension -notin '.js', '.ps1' } | Select-Object @{n='Name';e={$_.FullName.Substring($root.Length + 1)}}, Length
