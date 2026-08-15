param(
  [string]$OutputDirectory = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$extensionDirectory = Join-Path $projectRoot 'extension'
$manifestPath = Join-Path $extensionDirectory 'manifest.json'

if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "Missing manifest: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Invalid manifest version: $version"
}

$releaseName = "CloudMedicationHelper-$version"
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
$releaseDirectory = Join-Path $resolvedOutput $releaseName
$zipPath = Join-Path $resolvedOutput "$releaseName.zip"
$checksumPath = "$zipPath.sha256.txt"

foreach ($target in @($releaseDirectory, $zipPath, $checksumPath)) {
  if (Test-Path -LiteralPath $target) {
    throw "Output already exists; remove or rename it first: $target"
  }
}

New-Item -ItemType Directory -Path $releaseDirectory | Out-Null
Copy-Item -LiteralPath $extensionDirectory -Destination (Join-Path $releaseDirectory 'extension') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination $releaseDirectory
Copy-Item -LiteralPath (Join-Path $projectRoot 'USER-GUIDE.md') -Destination $releaseDirectory
Copy-Item -LiteralPath (Join-Path $projectRoot 'README-DEV.md') -Destination $releaseDirectory
Copy-Item -LiteralPath $PSCommandPath -Destination $releaseDirectory

Compress-Archive -Path (Join-Path $releaseDirectory '*') -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
"$hash  $releaseName.zip" | Set-Content -LiteralPath $checksumPath -Encoding ASCII

[pscustomobject]@{
  Version = $version
  ReleaseDirectory = $releaseDirectory
  Zip = $zipPath
  Sha256 = $hash
}
