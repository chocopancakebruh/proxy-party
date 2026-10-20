param([switch]$Startup, [string]$NodePath)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SetStartup.ps1') -NodePath $NodePath
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:Root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$script:Identity = Get-ProxyInstallationId $script:Root
$script:Owned = $null
$script:Settings = $null
$script:LastHealth = $null
$script:PendingBrowser = -not $Startup
$script:StartupDeadline = $null
$script:Busy = $false
$script:Notify = $null
$script:Timer = $null
$script:Mutex = $null
$script:OwnsMutex = $false
$script:Menu = $null

function Show-ProxyError {
    param([string]$Message)
    [void][Windows.Forms.MessageBox]::Show($Message, 'Claude Code Proxy', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error)
}

function New-ProxyProcessInfo {
    param([string]$Executable, [string]$Arguments)
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.Arguments = $Arguments
    $info.WorkingDirectory = $script:Root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    return $info
}

function Read-ProxySettings {
    $helper = Join-Path $script:Root 'server\tray-server.js'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'The tray server helper is missing. Reinstall the proxy launcher files.' }
    $probe = New-Object Diagnostics.Process
    $probe.StartInfo = New-ProxyProcessInfo $script:Node ('"' + $helper + '" --settings')
    try {
        if (-not $probe.Start()) { throw 'The proxy settings helper could not start.' }
        [void]$probe.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
        $buffer = New-Object char[] 8193
        $read = $probe.StandardOutput.ReadBlockAsync($buffer, 0, $buffer.Length)
        if (-not $probe.WaitForExit(5000)) {
            $probe.Kill()
            throw 'Reading proxy settings timed out.'
        }
        if ($probe.ExitCode -ne 0 -or -not $read.Wait(1000) -or $read.Result -lt 1 -or $read.Result -gt 8192) { throw 'Proxy settings could not be loaded. Check server/config.txt.' }
        $settings = (-join $buffer[0..($read.Result - 1)]) | ConvertFrom-Json
        $port = 0
        if (-not [int]::TryParse([string]$settings.port, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
            throw 'The proxy port must be between 1 and 65535.'
        }
        $health = [Uri]$settings.healthUrl
        $dashboard = [Uri]$settings.dashboardUrl
        if ($health.Scheme -ne 'http' -or -not $health.IsLoopback -or $health.Port -ne $port -or $health.AbsolutePath -ne '/health' -or
            $dashboard.Scheme -ne 'http' -or -not $dashboard.IsLoopback -or $dashboard.Port -ne $port -or $dashboard.AbsolutePath -ne '/dashboard/' -or
            $health.UserInfo -or $dashboard.UserInfo -or $health.Query -or $dashboard.Query -or $health.Fragment -or $dashboard.Fragment) {
            throw 'Tray mode requires a localhost dashboard and health URL.'
        }
        return $settings
    } finally { $probe.Dispose() }
}

function Get-ProxyHealth {
    if ($null -eq $script:Settings) { return @{ State = 'absent'; Active = 0 } }
    $request = [Net.HttpWebRequest]::Create($script:Settings.healthUrl)
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 4000
    $request.ReadWriteTimeout = 1000
    $response = $null
    try {
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200 -or $response.ContentLength -gt 8192) { return @{ State = 'foreign'; Active = 0 } }
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        try {
            $buffer = New-Object char[] 8193
            $length = $reader.ReadBlock($buffer, 0, $buffer.Length)
            if ($length -lt 1 -or $length -gt 8192) { return @{ State = 'foreign'; Active = 0 } }
            $health = (-join $buffer[0..($length - 1)]) | ConvertFrom-Json
        } finally { $reader.Dispose() }
        $active = 0
        if ($health.server -eq 'claude-code-proxy' -and $health.status -eq 'ok' -and $health.instanceId -ceq $script:Identity -and
            [int]::TryParse([string]$health.activeRequests, [ref]$active) -and $active -ge 0 -and $health.dashboard -eq $true) {
            return @{ State = 'matching'; Active = $active }
        }
        return @{ State = 'foreign'; Active = 0 }
    } catch [Net.WebException] {
        if ($null -ne $_.Exception.Response) { $_.Exception.Response.Dispose() }
        $failure = $_.Exception
        while ($null -ne $failure) {
            if ($failure -is [Net.Sockets.SocketException] -and $failure.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) {
                return @{ State = 'absent'; Active = 0 }
            }
            $failure = $failure.InnerException
        }
        return @{ State = 'foreign'; Active = 0 }
    } catch { return @{ State = 'foreign'; Active = 0 } }
    finally { if ($null -ne $response) { $response.Dispose() } }
}

function Test-ProxyOwned {
    if ($null -eq $script:Owned) { return $false }
    if ($script:Owned.HasExited) {
        $script:Owned.Dispose()
        $script:Owned = $null
        return $false
    }
    return $true
}

function Open-ProxyDashboard {
    $health = Get-ProxyHealth
    if ($health.State -ne 'matching') { Show-ProxyError 'The configured port is not serving this tray-managed proxy. Start the proxy or close the conflicting server first.'; return }
    $browser = New-Object Diagnostics.ProcessStartInfo
    $browser.FileName = $script:Settings.dashboardUrl
    $browser.UseShellExecute = $true
    [void][Diagnostics.Process]::Start($browser)
}

function Start-Proxy {
    if (Test-ProxyOwned) { return }
    try {
        $script:Settings = Read-ProxySettings
        $health = Get-ProxyHealth
        if ($health.State -eq 'matching') {
            if ($script:PendingBrowser) { $script:PendingBrowser = $false; Open-ProxyDashboard }
            return
        }
        if ($health.State -ne 'absent') { Show-ProxyError 'Another server occupies the configured port. The tray will not stop or replace a server it does not own.'; return }
        $child = New-Object Diagnostics.Process
        $child.StartInfo = New-ProxyProcessInfo $script:Node ('"' + (Join-Path $script:Root 'server\tray-server.js') + '"')
        $child.StartInfo.RedirectStandardInput = $true
        $child.StartInfo.EnvironmentVariables['CLAUDE_PROXY_TRAY_ID'] = $script:Identity
        if (-not $child.Start()) { $child.Dispose(); throw 'The proxy could not start.' }
        $script:Owned = $child
        [void]$child.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
        [void]$child.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
        $script:StartupDeadline = [DateTime]::UtcNow.AddSeconds(15)
    } catch { Show-ProxyError 'The proxy could not start. Check Node.js and server/config.txt, or run run.bat to view startup errors.' }
}

function Stop-Proxy {
    if (-not (Test-ProxyOwned)) { return $true }
    $health = Get-ProxyHealth
    if ($health.Active -gt 0 -or $health.State -ne 'matching') {
        $message = if ($health.State -eq 'matching') { "There are $($health.Active) active requests. Stop the proxy and interrupt them?" } else { 'Active request status is unavailable. Stop this owned proxy? Requests may be interrupted.' }
        $answer = [Windows.Forms.MessageBox]::Show($message, 'Stop proxy?', [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Warning)
        if ($answer -ne [Windows.Forms.DialogResult]::Yes) { return $false }
    }
    $script:StartupDeadline = $null
    $script:PendingBrowser = $false
    try { $script:Owned.StandardInput.WriteLine('shutdown'); $script:Owned.StandardInput.Flush() } catch {}
    if (-not $script:Owned.WaitForExit(8000)) {
        $answer = [Windows.Forms.MessageBox]::Show('The proxy has not stopped. Force-stop only this tray-owned process and its child processes?', 'Force stop?', [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Warning)
        if ($answer -ne [Windows.Forms.DialogResult]::Yes) { return $false }
        if (Test-ProxyOwned) {
            $killer = New-Object Diagnostics.Process
            $killer.StartInfo = New-ProxyProcessInfo (Join-Path $env:SystemRoot 'System32\taskkill.exe') ('/PID ' + $script:Owned.Id + ' /T /F')
            try {
                if ($killer.Start()) {
                    [void]$killer.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
                    [void]$killer.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
                    if (-not $killer.WaitForExit(3000)) { $killer.Kill() }
                }
            } finally { $killer.Dispose() }
            if (-not $script:Owned.WaitForExit(3000)) { Show-ProxyError 'The owned proxy is still running. The tray will stay open so you can try stopping it again.'; return $false }
        }
    }
    [void](Test-ProxyOwned)
    return $true
}

function Update-ProxyTray {
    if ($script:Busy) { return }
    $owned = Test-ProxyOwned
    $health = Get-ProxyHealth
    $script:LastHealth = $health
    $script:StartItem.Enabled = -not $owned -and $health.State -eq 'absent'
    $script:StopItem.Enabled = $owned
    $script:OpenItem.Enabled = $health.State -eq 'matching'
    $description = if ($health.State -eq 'matching') {
        if ($owned) { "Running - $($health.Active) active" } else { 'Running elsewhere - not owned' }
    } elseif ($owned) { 'Starting or unavailable' } elseif ($health.State -eq 'foreign') { 'Port occupied by another server' } else { 'Stopped' }
    $script:StatusItem.Text = $description
    $script:Notify.Text = "Claude Code Proxy - $description"
    if ($null -ne $script:StartupDeadline) {
        if ($health.State -eq 'matching' -and $owned) {
            $script:StartupDeadline = $null
            if ($script:PendingBrowser) { $script:PendingBrowser = $false; Open-ProxyDashboard }
        } elseif (-not $owned -or [DateTime]::UtcNow -gt $script:StartupDeadline) {
            $script:StartupDeadline = $null
            Show-ProxyError 'The proxy did not become ready. Check server/config.txt and Node.js. No server output was saved.'
        }
    }
}

if ($MyInvocation.InvocationName -eq '.') { return }

try {
    if ([Threading.Thread]::CurrentThread.ApartmentState -ne [Threading.ApartmentState]::STA) { throw 'Launch the tray using run-tray.bat or PowerShell -STA.' }
    $script:Node = Resolve-ProxyNode $NodePath
    $script:Settings = Read-ProxySettings
    $created = $false
    $script:Mutex = New-Object Threading.Mutex($true, "Local\ClaudeCodeProxyTray-$($script:Identity)", [ref]$created)
    if (-not $created) {
        if (-not $Startup) { Open-ProxyDashboard }
        return
    }
    $script:OwnsMutex = $true
    [Windows.Forms.Application]::EnableVisualStyles()
    $menu = New-Object Windows.Forms.ContextMenuStrip
    $script:Menu = $menu
    $script:StatusItem = $menu.Items.Add('Starting')
    $script:StatusItem.Enabled = $false
    [void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
    $script:OpenItem = $menu.Items.Add('Open Dashboard')
    $script:OpenItem.add_Click({ try { Open-ProxyDashboard } catch { Show-ProxyError 'The dashboard could not be opened.' } })
    $script:StartItem = $menu.Items.Add('Start proxy')
    $script:StartItem.add_Click({ $script:Busy = $true; try { Start-Proxy } finally { $script:Busy = $false }; Update-ProxyTray })
    $script:StopItem = $menu.Items.Add('Stop proxy')
    $script:StopItem.add_Click({ $script:Busy = $true; try { [void](Stop-Proxy) } catch { Show-ProxyError 'The owned proxy could not be stopped.' } finally { $script:Busy = $false }; Update-ProxyTray })
    [void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
    $script:StartupItem = New-Object Windows.Forms.ToolStripMenuItem('Start with Windows')
    $script:StartupItem.Checked = Test-ProxyStartup $script:Root
    $script:StartupItem.add_Click({
        try { Set-ProxyStartup $script:Root (-not $script:StartupItem.Checked) $script:Node; $script:StartupItem.Checked = Test-ProxyStartup $script:Root }
        catch { Show-ProxyError 'The per-user Startup shortcut could not be changed. No execution policy was modified.' }
    })
    [void]$menu.Items.Add($script:StartupItem)
    $exitItem = $menu.Items.Add('Exit tray')
    $exitItem.add_Click({
        $script:Busy = $true
        try { if (Stop-Proxy) { [Windows.Forms.Application]::ExitThread() } }
        catch { Show-ProxyError 'The owned proxy could not be stopped. The tray is still open.' }
        finally { $script:Busy = $false }
    })
    $script:Notify = New-Object Windows.Forms.NotifyIcon
    $script:Notify.Icon = [Drawing.SystemIcons]::Application
    $script:Notify.ContextMenuStrip = $menu
    $script:Notify.Text = 'Claude Code Proxy'
    $script:Notify.Visible = $true
    $script:Notify.add_DoubleClick({ try { Open-ProxyDashboard } catch { Show-ProxyError 'The dashboard could not be opened.' } })
    $script:Timer = New-Object Windows.Forms.Timer
    $script:Timer.Interval = 3000
    $script:Timer.add_Tick({ try { Update-ProxyTray } catch { $script:StatusItem.Text = 'Status unavailable' } })
    Start-Proxy
    Update-ProxyTray
    $script:Timer.Start()
    [Windows.Forms.Application]::Run()
} catch {
    Show-ProxyError 'The tray could not start. Check Node.js 22+, server/config.txt, and that all launcher files are installed. Use run-tray.bat to launch it.'
} finally {
    if (Test-ProxyOwned) {
        try {
            $script:Owned.StandardInput.WriteLine('shutdown')
            $script:Owned.StandardInput.Flush()
            $script:Owned.StandardInput.Close()
            if ($script:Owned.WaitForExit(8000)) { $script:Owned.Dispose(); $script:Owned = $null }
        } catch {}
    }
    if ($null -ne $script:Timer) { $script:Timer.Stop(); $script:Timer.Dispose() }
    if ($null -ne $script:Notify) { $script:Notify.Visible = $false; $script:Notify.Dispose() }
    if ($null -ne $script:Menu) { $script:Menu.Dispose() }
    if ($script:OwnsMutex) { $script:Mutex.ReleaseMutex() }
    if ($null -ne $script:Mutex) { $script:Mutex.Dispose() }
}
