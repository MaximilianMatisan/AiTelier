[CmdletBinding()]
param(
    [string]$Destination = "hackathon-agent",
    [string]$Ref = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root $Destination
$repo = "https://github.com/masumi-network/tum-hackathon-quickstart.git"

if (Test-Path -LiteralPath $dest) {
    throw "Destination already exists: $dest. Reuse it or remove it explicitly."
}

Write-Host "Cloning $repo ..."
& git clone $repo $dest
if ($LASTEXITCODE -ne 0) {
    throw "git clone failed with exit code $LASTEXITCODE"
}

if (-not [string]::IsNullOrWhiteSpace($Ref)) {
    & git -C $dest checkout $Ref
    if ($LASTEXITCODE -ne 0) {
        throw "git checkout $Ref failed with exit code $LASTEXITCODE"
    }
}

$envExample = Join-Path $dest ".env.example"
$envFile = Join-Path $dest ".env"
if ((Test-Path -LiteralPath $envExample) -and -not (Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath $envExample -Destination $envFile
}

New-Item -ItemType Directory -Force -Path (Join-Path $dest "docs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dest ".local") | Out-Null

$commit = (& git -C $dest rev-parse --short HEAD).Trim()
Write-Host "Bootstrapped $dest at $commit"
Write-Host ""
Write-Host "Next:"
Write-Host "  Set-Location $Destination"
Write-Host "  npm ci"
Write-Host "  # edit .env and agent/instructions.md"
Write-Host "  npm start"
Write-Host "  # in a second terminal: npm run worker"
