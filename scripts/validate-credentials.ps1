$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'vmware-workstation/scripts/Set-Credentials.ps1'
$tokens = $null
$parseErrors = $null
[Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('vmware-credential-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
$credentialPath = Join-Path $tempRoot 'credentials.json'
$testVMX = Join-Path $tempRoot 'test.vmx'
New-Item -ItemType File -Path $testVMX | Out-Null
function Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    if ($AsSecureString) { return ConvertTo-SecureString $(if ($Prompt -like 'Native VNC*') { 'TestVNC1' } else { 'FAKE-test-value-only' }) -AsPlainText -Force }
    return 'FAKE-test-user-only'
}
try {
    & $source -Rest -GuestProfile default -VMPasswordProfile encrypted -Path $credentialPath | Out-Null
    & $source -ConsoleProfile console_test -VMX $testVMX -Path $credentialPath | Out-Null
    # Exercise new-file inherited ACLs and repeated protection without owner/SACL changes.
    & (Join-Path $repoRoot 'vmware-workstation/scripts/Protect-LocalFile.ps1') -LiteralPath $testVMX
    & (Join-Path $repoRoot 'vmware-workstation/scripts/Protect-LocalFile.ps1') -LiteralPath $testVMX
    $config = Get-Content -LiteralPath $credentialPath -Raw | ConvertFrom-Json -AsHashtable
    if ($config.guest.default.username -ne 'FAKE-test-user-only' -or $config.rest.password -ne 'FAKE-test-value-only') { throw 'Credential profile round-trip failed' }
    if ($config.console.console_test.password -ne 'TestVNC1' -or $config.console.console_test.vmx -ne $testVMX) { throw 'Console credential round-trip failed' }
    $acl = Get-Acl -LiteralPath $credentialPath
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if (-not $acl.AreAccessRulesProtected) { throw 'Credential ACL inheritance was not disabled' }
    foreach ($entry in $acl.Access) {
        if ($entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'Credential file permits an unexpected identity' }
    }
    $protectedVMX = Get-Acl -LiteralPath $testVMX
    if (-not $protectedVMX.AreAccessRulesProtected) { throw 'VMX protection was not applied' }
    foreach ($entry in $protectedVMX.Access) { if ($entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'VMX permits an unexpected identity' } }
    Write-Output 'Credential setup script parsed and verified with fake credentials; only the current Windows user has file access.'
} finally {
    if (Test-Path -LiteralPath $credentialPath) { Remove-Item -LiteralPath $credentialPath -Force }
    Remove-Item -LiteralPath $testVMX
    Remove-Item -LiteralPath $tempRoot
}
