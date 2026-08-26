# Refreshes the packages mirrored from npm (npm-mirror.txt) to their latest published
# version. Reports what changed and stops there; nothing is written without -Apply, so the
# person who later signs the catalog has actually looked at what they are signing.
#
#   .\scripts\sync-npm.ps1                 # report only, every mirrored package
#   .\scripts\sync-npm.ps1 -Name airdcpp-share-monitor -Apply
#
# The tarball is verified against the shasum npm publishes for it before it is kept, and
# the catalog itself is regenerated separately (build-catalog.ps1) from the stored file.

[CmdletBinding()]
param(
    [string[]] $Name,
    [switch] $Apply,
    [string] $Registry = 'https://registry.npmjs.org/'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'inspect-tarball.ps1')

$root = Split-Path -Parent $PSScriptRoot
$packagesDir = Join-Path $root 'packages'

if (-not $Name) {
    $Name = @(Get-Content (Join-Path $root 'npm-mirror.txt') | Where-Object { $_ -and $_ -notmatch '^\s*#' } | ForEach-Object { $_.Trim() })
}

function Get-LocalTarball([string] $PackageName) {
    $dir = Join-Path $packagesDir $PackageName
    if (-not (Test-Path $dir)) { return $null }
    $files = @(Get-ChildItem -Path $dir -File | Where-Object { $_.Extension -eq '.tgz' })
    if ($files.Count -gt 1) { throw "Expected at most one .tgz in $dir, found $($files.Count)" }
    if ($files.Count -eq 0) { return $null }
    return $files[0]
}

function Show-Delta($OldInfo, $NewInfo) {
    Write-Output "  version: $(if ($OldInfo) { $OldInfo.version } else { '(none)' }) -> $($NewInfo.version)"
    if ($OldInfo) {
        foreach ($field in 'description', 'author', 'license', 'main', 'minApiFeatureLevel') {
            if ("$($OldInfo[$field])" -ne "$($NewInfo[$field])") {
                Write-Output "  ${field}: '$($OldInfo[$field])' -> '$($NewInfo[$field])'"
            }
        }
        $added = @($NewInfo.files | Where-Object { $OldInfo.files -notcontains $_ })
        $removed = @($OldInfo.files | Where-Object { $NewInfo.files -notcontains $_ })
        if ($added) { Write-Output "  files added:   $($added -join ', ')" }
        if ($removed) { Write-Output "  files removed: $($removed -join ', ')" }
    } else {
        Write-Output "  files: $($NewInfo.files -join ', ')"
    }
}

$changed = 0
foreach ($pkgName in $Name) {
    $packument = Invoke-RestMethod -UseBasicParsing -Uri ($Registry + $pkgName)
    $latest = $packument.'dist-tags'.latest
    $release = $packument.versions.$latest

    $local = Get-LocalTarball $pkgName
    $localVersion = if ($local) { $local.Name -replace "^$([regex]::Escape($pkgName))-", '' -replace '\.tgz$', '' } else { $null }
    if ($localVersion -eq $latest) {
        Write-Output "$pkgName $latest is up to date"
        continue
    }

    Write-Output "$pkgName $latest published $($packument.time.$latest)"

    $temp = Join-Path ([IO.Path]::GetTempPath()) "$pkgName-$latest.tgz"
    Invoke-WebRequest -UseBasicParsing -Uri $release.dist.tarball -OutFile $temp
    $sha1 = (Get-FileHash -Path $temp -Algorithm SHA1).Hash.ToLowerInvariant()
    if ($sha1 -ne $release.dist.shasum) {
        Remove-Item $temp -Force
        throw "$pkgName $latest`: downloaded tarball hash $sha1 does not match the registry's $($release.dist.shasum)"
    }

    # Validated the same way build-catalog.ps1 will validate it, so a package the client
    # would refuse never makes it into the tree.
    $newInfo = Get-ExtensionPackageInfo -Path $temp
    $oldInfo = if ($local) { Get-ExtensionPackageInfo -Path $local.FullName } else { $null }
    Show-Delta $oldInfo $newInfo
    $changed++

    if (-not $Apply) {
        Remove-Item $temp -Force
        continue
    }

    $dir = Join-Path $packagesDir $pkgName
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    if ($local) { Remove-Item $local.FullName -Force }
    Move-Item $temp (Join-Path $dir "$pkgName-$latest.tgz")

    $repository = ''
    if ($release.PSObject.Properties.Name -contains 'repository' -and $release.repository) {
        $repository = if ($release.repository -is [string]) { $release.repository } else { [string] $release.repository.url }
        $repository = $repository -replace '^git\+', '' -replace '\.git$', ''
    }
    $homepage = if ($release.PSObject.Properties.Name -contains 'homepage') { [string] $release.homepage } else { '' }

    $meta = [ordered]@{
        publisher  = [string] $release._npmUser.name
        homepage   = $homepage
        repository = $repository
        date       = [string] $packument.time.$latest
        source     = [string] $release.dist.tarball
        upstream   = 'npm'
    }
    $json = ($meta | ConvertTo-Json) -replace "`r`n", "`n"
    [IO.File]::WriteAllText((Join-Path $dir 'meta.json'), $json + "`n", (New-Object Text.UTF8Encoding $false))
    Write-Output "  stored packages\$pkgName\$pkgName-$latest.tgz"
}

if ($changed -and -not $Apply) {
    Write-Output ""
    Write-Output "$changed package(s) have a newer version. Re-run with -Apply to store them, then build-catalog.ps1."
}
