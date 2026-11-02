[CmdletBinding()]
param([Parameter(Mandatory)][string]$VMX, [Parameter(Mandatory)][ValidateRange(1024,65535)][int]$Port, [string]$Profile = 'default')
$ErrorActionPreference = 'Stop'
$entry = Join-Path (Split-Path -Parent $PSScriptRoot) 'server/configure-console.cjs'
& node $entry --vmx $VMX --port $Port --profile $Profile
if ($LASTEXITCODE) { throw 'Native console setup failed. See the redacted diagnostic above.' }
