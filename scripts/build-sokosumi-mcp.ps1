[CmdletBinding()]
param(
    [string]$Image = "localhost/sokosumi-mcp:local",
    [switch]$NoCache
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$context = Join-Path $root "containers/sokosumi-mcp"
$containerfile = Join-Path $context "Containerfile"

if (-not (Test-Path -LiteralPath $containerfile)) {
    throw "Containerfile not found: $containerfile"
}

$buildArgs = @("build", "-f", $containerfile, "-t", $Image)
if ($NoCache) {
    $buildArgs += "--no-cache"
}
$buildArgs += $context

Write-Host "Building $Image ..."
& podman @buildArgs
if ($LASTEXITCODE -ne 0) {
    throw "podman build failed with exit code $LASTEXITCODE"
}

Write-Host "Built $Image"
