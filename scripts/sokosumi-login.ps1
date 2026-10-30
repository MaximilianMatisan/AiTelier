# Workaround for the Sokosumi CLI 1.0.4 Windows OAuth bug.
#
# The CLI opens the OAuth authorization URL with `cmd /c start <url>`. On
# Windows, cmd splits the command line at every `&`, so the browser receives
# only the part before `response_type=code` and shows:
#   "Sign-in did not work ... Details: response_type is required"
#
# This script runs the CLI's own OAuth flow but replaces the browser launch:
#   1. writes the full authorization URL to .local/login-url.txt
#   2. prints it, so you can open it manually
#   3. also tries explorer.exe (which does not shell-split `&`)
#
# The local callback server and token exchange are unchanged, so the token is
# saved in the same Windows Credential Manager entry the CLI uses.

$ErrorActionPreference = 'Stop'

$workspace = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $workspace '.local'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$globalRoot = (& npm root -g).Trim()
$cliRoot = Join-Path $globalRoot '@masumi_network\sokosumi'
if (-not (Test-Path $cliRoot)) {
    throw "Sokosumi CLI not found at $cliRoot. Install it with: npm install --global @masumi_network/sokosumi@1.0.4"
}

$env:SOKOSUMI_CLI_ROOT = $cliRoot
$env:SOKOSUMI_LOGIN_URL_FILE = Join-Path $outDir 'login-url.txt'

node (Join-Path $PSScriptRoot 'sokosumi-login.mjs')
