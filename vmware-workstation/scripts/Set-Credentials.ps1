[CmdletBinding()]
param(
    [switch]$Rest,
    [string]$GuestProfile,
    [string]$VMPasswordProfile,
    [string]$ConsoleProfile,
    [string]$VMX,
    [string]$Path = (Join-Path $env:APPDATA 'VMwareWorkstationPlugin/credentials.json')
)
$ErrorActionPreference = 'Stop'
if (-not $Rest -and -not $GuestProfile -and -not $VMPasswordProfile -and -not $ConsoleProfile) { throw 'Choose -Rest, -GuestProfile, -VMPasswordProfile, and/or -ConsoleProfile.' }
foreach ($profile in @($GuestProfile, $VMPasswordProfile, $ConsoleProfile)) {
    if ($profile -and $profile -notmatch '^[a-zA-Z][a-zA-Z0-9_]{0,31}$') { throw 'Profile names must start with a letter and contain up to 32 letters, digits, or underscores.' }
}
if ($ConsoleProfile -and (-not $VMX -or -not [IO.Path]::IsPathFullyQualified($VMX) -or [IO.Path]::GetExtension($VMX) -ne '.vmx' -or -not (Test-Path -LiteralPath $VMX -PathType Leaf))) { throw '-ConsoleProfile requires -VMX with an absolute existing VMX path.' }
function Read-Password([string]$Prompt) {
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
}
$config = @{}
if (Test-Path -LiteralPath $Path) { $config = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable }
if ($Rest) { $config.rest = @{ username = (Read-Host 'Workstation REST username'); password = (Read-Password 'Workstation REST password') } }
if ($GuestProfile) {
    if (-not $config.guest) { $config.guest = @{} }
    $config.guest[$GuestProfile.ToLowerInvariant()] = @{ username = (Read-Host 'Guest OS username'); password = (Read-Password 'Guest OS password') }
}
if ($VMPasswordProfile) {
    if (-not $config.vm) { $config.vm = @{} }
    $config.vm[$VMPasswordProfile.ToLowerInvariant()] = @{ password = (Read-Password 'Encrypted VM password') }
}
if ($ConsoleProfile) {
    if (-not $config.console) { $config.console = @{} }
    $consolePassword = Read-Password 'Native VNC password (1 to 8 ASCII characters; use a dedicated password)'
    if ($consolePassword -notmatch '^[\x20-\x7e]{1,8}$') { throw 'VNC passwords must contain 1 to 8 ASCII characters.' }
    $config.console[$ConsoleProfile.ToLowerInvariant()] = @{ vmx = (Resolve-Path -LiteralPath $VMX).Path; password = $consolePassword }
}
$parent = Split-Path -Parent ([IO.Path]::GetFullPath($Path))
New-Item -ItemType Directory -Path $parent -Force | Out-Null
if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType File -Path $Path | Out-Null }
$fileInfo = [IO.FileInfo]::new([IO.Path]::GetFullPath($Path))
$acl = [IO.FileSystemAclExtensions]::GetAccessControl($fileInfo, [Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true, $false)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($rule in @($acl.Access)) { if ($null -ne $rule) { [void]$acl.RemoveAccessRuleSpecific($rule) } }
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow'))
[IO.FileSystemAclExtensions]::SetAccessControl($fileInfo, $acl)
[IO.File]::WriteAllText([IO.Path]::GetFullPath($Path), ($config | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Write-Output "Saved credentials with access limited to the current Windows user: $Path"
Write-Output 'Passwords were not printed. This file stores plaintext JSON protected by Windows file permissions.'
