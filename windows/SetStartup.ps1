param(
    [switch]$Enable,
    [switch]$Disable,
    [switch]$Status,
    [string]$NodePath,
    [string]$PowerShellPath
)

function Get-ProxyInstallationId {
    param([string]$Root)
    $normalized = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]'\/').ToLowerInvariant()
    $digest = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized))
        return ([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()).Substring(0, 16)
    } finally { $digest.Dispose() }
}

function Resolve-ProxyNode {
    param([string]$Executable)
    if ([string]::IsNullOrWhiteSpace($Executable)) {
        $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $command) { throw 'Node.js was not found. Install Node.js 22 or newer, then reopen the launcher.' }
        $Executable = $command.Source
    }
    if ($Executable.IndexOfAny([char[]]"`0`r`n`"") -ge 0) { throw 'The Node.js executable path is invalid.' }
    $resolved = [IO.Path]::GetFullPath($Executable)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf) -or [IO.Path]::GetExtension($resolved) -ne '.exe') {
        throw 'The configured Node.js executable could not be found.'
    }
    return $resolved
}

function Resolve-ProxyPowerShell {
    param([string]$Executable)
    if (-not [string]::IsNullOrWhiteSpace($Executable)) {
        if ($Executable.IndexOfAny([char[]]"`0`r`n`"") -ge 0) { throw 'The PowerShell executable path is invalid.' }
        $resolved = [IO.Path]::GetFullPath($Executable)
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf) -or [IO.Path]::GetFileName($resolved) -notin @('powershell.exe', 'pwsh.exe')) {
            throw 'The configured PowerShell executable could not be found.'
        }
        return $resolved
    }
    $current = Join-Path $PSHOME 'pwsh.exe'
    if (Test-Path -LiteralPath $current -PathType Leaf) { return $current }
    $command = Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) { return $command.Source }
    if ($env:ProgramFiles) {
        $installed = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
        if (Test-Path -LiteralPath $installed -PathType Leaf) { return $installed }
    }
    if ($env:USERPROFILE) {
        $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe'
        if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    }
    $windows = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $windows -PathType Leaf) { return $windows }
    throw 'PowerShell could not be found. Install PowerShell 7 before enabling startup.'
}

function Get-ProxyStartupDetails {
    param([string]$Root, [string]$Executable, [string]$HostExecutable)
    $rootPath = [IO.Path]::GetFullPath($Root)
    $startup = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    if ([string]::IsNullOrWhiteSpace($startup)) { throw 'The per-user Windows Startup folder is unavailable.' }
    $identity = Get-ProxyInstallationId $rootPath
    $shortcut = [IO.Path]::GetFullPath((Join-Path $startup "Claude Code Proxy-$identity.lnk"))
    if ([IO.Path]::GetDirectoryName($shortcut) -ne [IO.Path]::GetFullPath($startup).TrimEnd('\')) {
        throw 'The Startup shortcut path is invalid.'
    }
    $shell = Resolve-ProxyPowerShell $HostExecutable
    $trayScript = Join-Path $rootPath 'windows\ProxyTray.ps1'
    $arguments = '-NoLogo -NoProfile -STA -WindowStyle Hidden -File "' + $trayScript + '" -Startup'
    if (-not [string]::IsNullOrWhiteSpace($Executable)) { $arguments += ' -NodePath "' + $Executable + '"' }
    return @{ Path = $shortcut; Target = $shell; Arguments = $arguments; Root = $rootPath; Script = $trayScript }
}

function Test-ProxyStartup {
    param([string]$Root, [string]$HostExecutable)
    $details = Get-ProxyStartupDetails $Root '' $HostExecutable
    if (-not (Test-Path -LiteralPath $details.Path -PathType Leaf)) { return $false }
    $shell = New-Object -ComObject WScript.Shell
    try {
        $shortcut = $shell.CreateShortcut($details.Path)
        try {
            $argumentPattern = '^' + [Regex]::Escape($details.Arguments) + '(?: -NodePath "[^"\r\n]+")?$'
            return $shortcut.TargetPath -eq $details.Target -and $shortcut.Arguments -match $argumentPattern
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}

function Set-ProxyStartup {
    param([string]$Root, [bool]$Enabled, [string]$Executable, [string]$HostExecutable)
    $details = Get-ProxyStartupDetails $Root $Executable $HostExecutable
    if ((Test-Path -LiteralPath $details.Path) -and -not (Test-ProxyStartup $Root $HostExecutable)) {
        throw 'The named Startup shortcut does not belong to this installation. It was not changed.'
    }
    if (-not $Enabled) {
        if (Test-Path -LiteralPath $details.Path -PathType Leaf) { Remove-Item -LiteralPath $details.Path -ErrorAction Stop }
        return
    }
    $resolvedNode = Resolve-ProxyNode $Executable
    $details = Get-ProxyStartupDetails $Root $resolvedNode $HostExecutable
    if (-not (Test-Path -LiteralPath $details.Script -PathType Leaf)) { throw 'The tray script could not be found.' }
    $shell = New-Object -ComObject WScript.Shell
    try {
        $shortcut = $shell.CreateShortcut($details.Path)
        try {
            $shortcut.TargetPath = $details.Target
            $shortcut.Arguments = $details.Arguments
            $shortcut.WorkingDirectory = $details.Root
            $shortcut.WindowStyle = 7
            $shortcut.Description = 'Claude Code Proxy tray (this Windows user only)'
            $shortcut.Save()
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    $root = Split-Path -Parent $PSScriptRoot
    if (([int]$Enable.IsPresent + [int]$Disable.IsPresent + [int]$Status.IsPresent) -ne 1) {
        throw 'Choose exactly one action: -Enable, -Disable, or -Status.'
    }
    if ($Status) { Test-ProxyStartup $root $PowerShellPath }
    else { Set-ProxyStartup $root $Enable.IsPresent $NodePath $PowerShellPath }
}
