[CmdletBinding()]
param(
    [switch] $IncludeModel,
    [string] $ModelDirectory,
    [string] $ArchivePath
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$ProgressPreference = 'SilentlyContinue'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$binaryDirectory = Join-Path $repositoryRoot 'resources\whisper'
$cacheDirectory = Join-Path $repositoryRoot '.cache\whisper'
$version = 'v1.9.2'
$archiveHash = '49DCC16DE826F20BD53D44F947A1AE49DFA81F86CAD67A64D80820CB192D674A'
$modelHash = '1BE3A9B2063867B937E64E2EC7483364A79917E157FA98C5D94B5C1FFFEA987B'
if (-not $ModelDirectory) { $ModelDirectory = Join-Path $repositoryRoot 'resources\models' }
New-Item -ItemType Directory -Force -Path $binaryDirectory, $cacheDirectory | Out-Null

function Get-VerifiedFile {
    param([string] $Url, [string] $Destination, [string] $Sha256)
    if ((Test-Path -LiteralPath $Destination -PathType Leaf) -and (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -eq $Sha256) {
        Write-Host "[ok] $(Split-Path -Leaf $Destination)"
        return
    }
    $partial = "$Destination.part"
    try {
        Write-Host "[download] $(Split-Path -Leaf $Destination)"
        Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing
        if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) { throw 'SHA256 mismatch: downloaded file was not installed.' }
        Move-Item -LiteralPath $partial -Destination $Destination -Force
    }
    finally { if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force } }
}

if ($ArchivePath) {
    $archive = (Resolve-Path -LiteralPath $ArchivePath).Path
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $archiveHash) { throw 'The supplied archive is not the pinned whisper.cpp v1.9.2 x64 release.' }
}
else {
    $archive = Join-Path $cacheDirectory "whisper-bin-x64-$version.zip"
    Get-VerifiedFile -Url "https://github.com/ggml-org/whisper.cpp/releases/download/$version/whisper-bin-x64.zip" -Destination $archive -Sha256 $archiveHash
}

# Extract only the known application payload; archive filenames never control destination paths.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$required = @('whisper-server.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll',
    'ggml-cpu-alderlake.dll', 'ggml-cpu-cannonlake.dll', 'ggml-cpu-cascadelake.dll',
    'ggml-cpu-haswell.dll', 'ggml-cpu-icelake.dll', 'ggml-cpu-sandybridge.dll',
    'ggml-cpu-skylakex.dll', 'ggml-cpu-sse42.dll', 'ggml-cpu-x64.dll')
$zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
try {
    foreach ($name in $required) {
        $entry = $zip.Entries | Where-Object { $_.Name -eq $name } | Select-Object -First 1
        if (-not $entry) { throw "Pinned archive is missing $name" }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $binaryDirectory $name), $true)
    }
}
finally { $zip.Dispose() }

$license = Join-Path $repositoryRoot 'licenses\whisper-v1.9.2\LICENSE'
if ((Get-FileHash -LiteralPath $license -Algorithm SHA256).Hash -ne '94F29BBED6A22C35B992C5C6EBF0E7C92F13B836B90F36F461C9CF2F0F1D010D') {
    throw 'Pinned Whisper/ggml license is missing or changed.'
}
Copy-Item -LiteralPath $license -Destination (Join-Path $binaryDirectory 'LICENSE') -Force

$manifest = [ordered]@{ version = $version; archiveSha256 = $archiveHash.ToLowerInvariant(); files = [ordered]@{} }
foreach ($name in $required) { $manifest.files[$name] = (Get-FileHash -LiteralPath (Join-Path $binaryDirectory $name) -Algorithm SHA256).Hash.ToLowerInvariant() }
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $binaryDirectory 'manifest.json') -Encoding UTF8

if ($IncludeModel) {
    $modelLicenseDirectory = Join-Path $repositoryRoot 'licenses\whisper-model'
    $modelLicense = Join-Path $modelLicenseDirectory 'LICENSE'
    if ((Get-FileHash -LiteralPath $modelLicense -Algorithm SHA256).Hash -ne 'B5D65A59060E68C4FF940E1EDDFA6F94B2D68FDF58ED7F4DD57721C997E35E9D') {
        throw 'Pinned OpenAI Whisper model license is missing or changed.'
    }
    New-Item -ItemType Directory -Force -Path $ModelDirectory | Out-Null
    Get-VerifiedFile -Url 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin?download=true' -Destination (Join-Path $ModelDirectory 'ggml-small.bin') -Sha256 $modelHash
    Copy-Item -LiteralPath $modelLicense -Destination (Join-Path $ModelDirectory 'LICENSE') -Force
    Copy-Item -LiteralPath (Join-Path $modelLicenseDirectory 'SOURCE.md') -Destination (Join-Path $ModelDirectory 'SOURCE.md') -Force
}

Write-Host 'Whisper CPU engine is ready. The app can download or import its model in Settings.'
