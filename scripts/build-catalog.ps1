# Generates the catalog documents the clients read, from the tarballs under packages/.
#
# Every value that decides what gets installed (tarball URL, hash, size, version) is derived
# from the package file itself; meta.json only supplies presentation data the archive does
# not carry. The output mimics the npm registry's three document shapes, because that is
# what the web UI, the native Extensions window and the auto-updater already parse:
#
#   out/catalog.json         search result   {objects:[{package:{...}}], total, time}
#   out/<name>/latest        "/latest" doc   {_id, name, version, dist:{tarball, shasum}, ...}
#   out/<name>/index.json    packument       {versions:{<ver>:{dist:{...}}}, dist-tags}
#
# The packument lists exactly one version. The client parses it into a key-sorted map, so a
# second version would be picked by string order, not by semver.
#
# Output is UTF-8 without a BOM and LF-only, and depends on nothing but the inputs (no clock),
# so re-running on unchanged packages reproduces the signed bytes exactly.
#
#   .\scripts\build-catalog.ps1            # writes .\out\

[CmdletBinding()]
param(
    [string] $Root = (Split-Path -Parent $PSScriptRoot),
    [string] $Out = (Join-Path (Split-Path -Parent $PSScriptRoot) 'out'),
    [string] $Repository = 'fuldcpp/extensions',
    [string] $BaseUrl = 'https://fuldcpp.net/extensions/'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'inspect-tarball.ps1')

$packagesDir = Join-Path $Root 'packages'
if (-not (Test-Path $packagesDir)) { throw "No packages directory at $packagesDir" }

function Write-Document([string] $Path, $Object) {
    # UTF-8 without a BOM, LF only: the signature covers these exact bytes, and the same
    # rule keeps git from ever touching them (see .gitattributes in the website repo).
    $json = ($Object | ConvertTo-Json -Depth 8) -replace "`r`n", "`n"
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    [IO.File]::WriteAllText($Path, $json + "`n", (New-Object Text.UTF8Encoding $false))
}

function Read-Meta([string] $Dir) {
    $path = Join-Path $Dir 'meta.json'
    if (-not (Test-Path $path)) { throw "No meta.json in $Dir" }
    $meta = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    foreach ($field in 'publisher', 'date', 'upstream') {
        if (-not ($meta.PSObject.Properties.Name -contains $field) -or -not $meta.$field) {
            throw "$path lacks required field '$field'"
        }
    }
    if ($meta.upstream -notin @('npm', 'github')) { throw "$path`: upstream must be npm or github" }
    return $meta
}

function Get-Optional($Object, [string] $Field) {
    if ($Object.PSObject.Properties.Name -contains $Field) { return [string] $Object.$Field }
    return ''
}

$entries = @()
$dirs = @(Get-ChildItem -Path $packagesDir -Directory)
foreach ($dir in $dirs) {
    # -Filter '*.tgz' would also match foo.tgz1 (8.3 semantics); compare the extension itself
    $tarballs = @(Get-ChildItem -Path $dir.FullName -File | Where-Object { $_.Extension -eq '.tgz' })
    if ($tarballs.Count -ne 1) {
        throw "Expected exactly one .tgz in $($dir.FullName), found $($tarballs.Count)"
    }

    $info = Get-ExtensionPackageInfo -Path $tarballs[0].FullName
    if ($info.name -ne $dir.Name) {
        throw "$($dir.FullName): directory name must match the package name '$($info.name)'"
    }
    $meta = Read-Meta $dir.FullName

    $tag = "$($info.name)-v$($info.version)"
    $homepage = Get-Optional $meta 'homepage'
    if (-not $homepage) { $homepage = $info.homepage }

    $entries += [pscustomobject]@{
        info      = $info
        meta      = $meta
        homepage  = $homepage
        tarball   = "https://github.com/$Repository/releases/download/$tag/$($tarballs[0].Name)"
    }
}

# Ordinal, not culture-aware: culture sorting ignores hyphens, and the order must not depend
# on the machine that ran the script.
$names = [string[]] @($entries | ForEach-Object { $_.info.name })
[Array]::Sort($names, [StringComparer]::Ordinal)
$entries = @($names | ForEach-Object { $n = $_; $entries | Where-Object { $_.info.name -eq $n } })

$objects = @()
$latestDate = ''
foreach ($e in $entries) {
    $info = $e.info; $meta = $e.meta
    if ([string] $meta.date -gt $latestDate) { $latestDate = [string] $meta.date }

    $dist = [ordered]@{
        tarball   = $e.tarball
        shasum    = $info.sha1
        integrity = $info.integrity
        size      = $info.size
    }

    $links = [ordered]@{ homepage = $e.homepage }
    $repository = Get-Optional $meta 'repository'
    if ($repository) { $links.repository = $repository }
    if ($meta.upstream -eq 'npm') { $links.npm = "https://www.npmjs.com/package/$($info.name)" }

    $package = [ordered]@{
        name        = $info.name
        version     = $info.version
        description = $info.description
        author      = $info.author
        publisher   = [ordered]@{ username = [string] $meta.publisher }
        date        = [string] $meta.date
        homepage    = $e.homepage
        links       = $links
        keywords    = @('airdcpp-extensions', 'airdcpp-extensions-public')
        license     = $info.license
        engines     = $info.engines
        airdcpp     = [ordered]@{ apiVersion = $info.apiVersion; minApiFeatureLevel = $info.minApiFeatureLevel }
        dist        = $dist
    }
    $objects += [ordered]@{ package = $package }

    $pkgOut = Join-Path $Out $info.name
    Write-Document (Join-Path $pkgOut 'latest') ([ordered]@{
        _id         = "$($info.name)@$($info.version)"
        name        = $info.name
        version     = $info.version
        description = $info.description
        author      = [ordered]@{ name = $info.author }
        homepage    = $e.homepage
        license     = $info.license
        _npmUser    = [ordered]@{ name = [string] $meta.publisher }
        airdcpp     = $package.airdcpp
        dist        = $dist
    })

    $versions = [ordered]@{}
    $versions[$info.version] = [ordered]@{
        name    = $info.name
        version = $info.version
        dist    = $dist
    }
    Write-Document (Join-Path $pkgOut 'index.json') ([ordered]@{
        name        = $info.name
        'dist-tags' = [ordered]@{ latest = $info.version }
        modified    = [string] $meta.date
        versions    = $versions
    })
}

Write-Document (Join-Path $Out 'catalog.json') ([ordered]@{
    formatVersion = 1
    objects       = $objects
    total         = $objects.Count
    time          = $latestDate
})

# Documents for packages that were removed would otherwise keep being served forever
foreach ($stale in @(Get-ChildItem -Path $Out -Directory | Where-Object { $names -notcontains $_.Name })) {
    Remove-Item -Recurse -Force $stale.FullName
}

Write-Output "Wrote $($objects.Count) package(s) to $Out"
