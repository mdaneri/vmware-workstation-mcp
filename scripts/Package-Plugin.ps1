$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    & node (Join-Path $PSScriptRoot 'package-plugin.mjs')
    if ($LASTEXITCODE) { throw 'Plugin packaging failed.' }
} finally { Pop-Location }
