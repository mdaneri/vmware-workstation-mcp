param([Parameter(Mandatory)][string]$LiteralPath)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) {
    $entry = Join-Path (Split-Path -Parent $PSScriptRoot) 'server/set-credentials.cjs'
    & node $entry --protect $LiteralPath
    if ($LASTEXITCODE) { throw 'Could not restrict file access to the current user.' }
    return
}
if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) { throw 'Expected an existing regular file.' }
$fileInfo = [IO.FileInfo]::new([IO.Path]::GetFullPath($LiteralPath))
$acl = [IO.FileSystemAclExtensions]::GetAccessControl($fileInfo, [Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true, $false)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($rule in @($acl.Access)) { if ($null -ne $rule) { [void]$acl.RemoveAccessRuleSpecific($rule) } }
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow'))
[IO.FileSystemAclExtensions]::SetAccessControl($fileInfo, $acl)
