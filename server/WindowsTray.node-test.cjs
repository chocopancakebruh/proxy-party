const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const trayPath = path.join(root, 'windows', 'ProxyTray.ps1');
const startupPath = path.join(root, 'windows', 'SetStartup.ps1');
const tray = fs.readFileSync(trayPath, 'utf8');
const startup = fs.readFileSync(startupPath, 'utf8');
const windowsOnly = { skip: process.platform !== 'win32' };
const quote = value => `'${value.replaceAll("'", "''")}'`;

function powershell(source) {
  const candidates = [process.env.PROXY_TEST_POWERSHELL,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
  const command = candidates.find(candidate => candidate && fs.existsSync(candidate));
  const script = `$ErrorActionPreference = 'Stop'\n${source}`;
  const result = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 15000, encoding: 'utf8', maxBuffer: 1024 * 1024
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('tray scripts parse with Windows PowerShell without executing their entry points', windowsOnly, () => {
  const output = powershell(`
    foreach ($filename in @(${quote(trayPath)}, ${quote(startupPath)})) {
      $tokens = $null
      $errors = $null
      [void][Management.Automation.Language.Parser]::ParseFile($filename, [ref]$tokens, [ref]$errors)
      if ($errors.Count) { throw 'PowerShell syntax errors' }
    }
    'parsed'
  `);
  assert.equal(output, 'parsed');
});

test('installation identity is case-insensitive, path-specific and does not expose a path', windowsOnly, () => {
  const syntheticRoot = "C:\\Synthetic Folder\\O'Neil\\Proxy";
  const expected = createHash('sha256').update(syntheticRoot.toLowerCase()).digest('hex').slice(0, 16);
  const output = powershell(`
    . ${quote(startupPath)}
    $first = Get-ProxyInstallationId ${quote(syntheticRoot)}
    $second = Get-ProxyInstallationId ${quote(syntheticRoot.toUpperCase() + '\\')}
    if ($first -ne $second) { throw 'Identity normalization differs' }
    if ($first -eq (Get-ProxyInstallationId 'C:\\Another Proxy')) { throw 'Identity is not path-specific' }
    $first
  `);
  assert.equal(output, expected);
});

test('startup description targets hidden STA PowerShell and preserves full Node path', windowsOnly, () => {
  const output = powershell(`
    . ${quote(startupPath)}
    Get-ProxyStartupDetails 'C:\\Synthetic Folder\\Proxy' ${quote(process.execPath)} | ConvertTo-Json -Compress
  `);
  const details = JSON.parse(output);
  assert.match(details.Path, /Proxy Party-[a-f0-9]{16}\.lnk$/);
  assert.match(details.LegacyPath, /Claude Code Proxy-[a-f0-9]{16}\.lnk$/);
  assert.match(details.Target, /\\(?:pwsh|powershell)\.exe$/i);
  assert.ok(details.Arguments.includes('-NoLogo -NoProfile -STA -WindowStyle Hidden'));
  assert.ok(details.Arguments.includes('-File "C:\\Synthetic Folder\\Proxy\\windows\\ProxyTray.ps1" -Startup'));
  assert.ok(details.Arguments.includes(`-NodePath "${process.execPath}"`));
  assert.doesNotMatch(details.Arguments, /ExecutionPolicy|Bypass|password|token|api.?key/i);
});

test('library import does not launch Node, create a tray icon, or modify Startup', windowsOnly, () => {
  const output = powershell(`
    function Set-ProxyStartup { throw 'Startup must not be modified' }
    . ${quote(trayPath)} -NodePath ${quote(process.execPath)}
    if ($null -ne $script:Owned -or $null -ne $script:Notify -or $null -ne $script:Mutex) { throw 'Import created a live resource' }
    if ($NodePath -ne ${quote(process.execPath)}) { throw 'NodePath was lost while importing helpers' }
    'imported safely'
  `);
  assert.equal(output, 'imported safely');
});

test('startup rename preserves an enabled launcher and refuses foreign shortcuts', windowsOnly, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-party-startup-test-'));
  try {
    const output = powershell(`
      . ${quote(startupPath)}
      $originalDetails = (Get-Command Get-ProxyStartupDetails).ScriptBlock
      function Get-ProxyStartupDetails {
        param([string]$Root, [string]$Executable, [string]$HostExecutable)
        $details = & $originalDetails $Root $Executable $HostExecutable
        $details.Path = Join-Path ${quote(tempRoot)} 'Proxy Party.lnk'
        $details.LegacyPath = Join-Path ${quote(tempRoot)} 'Claude Code Proxy.lnk'
        return $details
      }
      $details = Get-ProxyStartupDetails ${quote(root)} ${quote(process.execPath)}
      $shell = New-Object -ComObject WScript.Shell
      try {
        $legacy = $shell.CreateShortcut($details.LegacyPath)
        try {
          $legacy.TargetPath = $details.Target
          $legacy.Arguments = $details.Arguments
          $legacy.Save()
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($legacy) }
        if (-not (Test-ProxyStartup ${quote(root)})) { throw 'Legacy startup was not recognized' }
        Set-ProxyStartup ${quote(root)} $true ${quote(process.execPath)}
        if (-not (Test-ProxyStartup ${quote(root)}) -or (Test-Path -LiteralPath $details.LegacyPath)) { throw 'Startup migration failed' }
        $renamed = $shell.CreateShortcut($details.Path)
        try {
          if ($renamed.Description -ne 'Proxy Party tray (this Windows user only)' -or $renamed.Arguments -ne $details.Arguments) { throw 'Startup launch settings changed' }
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($renamed) }
        Set-ProxyStartup ${quote(root)} $false
        if (Test-Path -LiteralPath $details.Path) { throw 'Disabling the renamed shortcut failed' }
        $foreign = $shell.CreateShortcut($details.LegacyPath)
        try {
          $foreign.TargetPath = ${quote(process.execPath)}
          $foreign.Arguments = 'foreign-launcher'
          $foreign.Save()
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($foreign) }
        foreach ($enabled in @($true, $false)) {
          $rejected = $false
          try { Set-ProxyStartup ${quote(root)} $enabled ${quote(process.execPath)} } catch { $rejected = $true }
          if (-not $rejected -or -not (Test-Path -LiteralPath $details.LegacyPath) -or (Test-Path -LiteralPath $details.Path)) { throw 'Foreign shortcut was not protected' }
        }
      } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
      'migration and ownership verified'
    `);
    assert.equal(output, 'migration and ownership verified');
  } finally {
    const expectedParent = path.resolve(os.tmpdir());
    if (path.dirname(path.resolve(tempRoot)) !== expectedParent ||
        !path.basename(tempRoot).startsWith('proxy-party-startup-test-')) throw new Error('Unexpected test directory');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('process configuration drains output and keeps Node hidden without redirecting to a file', windowsOnly, () => {
  const output = powershell(`
    . ${quote(trayPath)}
    $info = New-ProxyProcessInfo ${quote(process.execPath)} 'synthetic-argument'
    if ($info.UseShellExecute -or -not $info.CreateNoWindow -or -not $info.RedirectStandardOutput -or -not $info.RedirectStandardError) { throw 'Unsafe child process flags' }
    if ($info.WindowStyle -ne [Diagnostics.ProcessWindowStyle]::Hidden) { throw 'Child is not hidden' }
    'hidden and redirected'
  `);
  assert.equal(output, 'hidden and redirected');
});

test('stopping without ownership never inspects or kills another process', windowsOnly, () => {
  const output = powershell(`
    . ${quote(trayPath)}
    function Get-ProxyHealth { throw 'No health lookup is needed without ownership' }
    if (-not (Stop-Proxy)) { throw 'Stopping a non-owned proxy should be a no-op' }
    'no-op'
  `);
  assert.equal(output, 'no-op');
});

test('a closed Windows loopback port is absent rather than a false collision', windowsOnly, () => {
  const output = powershell(`
    . ${quote(trayPath)}
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $script:Settings = @{ healthUrl = "http://127.0.0.1:$port/health" }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $health = Get-ProxyHealth
    @{ state = $health.State; elapsed = $watch.ElapsedMilliseconds } | ConvertTo-Json -Compress
  `);
  const result = JSON.parse(output);
  assert.equal(result.state, 'absent');
  assert.ok(result.elapsed < 10000);
});

test('owned process exits via stdin shutdown and releases ownership', windowsOnly, () => {
  const output = powershell(`
    . ${quote(trayPath)}
    $inputSink = New-Object IO.StringWriter
    $script:Owned = [pscustomobject]@{ HasExited = $false; StandardInput = $inputSink; Waited = 0; Disposed = $false }
    $script:Owned | Add-Member ScriptMethod WaitForExit { param($milliseconds) $this.Waited = $milliseconds; $this.HasExited = $true; return $true }
    $script:Owned | Add-Member ScriptMethod Dispose { $this.Disposed = $true }
    function Get-ProxyHealth { return @{ State = 'matching'; Active = 0 } }
    $child = $script:Owned
    if (-not (Stop-Proxy)) { throw 'Graceful stop failed' }
    if ($inputSink.ToString().Trim() -ne 'shutdown' -or $child.Waited -ne 8000 -or -not $child.Disposed -or $null -ne $script:Owned) { throw 'Lifecycle mismatch' }
    'stopped owned process'
  `);
  assert.equal(output, 'stopped owned process');
});

test('launcher has no policy bypass and startup removal names one literal file', () => {
  const launcher = fs.readFileSync(path.join(root, 'run-tray.bat'), 'utf8');
  assert.match(launcher, /-STA -WindowStyle Hidden -File "%~dp0windows\\ProxyTray\.ps1"/);
  assert.doesNotMatch(tray + startup + launcher, /ExecutionPolicy\s+Bypass|Set-ExecutionPolicy|ReadToEndAsync|Out-File|Start-Transcript/i);
  assert.match(startup, /Remove-Item -LiteralPath \$details.Path -ErrorAction Stop/);
  assert.doesNotMatch(startup, /Remove-Item[^\r\n]*-Recurse/);
  assert.match(tray, /StandardOutput.BaseStream.CopyToAsync\(\[IO.Stream\]::Null\)/);
  assert.match(tray, /StandardError.BaseStream.CopyToAsync\(\[IO.Stream\]::Null\)/);
  assert.match(tray, /CLAUDE_PROXY_TRAY_ID/);
  assert.match(tray, /if \(-not \$Startup\)/);
});
