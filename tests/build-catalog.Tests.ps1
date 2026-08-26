# Pester 3.4 (the version that ships with Windows PowerShell 5.1). Run: Invoke-Pester .\tests
#
# Builds a synthetic package in TestDrive and checks every promise the catalog makes to the
# clients: hashes computed from the file, one version per packument, byte-stable output,
# and refusal of packages the client would refuse.

$repoRoot = Split-Path -Parent $PSScriptRoot
$buildScript = Join-Path $repoRoot 'scripts\build-catalog.ps1'

function New-TestPackage {
    param(
        [string] $Root,
        [string] $Name = 'fake-ext',
        [string] $Version = '1.2.3',
        [string] $FileName,
        [hashtable] $Extra = @{},
        [string[]] $TopDirs = @('package')
    )
    $pkgDir = Join-Path $Root "packages\$Name"
    New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null

    $stage = Join-Path $Root ("stage-" + [Guid]::NewGuid().ToString('n'))
    foreach ($dir in $TopDirs) {
        New-Item -ItemType Directory -Force -Path (Join-Path $stage $dir) | Out-Null
        $json = [ordered]@{
            name = $Name; version = $Version; description = 'A test extension'
            author = @{ name = 'Tester' }; main = 'dist/main.js'; license = 'MIT'
            homepage = 'https://example.test/fake'
            airdcpp = @{ apiVersion = 1; minApiFeatureLevel = 2 }
        }
        foreach ($k in $Extra.Keys) { $json[$k] = $Extra[$k] }
        [IO.File]::WriteAllText((Join-Path $stage "$dir\package.json"), ($json | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
        'console.log(1)' | Set-Content (Join-Path $stage "$dir\main.js")
    }
    if (-not $FileName) { $FileName = "$Name-$Version.tgz" }
    $tgz = Join-Path $pkgDir $FileName
    & tar.exe -czf $tgz -C $stage $TopDirs
    Remove-Item -Recurse -Force $stage

    $meta = @{
        publisher = 'tester'; homepage = 'https://example.test/fake'
        repository = 'https://example.test/repo'; date = '2024-03-11T00:00:00.000Z'
        source = 'https://example.test/fake.tgz'; upstream = 'github'
    }
    [IO.File]::WriteAllText((Join-Path $pkgDir 'meta.json'), ($meta | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    return $tgz
}

function Get-Bytes([string] $Path) { [IO.File]::ReadAllBytes($Path) }

Describe 'build-catalog.ps1' {
    $root = Join-Path $TestDrive 'repo'
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $tgz = New-TestPackage -Root $root
    $out = Join-Path $root 'out'

    & $buildScript -Root $root -Out $out -Repository 'fuldcpp/extensions' -BaseUrl 'https://fuldcpp.net/extensions/'

    $catalogPath = Join-Path $out 'catalog.json'
    $latestPath = Join-Path $out 'fake-ext\latest'
    $packumentPath = Join-Path $out 'fake-ext\index.json'
    $expectedSha1 = (Get-FileHash -Path $tgz -Algorithm SHA1).Hash.ToLowerInvariant()
    $expectedUrl = 'https://github.com/fuldcpp/extensions/releases/download/fake-ext-v1.2.3/fake-ext-1.2.3.tgz'

    It 'emits the three documents' {
        $catalogPath | Should Exist
        $latestPath | Should Exist
        $packumentPath | Should Exist
    }

    $catalog = Get-Content $catalogPath -Raw | ConvertFrom-Json
    $latest = Get-Content $latestPath -Raw | ConvertFrom-Json
    $packument = Get-Content $packumentPath -Raw | ConvertFrom-Json

    It 'pins the tarball by the hash of the file itself, in every document' {
        $catalog.objects[0].package.dist.shasum | Should Be $expectedSha1
        $latest.dist.shasum | Should Be $expectedSha1
        $packument.versions.'1.2.3'.dist.shasum | Should Be $expectedSha1
    }

    It 'points every document at the release asset for the tag' {
        $catalog.objects[0].package.dist.tarball | Should Be $expectedUrl
        $latest.dist.tarball | Should Be $expectedUrl
        $packument.versions.'1.2.3'.dist.tarball | Should Be $expectedUrl
    }

    It 'carries what each client reads' {
        $catalog.formatVersion | Should Be 1
        $catalog.total | Should Be 1
        $catalog.objects[0].package.name | Should Be 'fake-ext'
        $catalog.objects[0].package.version | Should Be '1.2.3'
        $catalog.objects[0].package.publisher.username | Should Be 'tester'
        $catalog.objects[0].package.date | Should Be '2024-03-11T00:00:00.000Z'
        $catalog.objects[0].package.homepage | Should Be $catalog.objects[0].package.links.homepage
        $latest._id | Should Be 'fake-ext@1.2.3'
        $latest._npmUser.name | Should Be 'tester'
        $packument.'dist-tags'.latest | Should Be '1.2.3'
    }

    It 'lists exactly one version in the packument' {
        @($packument.versions.PSObject.Properties).Count | Should Be 1
    }

    It 'derives time from the packages, not the clock' {
        $catalog.time | Should Be '2024-03-11T00:00:00.000Z'
        $packument.modified | Should Be '2024-03-11T00:00:00.000Z'
    }

    It 'writes UTF-8 without a BOM and LF only' {
        foreach ($p in $catalogPath, $latestPath, $packumentPath) {
            $bytes = Get-Bytes $p
            ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB) | Should Be $false
            ($bytes -contains 0x0D) | Should Be $false
            $bytes[-1] | Should Be 0x0A
        }
    }

    It 'is byte-stable across runs' {
        $before = (Get-FileHash $catalogPath).Hash
        & $buildScript -Root $root -Out $out -Repository 'fuldcpp/extensions' -BaseUrl 'https://fuldcpp.net/extensions/'
        (Get-FileHash $catalogPath).Hash | Should Be $before
    }

    It 'prunes documents for packages that no longer exist' {
        New-Item -ItemType Directory -Force -Path (Join-Path $out 'gone-ext') | Out-Null
        'stale' | Set-Content (Join-Path $out 'gone-ext\latest')
        & $buildScript -Root $root -Out $out -Repository 'fuldcpp/extensions' -BaseUrl 'https://fuldcpp.net/extensions/'
        (Join-Path $out 'gone-ext') | Should Not Exist
    }
}

Describe 'build-catalog.ps1 refusals' {
    It 'refuses a private package' {
        $root = Join-Path $TestDrive 'private'
        New-TestPackage -Root $root -Extra @{ private = $true } | Out-Null
        { & $buildScript -Root $root -Out (Join-Path $root 'out') } | Should Throw 'private'
    }

    It 'refuses a version outside the semver grammar the client parses' {
        $root = Join-Path $TestDrive 'badver'
        New-TestPackage -Root $root -Version '1.2.0-beta1' | Out-Null
        { & $buildScript -Root $root -Out (Join-Path $root 'out') } | Should Throw 'grammar'
    }

    It 'refuses a tarball whose name does not match name-version.tgz' {
        $root = Join-Path $TestDrive 'badname'
        New-TestPackage -Root $root -FileName 'fake-ext.tgz' | Out-Null
        { & $buildScript -Root $root -Out (Join-Path $root 'out') } | Should Throw 'file name'
    }

    It 'refuses more than one top-level directory' {
        $root = Join-Path $TestDrive 'twodirs'
        New-TestPackage -Root $root -TopDirs @('package', 'other') | Out-Null
        { & $buildScript -Root $root -Out (Join-Path $root 'out') } | Should Throw 'top-level'
    }

    It 'refuses a package directory with two tarballs' {
        $root = Join-Path $TestDrive 'twotgz'
        $tgz = New-TestPackage -Root $root
        Copy-Item $tgz (Join-Path (Split-Path $tgz) 'fake-ext-1.2.4.tgz')
        { & $buildScript -Root $root -Out (Join-Path $root 'out') } | Should Throw 'exactly one'
    }
}
