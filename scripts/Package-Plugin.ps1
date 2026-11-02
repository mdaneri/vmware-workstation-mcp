$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginRoot = Join-Path $repoRoot 'vmware-workstation'
$distRoot = Join-Path $repoRoot 'dist'
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
$version = (Get-Content -LiteralPath (Join-Path $pluginRoot 'plugin.json') -Raw | ConvertFrom-Json).version
$archive = Join-Path $distRoot "vmware-workstation-$version.zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
[System.IO.Compression.ZipFile]::CreateFromDirectory($pluginRoot, $archive)
$zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
try {
    $zip.Entries | Select-Object FullName, Length
    foreach ($required in @('plugin.json', 'mcp.json', 'LICENSE', 'server/server.cjs', 'server/configure-console.cjs', 'skills/manage-workstation/SKILL.md', 'README.md', 'reference.md', 'console.md', 'THIRD-PARTY-NOTICES.md', 'tool-schemas.json', 'assets/icon.svg', 'scripts/Set-Credentials.ps1', 'scripts/Configure-Console.ps1', 'scripts/Protect-LocalFile.ps1')) {
        if (-not ($zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -eq $required })) { throw "Archive is missing $required" }
    }
} finally { $zip.Dispose() }
Write-Output $archive
