param([Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Repository)
$ErrorActionPreference = 'Stop'
$destinationRoot = (Resolve-Path -LiteralPath $Repository).Path
if (-not (Test-Path -LiteralPath (Join-Path $destinationRoot 'apps\manager\src\admin-clients.controller.ts'))) { throw 'The destination is not the expected codex-manager repository.' }
$sourceRoot = Join-Path $PSScriptRoot 'codex-manager'
$files = @('scripts\provision-interview-assistant.mjs', 'scripts\provision-interview-assistant.test.mjs')
foreach ($relative in $files) {
  $source = Join-Path $sourceRoot $relative
  $destination = [IO.Path]::GetFullPath((Join-Path $destinationRoot $relative))
  if (-not $destination.StartsWith($destinationRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Destination escapes repository.' }
  if (Test-Path -LiteralPath $destination) {
    if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) { throw "Existing file differs; inspect it before replacing: $relative" }
    continue
  }
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination)) | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination
}
Write-Output 'Added the two provisioning scripts. No service records, tokens, deployment, or package files were changed.'
