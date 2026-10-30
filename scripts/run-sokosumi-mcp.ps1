[CmdletBinding()]
param(
    [string]$Image = "localhost/sokosumi-mcp:local",
    [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $root ".env"
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
    throw "Missing env file: $EnvFile. Copy .env.example to .env and set SOKOSUMI_API_KEY."
}

& podman image exists $Image 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Image $Image not found. Run scripts/build-sokosumi-mcp.ps1 first."
}

$runArgs = @(
    "run",
    "--rm",
    "--security-opt=no-new-privileges",
    "--env-file",
    $EnvFile,
    "-i",
    $Image
)

& podman @runArgs
exit $LASTEXITCODE
