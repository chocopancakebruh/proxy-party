const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { createCliAuth } = require('./CliAuth');

function setup(options = {}) {
  const home = 'C:\\Users\\Synthetic';
  const shell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const files = new Set([shell, ...['kimi', 'codex', 'grok', 'agy', 'mimo', 'muse'].map(command => `C:\\bin\\${command}.exe`)]);
  const calls = [];
  const children = [];
  const fs = { statSync(filename) { return { isFile: () => files.has(path.win32.normalize(filename)) }; },
    readFileSync() { throw new Error('Credential contents must never be read'); } };
  const env = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', ...options.env };
  const spawn = (command, args, settings) => {
    calls.push({ command, args, settings });
    if (options.throwSpawn) throw new Error('sensitive path and token should not reach the browser');
    const child = new EventEmitter();
    child.unrefCalls = 0;
    child.unref = () => { child.unrefCalls++; };
    child.kill = () => { throw new Error('Never terminate an interactive user login'); };
    children.push(child);
    if (options.spawnError) queueMicrotask(() => child.emit('error', new Error('sensitive spawn output')));
    else queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const auth = createCliAuth({ config: options.config || {}, fs, spawn, homeDir: home,
    process: { platform: options.platform || 'win32', env }, ...options.dependencies });
  const status = async id => (await auth.getStatuses()).find(provider => provider.id === id);
  const decode = index => {
    const monitor = Buffer.from(calls[index].args.at(-1), 'base64').toString('utf16le');
    const encoded = monitor.match(/'-EncodedCommand', '([^']+)'/)[1];
    return { monitor, login: Buffer.from(encoded, 'base64').toString('utf16le') };
  };
  return { auth, status, files, calls, children, decode, home, shell, env };
}

test('offline statuses expose only safe fixed fields without starting any command', async () => {
  const { auth, calls } = setup();
  const statuses = await auth.getStatuses();
  assert.deepEqual(statuses.map(provider => provider.id), ['kimi', 'codex', 'grok', 'argon', 'mimo', 'muse']);
  for (const status of statuses) {
    assert.equal(status.kind, 'cli');
    assert.equal(status.state, 'unknown');
    assert.equal(status.canReset, false);
    assert.equal(status.canRefresh, false);
    assert.equal(status.loginRunning, false);
    assert.equal(status.canLogin, status.id !== 'argon');
    assert.doesNotMatch(JSON.stringify(status), /C:\\|token|password/i);
  }
  assert.equal(calls.length, 0);
});

test('independent account login uses its supplied environment, official CLI and file-based Codex authentication', async () => {
  const env = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'D:\\profiles\\separate', CODEX_HOME: 'D:\\profiles\\separate\\.codex' };
  const harness = setup({ config: { kimi_command: 'C:\\adapters\\kimi-rp.exe' }, dependencies: {
    isolated: true, connectionLabel: "Personal 'account'", env, homeDir: env.USERPROFILE
  } });
  harness.files.add('C:\\adapters\\kimi-rp.exe');
  await harness.auth.login('kimi');
  await harness.auth.login('codex');
  assert.match(harness.decode(0).login, /& 'C:\\bin\\kimi.exe' 'login'/);
  assert.match(harness.decode(0).login, /Personal ''account''/);
  assert.match(harness.decode(1).login, /codex.exe' '-c' 'cli_auth_credentials_store="file"' 'login'/);
  for (const call of harness.calls) {
    assert.equal(call.settings.env, env);
    assert.equal(call.settings.cwd, env.USERPROFILE);
  }
  assert.deepEqual((await harness.auth.getStatuses({ providerId: 'codex' })).map(provider => provider.id), ['codex']);
});

test('both current and legacy Kimi credential locations are reported as saved, not authenticated', async () => {
  const harness = setup();
  for (const root of ['.kimi', '.kimi-code']) {
    const credential = path.win32.join(harness.home, root, 'credentials', 'kimi-code.json');
    harness.files.add(credential);
    const status = await harness.status('kimi');
    assert.equal(status.state, 'saved');
    assert.match(status.message, /contents.*expiry.*upstream acceptance have not been checked/);
    harness.files.delete(credential);
  }
  assert.equal((await harness.status('kimi')).state, 'unknown');
});

test('credential roots honor CLI environment overrides without leaking paths', async () => {
  const harness = setup({ env: { KIMI_SHARE_DIR: 'D:\\legacy', KIMI_CODE_HOME: 'D:\\current',
    CODEX_HOME: 'D:\\codex', GROK_HOME: 'D:\\grok', XDG_CONFIG_HOME: 'D:\\config', MIMOCODE_HOME: 'D:\\mimo' } });
  for (const filename of ['D:\\legacy\\credentials\\kimi-code.json', 'D:\\codex\\auth.json',
    'D:\\grok\\auth.json', 'D:\\config\\muse\\auth.json', 'D:\\mimo\\data\\auth.json']) harness.files.add(filename);
  const statuses = await harness.auth.getStatuses();
  assert.ok(statuses.filter(provider => !['argon', 'mimo'].includes(provider.id)).every(provider => provider.state === 'saved'));
  assert.equal(statuses.find(provider => provider.id === 'mimo').state, 'unknown');
  assert.doesNotMatch(JSON.stringify(statuses), /D:\\/);
});

test('environment credentials are present but never exposed or validated', async () => {
  const harness = setup({ env: { META_API_KEY: 'synthetic-meta-secret', XAI_API_KEY: 'synthetic-grok-secret', MIMOCODE_AUTH_CONTENT: 'synthetic-mimo-secret' } });
  const statuses = await harness.auth.getStatuses();
  for (const id of ['muse', 'grok']) assert.equal(statuses.find(provider => provider.id === id).state, 'saved');
  assert.equal(statuses.find(provider => provider.id === 'mimo').state, 'unknown');
  assert.doesNotMatch(JSON.stringify(statuses), /synthetic|secret/);
  assert.equal(harness.calls.length, 0);
});

test('Codex workload identity is not probed or replaced by interactive login', async () => {
  const harness = setup({ env: { OPENAI_FEDERATION_RULE_ID: 'synthetic-sensitive-rule' } });
  const status = await harness.status('codex');
  assert.equal(status.state, 'unknown');
  assert.equal(status.canLogin, false);
  assert.match(status.message, /Workload identity/);
  await assert.rejects(harness.auth.login('codex'), /not checked here/);
  assert.equal(harness.calls.length, 0);
});

test('missing binaries and configured invalid command lines are unavailable', async () => {
  const harness = setup({ config: { kimi_command: 'kimi --unsafe', codex_command: 'codex\nlogin' } });
  harness.files.delete('C:\\bin\\grok.exe');
  for (const id of ['kimi', 'codex', 'grok']) {
    const status = await harness.status(id);
    assert.equal(status.state, 'unavailable');
    assert.equal(status.canLogin, false);
    await assert.rejects(harness.auth.login(id), /CLI not found/);
  }
  assert.equal(harness.calls.length, 0);
});

test('fixed login allowlist rejects route or shell payloads', async () => {
  const harness = setup();
  for (const id of ['__proto__', 'constructor', 'codex; calc', 'kimi/login', {}, null]) {
    await assert.rejects(harness.auth.login(id), error => error.statusCode === 404);
  }
  await assert.rejects(harness.auth.login('argon'), /supported account controls/);
  assert.equal(harness.calls.length, 0);
});

test('Windows login uses a visible terminal with isolated fixed encoded arguments', async () => {
  const harness = setup();
  await harness.auth.login('kimi');
  const call = harness.calls[0];
  assert.equal(call.command, harness.shell);
  assert.equal(call.settings.shell, false);
  assert.equal(call.settings.windowsHide, true);
  assert.equal(call.settings.detached, true);
  assert.equal(call.settings.stdio, 'ignore');
  assert.equal(call.settings.env, harness.env);
  const { monitor, login } = harness.decode(0);
  assert.match(monitor, /Start-Process .* -WindowStyle Normal -PassThru/);
  assert.match(monitor, /\$terminal.WaitForExit\(\)/);
  assert.match(login, /& 'C:\\bin\\kimi.exe' 'login'/);
  assert.doesNotMatch(monitor, /NoExit/);
  assert.doesNotMatch(login, /NoExit/);
  assert.equal(harness.children[0].unrefCalls, 1);
});

test('configured executable paths with spaces and apostrophes are literal, not executable script', async () => {
  const command = "C:\\Users\\O'Neil\\CLI & tools\\kimi-rp.exe";
  const harness = setup({ config: { kimi_command: command } });
  harness.files.add(command);
  await harness.auth.login('kimi');
  assert.match(harness.decode(0).login, /& 'C:\\Users\\O''Neil\\CLI & tools\\kimi-rp.exe' 'login'/);
});

test('CLI-specific login arguments never contain a prompt or logout command', async () => {
  const harness = setup();
  for (const id of ['codex', 'grok', 'mimo', 'muse']) await harness.auth.login(id);
  assert.match(harness.decode(0).login, /codex.exe' 'login'/);
  assert.match(harness.decode(1).login, /grok.exe' 'login'/);
  assert.match(harness.decode(2).login, /mimo.exe' 'auth' 'login' '--provider' 'xiaomi'/);
  assert.match(harness.decode(3).login, /& 'C:\\bin\\muse.exe' ;/);
  for (let index = 0; index < 4; index++) assert.doesNotMatch(harness.decode(index).login, /--prompt|logout|auth set/);
});

test('MiMo account switching invokes official CLI directly even when chat uses MiMo RP', async () => {
  const harness = setup({ config: { mimo_command: 'C:\\mimo-rp\\mimo-rp.exe' } });
  harness.files.add('C:\\mimo-rp\\mimo-rp.exe');
  harness.files.delete('C:\\bin\\mimo.exe');
  harness.files.add('C:\\bin\\mimo.cmd');
  await harness.auth.login('mimo');
  assert.match(harness.decode(0).login, /& 'C:\\bin\\mimo.cmd' 'auth' 'login' '--provider' 'xiaomi'/);
  assert.doesNotMatch(harness.decode(0).login, /mimo-rp|Remove-Item|auth.json/);
  assert.match(harness.decode(0).monitor, /-WindowStyle Normal/);
});

test('MiMo can use a separate explicit account command with safe path quoting', async () => {
  const command = "C:\\Users\\O'Neil\\MiMo tools\\mimo.exe";
  const harness = setup({ config: { mimo_command: 'C:\\mimo-rp\\mimo-rp.exe', mimo_auth_command: command } });
  harness.files.add(command);
  harness.files.add('C:\\mimo-rp\\mimo-rp.exe');
  await harness.auth.login('mimo');
  assert.match(harness.decode(0).login, /& 'C:\\Users\\O''Neil\\MiMo tools\\mimo.exe' 'auth' 'login' '--provider' 'xiaomi'/);
});

test('missing official MiMo CLI never falls back to a chat adapter for login', async () => {
  const harness = setup({ config: { mimo_command: 'C:\\mimo-rp\\mimo-rp.exe' } });
  harness.files.add('C:\\mimo-rp\\mimo-rp.exe');
  harness.files.delete('C:\\bin\\mimo.exe');
  assert.equal((await harness.status('mimo')).canLogin, false);
  assert.match((await harness.status('mimo')).message, /Official MiMo CLI not found/);
  await assert.rejects(harness.auth.login('mimo'), /Official MiMo CLI not found/);
  assert.equal(harness.calls.length, 0);
});

test('failed interactive logins are reported after the monitor exits and retry clears the failure', async () => {
  const harness = setup();
  await harness.auth.login('mimo');
  harness.children[0].emit('exit', 1);
  assert.match((await harness.status('mimo')).message, /last sign-in attempt exited unsuccessfully/);
  assert.equal((await harness.status('mimo')).loginRunning, false);
  await harness.auth.login('mimo');
  assert.doesNotMatch((await harness.status('mimo')).message, /last sign-in attempt/);
  harness.children[0].emit('close', 1);
  assert.equal((await harness.status('mimo')).loginRunning, true);
  harness.children[1].emit('exit', 0);
  assert.doesNotMatch((await harness.status('mimo')).message, /last sign-in attempt/);
});

test('concurrent clicks launch one terminal and completion permits another login', async () => {
  const harness = setup();
  const results = await Promise.all([harness.auth.login('kimi'), harness.auth.login('kimi')]);
  assert.equal(harness.calls.length, 1);
  assert.match(results[1].message, /already open/);
  assert.equal((await harness.status('kimi')).loginRunning, true);
  harness.children[0].emit('exit', 0);
  assert.equal((await harness.status('kimi')).loginRunning, false);
  await harness.auth.login('kimi');
  assert.equal(harness.calls.length, 2);
  harness.children[0].emit('close', 0);
  assert.equal((await harness.status('kimi')).loginRunning, true);
});

test('credential changes appear while polling without completing or killing an open terminal', async () => {
  const harness = setup();
  await harness.auth.login('muse');
  harness.files.add(path.win32.join(harness.home, '.config', 'muse', 'auth.json'));
  const status = await harness.status('muse');
  assert.equal(status.state, 'saved');
  assert.equal(status.loginRunning, true);
  assert.match(status.message, /exit Muse when finished/);
  harness.children[0].emit('close', 0);
  assert.equal((await harness.status('muse')).loginRunning, false);
});

test('spawn errors are sanitized and release the duplicate-login guard', async () => {
  for (const options of [{ spawnError: true }, { throwSpawn: true }]) {
    const harness = setup(options);
    await assert.rejects(harness.auth.login('kimi'), error => {
      assert.doesNotMatch(error.message, /sensitive|token/);
      assert.equal(error.statusCode, 502);
      return true;
    });
    assert.equal((await harness.status('kimi')).loginRunning, false);
  }
});

test('shutdown does not terminate interactive terminals or permit new logins', async () => {
  const harness = setup();
  await harness.auth.login('grok');
  harness.auth.close();
  harness.auth.close();
  assert.equal((await harness.status('grok')).canLogin, false);
  await assert.rejects(harness.auth.login('grok'), /shutting down/);
  harness.children[0].emit('exit', 0);
  assert.equal((await harness.status('grok')).loginRunning, false);
});

test('non-Windows and missing PowerShell provide instructions without spawning', async () => {
  const harness = setup();
  harness.files.delete(harness.shell);
  assert.equal((await harness.status('kimi')).canLogin, false);
  await assert.rejects(harness.auth.login('kimi'), /kimi login/);
  const unix = setup({ platform: 'linux', dependencies: { homeDir: '/home/synthetic',
    fs: { statSync: filename => ({ isFile: () => filename === '/bin/kimi' }) }, env: { PATH: '/bin' } } });
  const status = await unix.status('kimi');
  assert.equal(status.canLogin, false);
  assert.match(status.message, /Login buttons require Windows/);
  await assert.rejects(unix.auth.login('kimi'), /use your terminal/);
  assert.equal(unix.calls.length, 0);
});
