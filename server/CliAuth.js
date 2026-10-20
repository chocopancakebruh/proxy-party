const childProcess = require('node:child_process');
const filesystem = require('node:fs');
const operatingSystem = require('node:os');
const paths = require('node:path');
const { requestError } = require('./HttpRequest');
const { createMimoAuth, credentialPath } = require('./MimoAuth');

const PROVIDERS = Object.freeze([
  { id: 'kimi', label: 'Kimi', command: 'kimi', args: ['login'], guidance: 'Run kimi login in your usual terminal.' },
  { id: 'codex', label: 'Codex', command: 'codex', args: ['login'], guidance: 'Run codex login in your usual terminal.' },
  { id: 'grok', label: 'Grok', command: 'grok', args: ['login'], guidance: 'Run grok login in your usual terminal.' },
  { id: 'argon', label: 'Argon', command: 'agy', guidance: 'Open Argon in your usual terminal and use its supported account controls.' },
  { id: 'mimo', label: 'MiMo', command: 'mimo', args: ['auth', 'login', '--provider', 'xiaomi'], guidance: 'Complete Xiaomi sign-in in your browser and choose the plan you want to use.' },
  { id: 'muse', label: 'Meta Muse', command: 'muse', args: [], guidance: 'Run muse, then choose sign-in or enter /login. Exit Muse after signing in.' }
]);

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createCliAuth(dependencies = {}) {
  const config = dependencies.config || {};
  const fs = dependencies.fs || filesystem;
  const os = dependencies.os || operatingSystem;
  const runtime = dependencies.process || process;
  const platform = dependencies.platform || runtime.platform;
  const path = dependencies.path || (platform === 'win32' ? paths.win32 : paths.posix);
  const spawn = dependencies.spawn || childProcess.spawn;
  const env = dependencies.env || runtime.env;
  const home = dependencies.homeDir || os.homedir();
  const providerDefinitions = PROVIDERS;
  const running = new Map();
  const loginFailures = new Set();
  let closed = false;
  const mimoAuth = createMimoAuth({ fs, environment, home, path,
    request: dependencies.mimoRequest, now: dependencies.now });

  function environment(name) {
    const key = platform === 'win32'
      ? Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase()) : name;
    return key && typeof env[key] === 'string' ? env[key] : '';
  }

  function isFile(filename) {
    try { return fs.statSync(filename).isFile(); } catch { return false; }
  }

  function resolveExecutable(value) {
    if (typeof value !== 'string' || /[\0\r\n]/.test(value)) return null;
    const command = value.trim().replace(/^"(.*)"$/, '$1');
    if (!command || command.startsWith('-')) return null;
    const extensions = platform === 'win32' && !path.extname(command)
      ? ['.exe', '.com', '.cmd', '.bat', '.ps1', ''] : [''];
    const explicitPath = path.isAbsolute(command) || /[\\/]/.test(command);
    if (!explicitPath && /\s/.test(command)) return null;
    const directories = explicitPath ? [''] : environment('PATH').split(path.delimiter).filter(Boolean);
    for (const directory of directories) {
      for (const extension of extensions) {
        const candidate = directory ? path.join(directory.replace(/^"(.*)"$/, '$1'), command + extension) : command + extension;
        if (isFile(candidate)) return path.resolve(candidate);
      }
    }
    return null;
  }

  function powershellPath() {
    return path.join(environment('SystemRoot') || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }

  function credentialFiles(id) {
    if (id === 'kimi') {
      return [environment('KIMI_CODE_HOME') || path.join(home, '.kimi-code'),
        environment('KIMI_SHARE_DIR') || path.join(home, '.kimi')]
        .map(root => path.join(root, 'credentials', 'kimi-code.json'));
    }
    if (id === 'codex') return [path.join(environment('CODEX_HOME') || path.join(home, '.codex'), 'auth.json')];
    if (id === 'grok') return [path.join(environment('GROK_HOME') || path.join(home, '.grok'), 'auth.json')];
    if (id === 'muse') return [path.join(environment('XDG_CONFIG_HOME') || path.join(home, '.config'), 'muse', 'auth.json')];
    if (id === 'mimo') {
      try { return [credentialPath({ environment, home, path })]; } catch { return []; }
    }
    return [];
  }

  function environmentAuth(id) {
    const variables = { grok: ['XAI_API_KEY'], muse: ['META_API_KEY'], mimo: ['MIMOCODE_AUTH_CONTENT'] };
    return (variables[id] || []).some(name => Boolean(environment(name).trim()));
  }

  function usesWorkloadIdentity(id) {
    return id === 'codex' && Boolean(environment('OPENAI_FEDERATION_RULE_ID') || environment('OPENAI_IDENTITY_TOKEN_FILE'));
  }

  function inspect(provider) {
    const executable = resolveExecutable(config[`${provider.id}_command`] || provider.command);
    // Chat adapters such as MiMo RP are not interactive account managers.
    // Keep the official sign-in executable independent of the request executable.
    const loginExecutable = provider.id === 'mimo' || dependencies.isolated
      ? resolveExecutable(config[`${provider.id}_auth_command`] || provider.command) : executable;
    const loginRunning = running.has(provider.id);
    const canLogin = Boolean(!closed && loginExecutable && provider.args && platform === 'win32' && isFile(powershellPath()) && !usesWorkloadIdentity(provider.id));
    const result = { id: provider.id, label: provider.label, kind: 'cli', state: 'unknown',
      message: '', canLogin, canReset: false, canRefresh: false, loginRunning };
    if (!executable) {
      result.state = 'unavailable';
      result.message = `CLI not found. Install it separately or set ${provider.id}_command to its executable path. ${provider.guidance}`;
    } else if (usesWorkloadIdentity(provider.id)) {
      result.message = 'Workload identity environment is configured. It is not checked here; interactive login is controlled by that environment.';
    } else if (environmentAuth(provider.id)) {
      result.state = 'saved';
      result.message = 'Credential environment is present and may override browser sign-in. Its value and upstream acceptance have not been checked; restart the proxy after changing the environment.';
    } else if (credentialFiles(provider.id).some(isFile)) {
      result.state = 'saved';
      result.message = 'A local credential file is present. Its contents, selected account, expiry, and upstream acceptance have not been checked.';
    } else {
      result.message = provider.id === 'argon'
        ? `CLI found; automatic account inspection is not supported. ${provider.guidance}`
        : `No standard credential file detected. The CLI may use a keychain or other configuration. ${provider.guidance}`;
    }
    if (platform !== 'win32' && executable) result.message += ' Login buttons require Windows; use your terminal.';
    if (loginRunning) result.message += provider.id === 'muse'
      ? ' A Muse sign-in terminal is open; exit Muse when finished.' : ' A sign-in terminal is open; complete or close it before trying again.';
    return { result, executable, loginExecutable };
  }

  async function login(id) {
    const provider = providerDefinitions.find(candidate => candidate.id === id);
    if (!provider) throw requestError('Unknown CLI provider', 404);
    if (closed) throw requestError('Account controls are shutting down', 503);
    if (running.has(id)) return { message: `${provider.label} sign-in is already open. Complete or close its terminal first.` };
    const { result, loginExecutable } = inspect(provider);
    if (id === 'mimo' && !loginExecutable) throw requestError('Official MiMo CLI not found for sign-in. Install MiMo Code or set mimo_auth_command to its executable; mimo_command remains the chat client.', 400);
    if (!result.canLogin) throw requestError(result.message || provider.guidance, 400);
    const shell = powershellPath();
    const title = `${dependencies.connectionLabel || provider.label} sign-in - Claude Code Proxy`;
    const loginScript = [
      '$ErrorActionPreference = \'Stop\'',
      `$Host.UI.RawUI.WindowTitle = ${literal(title)}`,
      `Write-Host ${literal(provider.guidance)}`,
      '$exitCode = 0',
      `try { & ${literal(loginExecutable)} ${(dependencies.isolated && id === 'codex' ? ['-c', 'cli_auth_credentials_store="file"', ...provider.args] : provider.args).map(literal).join(' ')}; if ($null -ne $LASTEXITCODE) { $exitCode = $LASTEXITCODE } }`,
      `catch { Write-Host ${literal('The CLI could not start. Check its installation and configured executable path.')}; $exitCode = 1 }`,
      "if ($exitCode -ne 0) { Read-Host 'Sign-in did not complete. Press Enter to close' | Out-Null }",
      'exit $exitCode'
    ].join('\n');
    const encodedLogin = Buffer.from(loginScript, 'utf16le').toString('base64');
    const monitorScript = [
      '$ErrorActionPreference = \'Stop\'',
      `$terminal = Start-Process -FilePath ${literal(shell)} -ArgumentList @('-NoLogo', '-NoProfile', '-EncodedCommand', ${literal(encodedLogin)}) -WindowStyle Normal -PassThru`,
      '$terminal.WaitForExit()',
      'exit $terminal.ExitCode'
    ].join('\n');
    const entry = {};
    loginFailures.delete(id);
    running.set(id, entry);
    try {
      const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(monitorScript, 'utf16le').toString('base64')], {
        cwd: home, env, shell: false, windowsHide: true, detached: true, stdio: 'ignore'
      });
      entry.child = child;
      const clear = failed => {
        if (running.get(id) !== entry) return;
        running.delete(id);
        if (failed) loginFailures.add(id);
      };
      child.on('error', () => clear(true));
      child.once('exit', code => clear(code !== 0));
      child.once('close', code => clear(code !== 0));
      await new Promise((resolve, reject) => {
        const failed = () => { child.off('spawn', started); reject(requestError('The sign-in terminal could not be opened', 502)); };
        const started = () => { child.off('error', failed); resolve(); };
        child.once('error', failed);
        child.once('spawn', started);
      });
      child.unref?.();
      return { message: `${provider.label} sign-in launch requested. Look for its separate terminal. ${provider.guidance} Status updates automatically; no restart is needed.` };
    } catch (error) {
      if (running.get(id) === entry) running.delete(id);
      throw requestError('The sign-in terminal could not be opened. Check the CLI installation and Windows PowerShell.', 502);
    }
  }

  return {
    async getStatuses(options = {}) {
      return Promise.all(providerDefinitions.filter(provider => !options.providerId || provider.id === options.providerId).map(async provider => {
        const { result, executable, loginExecutable } = inspect(provider);
        if (provider.id === 'mimo' && executable) Object.assign(result, await mimoAuth.getStatus(options));
        if (provider.id === 'mimo' && !loginExecutable) result.message += ' Official MiMo CLI not found for sign-in. Install MiMo Code or set mimo_auth_command to its executable.';
        if (loginFailures.has(provider.id)) result.message += ' The last sign-in attempt exited unsuccessfully. Run the official CLI in a terminal to see the error.';
        return result;
      }));
    },
    login,
    close() { closed = true; mimoAuth.close(); for (const entry of running.values()) entry.child?.unref?.(); }
  };
}

module.exports = { createCliAuth };
