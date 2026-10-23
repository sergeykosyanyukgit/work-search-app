[CmdletBinding()]
param([string] $InstallerPath)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$ProgressPreference = 'SilentlyContinue'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $repositoryRoot 'resources\vcredist'
$destination = Join-Path $runtimeDirectory 'vc_redist.x64.exe'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null

function Assert-MicrosoftSignature {
    param([string] $Path)
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') {
        throw 'Microsoft Visual C++ Runtime signature verification failed. The installer was not accepted.'
    }
}

$partial = "$destination.part"
try {
    if ($InstallerPath) {
        $source = (Resolve-Path -LiteralPath $InstallerPath).Path
        Assert-MicrosoftSignature -Path $source
        if ($source -ne $destination) { Copy-Item -LiteralPath $source -Destination $partial -Force }
    }
    elseif (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
        Write-Host '[download] Microsoft Visual C++ Redistributable x64'
        Invoke-WebRequest -Uri 'https://aka.ms/vc14/vc_redist.x64.exe' -OutFile $partial -UseBasicParsing
    }
    if (Test-Path -LiteralPath $partial) {
        Assert-MicrosoftSignature -Path $partial
        Move-Item -LiteralPath $partial -Destination $destination -Force
    }
    Assert-MicrosoftSignature -Path $destination
    $version = (Get-Item -LiteralPath $destination).VersionInfo.FileVersion
    [ordered]@{ publisher = 'Microsoft Corporation'; version = $version; sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDirectory 'manifest.json') -Encoding UTF8
    Write-Host "[ok] Microsoft Visual C++ Runtime $version (staged for the application installer)"
}
finally { if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force } }
