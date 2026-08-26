# Reads the facts the catalog needs out of an extension tarball, and refuses anything the
# client would refuse at install time, so a bad package fails here rather than on a user's
# machine. Dot-source this file to get Get-ExtensionPackageInfo.
#
# The checks mirror ExtensionManager::installLocalExtension and Extension::initializeThrow in
# airdcpp-webapi: exactly one directory at the top of the archive (npm packs everything under
# "package/"), and a package.json with name, description, version, author, main and
# airdcpp.apiVersion == 1. On top of that the version must fit the grammar the client's
# semver parser accepts, because a version it cannot parse throws inside every update check.

Set-StrictMode -Version Latest

# What semver.hpp (bundled with airdcpp-webapi) parses: X.Y.Z with an optional
# -alpha/-beta/-rc suffix and an optional .N after it. Anything else is rejected.
$script:VersionPattern = '^\d+\.\d+\.\d+(-(alpha|beta|rc)(\.\d+)?)?$'

function Get-ExtensionPackageInfo {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) { throw "No tarball at $Path" }
    $file = Get-Item -LiteralPath $Path

    $listing = @(& tar.exe -tzf $file.FullName 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Not a readable .tgz: $($file.FullName) ($listing)" }

    $topDirs = @($listing | ForEach-Object { ($_ -replace '\\', '/').Split('/')[0] } | Sort-Object -Unique)
    if ($topDirs.Count -ne 1) {
        throw "Expected exactly one top-level directory in $($file.Name), found: $($topDirs -join ', ')"
    }
    $topDir = $topDirs[0]

    if (-not ($listing -contains "$topDir/package.json")) {
        throw "$($file.Name) has no $topDir/package.json"
    }

    $temp = Join-Path ([IO.Path]::GetTempPath()) ("ext-inspect-" + [Guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $temp | Out-Null
    try {
        & tar.exe -xzf $file.FullName -C $temp "$topDir/package.json" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Failed to extract package.json from $($file.Name)" }
        $packageText = [IO.File]::ReadAllText((Join-Path $temp "$topDir/package.json"), [Text.Encoding]::UTF8)
    } finally {
        Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
    }

    $pkg = $packageText | ConvertFrom-Json
    $fields = @($pkg.PSObject.Properties.Name)

    foreach ($field in 'name', 'description', 'version', 'author', 'main') {
        if (-not ($fields -contains $field) -or -not $pkg.$field) {
            throw "$($file.Name): package.json lacks required field '$field'"
        }
    }
    if (-not ($fields -contains 'airdcpp') -or -not $pkg.airdcpp) {
        throw "$($file.Name): package.json lacks the 'airdcpp' section"
    }
    $apiFields = @($pkg.airdcpp.PSObject.Properties.Name)
    if (-not ($apiFields -contains 'apiVersion') -or $pkg.airdcpp.apiVersion -ne 1) {
        throw "$($file.Name): airdcpp.apiVersion must be 1"
    }
    if (($fields -contains 'private') -and $pkg.private) {
        # A private package is skipped by every update check in the client, which defeats
        # hosting it. Repack without the flag (see README) instead of publishing as-is.
        throw "$($file.Name): package.json is marked private"
    }
    if ($pkg.version -notmatch $script:VersionPattern) {
        throw "$($file.Name): version '$($pkg.version)' is outside the grammar the client parses ($script:VersionPattern)"
    }
    if ($file.Name -ne "$($pkg.name)-$($pkg.version).tgz") {
        throw "$($file.Name): file name must be $($pkg.name)-$($pkg.version).tgz"
    }

    $author = if ($pkg.author -is [string]) { $pkg.author } else { [string] $pkg.author.name }
    if (-not $author) { throw "$($file.Name): author has no name" }

    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    $sha1 = [BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    $sha512 = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($bytes))

    $optional = @{}
    foreach ($field in 'license', 'homepage', 'keywords') {
        if ($fields -contains $field) { $optional[$field] = $pkg.$field }
    }
    $engines = @()
    if (($fields -contains 'engines') -and $pkg.engines) {
        $engines = @($pkg.engines.PSObject.Properties.Name)
    }
    $minLevel = 0
    if ($apiFields -contains 'minApiFeatureLevel') { $minLevel = [int] $pkg.airdcpp.minApiFeatureLevel }

    [ordered]@{
        name               = [string] $pkg.name
        version            = [string] $pkg.version
        description        = [string] $pkg.description
        author             = $author
        license            = [string] $optional['license']
        homepage           = [string] $optional['homepage']
        keywords           = @($optional['keywords'])
        engines            = $engines
        apiVersion         = 1
        minApiFeatureLevel = $minLevel
        topDir             = $topDir
        files              = $listing
        sha1               = $sha1
        integrity          = "sha512-$sha512"
        size               = [int64] $file.Length
        path               = $file.FullName
    }
}
