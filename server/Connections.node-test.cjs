const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');
const { createConnectionRegistry, CATALOG, connectionPath } = require('./ConnectionRegistry');
const { profileEnvironment } = require('./ConnectionProfiles');
const { createServer } = require('./server');
const { OAuthManager } = require('./OAuthManager');

const quiet = { info() {}, error() {}, debug() {}, warn() {} };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-connections-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'connections.json');
  const profilesDir = path.join(root, 'profiles');
  const config = { host: '127.0.0.1', mimo_model: 'xiaomi/mimo-v2.6-pro', codex_model: 'test-model', fallback_to_claude_code: true };
  const registry = createConnectionRegistry({ filename, profilesDir, config });
  return { root, filename, profilesDir, config, registry };
}

async function serverFixture(t, extraConfig = {}) {
  const result = fixture(t);
  Object.assign(result.config, extraConfig);
  const accounts = Object.fromEntries(['claude1', 'claude2'].map(id => [id, {
    id, label: id, authBase: id === 'claude1' ? '/auth' : '/auth/claude2',
    manager: new OAuthManager({ accountId: id, tokenPath: path.join(result.root, `${id}.json`) })
  }]));
  const requests = [], logins = [];
  const cliAuthFactory = options => ({
    async getStatuses({ providerId } = {}) {
      return CATALOG.filter(provider => provider.kind === 'cli' && (!providerId || provider.id === providerId)).map(provider => ({
        id: provider.id, kind: 'cli', state: 'missing', canLogin: true, canRefresh: false, canReset: false
      }));
    },
    async login(provider) { logins.push({ provider, ...options }); return { message: 'Synthetic login' }; },
    close() {}
  });
  const providerFactory = options => Object.fromEntries(CATALOG.filter(provider => provider.handler).map(provider => [provider.handler,
    async (req, res, body, model) => {
      requests.push({ provider: provider.id, options, model });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    }
  ]));
  class FakeClaude {
    static clearAccountCache() {}
    constructor(req, options) { this.options = options; }
    async handleResponse(res) {
      requests.push({ provider: 'claude', options: this.options });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    }
  }
  const configFile = path.join(result.root, 'config.txt');
  fs.writeFileSync(configFile, 'mimo_model=xiaomi/mimo-v2.6-pro\n');
  const server = createServer({ registry: result.registry, config: result.config, configFile, accounts, logger: quiet,
    ClaudeRequest: FakeClaude, cliAuthFactory, providerFactory });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (route, body, headers = {}) => fetch(`${base}/dashboard/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'X-Dashboard-Request': '1', 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const add = async (provider, label) => {
    const response = await api('connections', { provider, label });
    assert.equal(response.status, 201);
    return (await response.json()).connection;
  };
  const chat = url => fetch(`${base}${url}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Synthetic conversation' }] }) });
  return { ...result, server, accounts, requests, logins, base, api, add, chat };
}

test('migration preserves eight legacy URLs and repeated providers persist without reusing IDs', t => {
  const { registry, filename, profilesDir } = fixture(t);
  assert.deepEqual(registry.list().map(connectionPath), ['/v1', '/v1/claude2', '/v1/kimi', '/v1/codex', '/v1/grok', '/v1/argon', '/v1/mimo', '/v1/muse']);
  const third = registry.add('claude'), fourth = registry.add('claude');
  assert.equal(third.label, 'Claude 3'); assert.equal(fourth.label, 'Claude 4');
  for (const provider of CATALOG.filter(provider => provider.independentAccounts)) { registry.add(provider.id); registry.add(provider.id); }
  const restarted = createConnectionRegistry({ filename, profilesDir });
  assert.deepEqual(restarted.list(), registry.list());
  assert.equal(new Set(registry.list().map(connection => connection.id)).size, 22);
  assert.notEqual(registry.profileDir(third.id), registry.profileDir(fourth.id));
  for (const connection of restarted.list()) restarted.remove(connection.id);
  assert.deepEqual(createConnectionRegistry({ filename }).list(), []);
  assert.notEqual(restarted.add('claude').id, third.id);
});

test('invalid records fail closed and failed writes leave active connections unchanged', t => {
  const { registry, filename } = fixture(t);
  const failing = createConnectionRegistry({ filename, io: { ...fs, renameSync() { throw new Error('Synthetic disk failure'); } } });
  assert.throws(() => failing.add('claude'), /Could not save/);
  assert.throws(() => failing.remove('claude1'), /Could not save/);
  assert.deepEqual(failing.list(), registry.list());
  for (const provider of ['__proto__', 'constructor', '../claude', {}, null]) assert.throws(() => registry.add(provider), /supported provider/);
  assert.throws(() => registry.add('claude', 'x'.repeat(81)), /80 characters/);
  assert.throws(() => registry.profileDir('../credentials'), /Unknown connection/);
  fs.writeFileSync(filename, '{bad json');
  assert.throws(() => createConnectionRegistry({ filename }), /has not been replaced/);
  assert.equal(fs.readFileSync(filename, 'utf8'), '{bad json');
});

test('new profiles discard inherited credentials, overrides and keychain settings without mutating the parent', t => {
  const { root } = fixture(t);
  const inherited = { Path: 'synthetic-path', SystemRoot: 'C:\\Windows', HOME: 'real-home', userprofile: 'real-home',
    META_API_KEY: 'secret-meta', XAI_API_KEY: 'secret-xai', OpenAI_Api_Key: 'secret-openai',
    MIMOCODE_AUTH_CONTENT: 'secret-mimo', CODEX_HOME: 'real-codex', KIMI_SHARE_DIR: 'real-kimi',
    ANTIGRAVITY_LS_ADDRESS: 'existing-session', GOOGLE_APPLICATION_CREDENTIALS: 'real-google' };
  const one = profileEnvironment(path.join(root, 'one'), inherited), two = profileEnvironment(path.join(root, 'two'), inherited);
  assert.equal(one.Path, inherited.Path); assert.equal(one.SystemRoot, inherited.SystemRoot);
  assert.doesNotMatch(JSON.stringify(one), /secret-|real-|existing-session/);
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CODEX_HOME', 'GROK_HOME', 'KIMI_CODE_HOME', 'KIMI_SHARE_DIR', 'MIMOCODE_HOME']) {
    assert.notEqual(one[key], two[key], key); assert.ok(one[key].startsWith(path.join(root, 'one')), key);
  }
  assert.equal(inherited.META_API_KEY, 'secret-meta');
});

test('four Claude accounts route to independent stores, report status and survive restart', async t => {
  const h = await serverFixture(t);
  const third = await h.add('claude', 'Personal'), fourth = await h.add('claude', 'Work');
  const status = await (await h.api('status')).json();
  assert.equal(status.providers.filter(provider => provider.provider === 'claude').length, 4);
  assert.equal(status.catalog.length, 7);
  assert.doesNotMatch(JSON.stringify(status), /tokenPath|profilesDir|settings|\.json/);
  for (const connection of [third, fourth]) {
    assert.equal((await h.chat(new URL(connection.proxyUrl).pathname)).status, 200);
    const request = h.requests.at(-1);
    assert.equal(request.options.accountId, connection.id);
    assert.equal(request.options.fallbackToClaudeCode, false);
    assert.ok(request.options.oauthManager.tokenPath.startsWith(h.registry.profileDir(connection.id)));
  }
  const activity = await (await h.api('activity')).json();
  assert.deepEqual(activity.requests.map(request => request.providerId), [fourth.id, third.id]);
  const restarted = createConnectionRegistry({ filename: h.filename, profilesDir: h.profilesDir });
  assert.equal(connectionPath(restarted.get(third.id)), new URL(third.proxyUrl).pathname);
});

test('OAuth callbacks cannot cross accounts; removing a pending login cannot resurrect credentials', async t => {
  const h = await serverFixture(t);
  const a = await h.add('claude'), b = await h.add('claude');
  await h.api('status');
  let resolveExchange;
  h.accounts[a.id].manager.exchangeCodeForTokens = () => new Promise(resolve => { resolveExchange = resolve; });
  h.accounts[b.id].manager.exchangeCodeForTokens = async () => ({ access_token: 'synthetic-b', refresh_token: 'synthetic-refresh', expires_in: 3600 });
  const loginA = await (await h.api(`providers/${a.id}/login`, {})).json();
  const loginB = await (await h.api(`providers/${b.id}/login`, {})).json();
  const callback = (url, state) => fetch(h.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'synthetic-code', state }) });
  assert.equal((await callback(loginB.callbackPath, loginA.state)).status, 400);
  assert.equal((await callback(loginB.callbackPath, loginB.state)).status, 200);
  const pending = callback(loginA.callbackPath, loginA.state);
  while (!resolveExchange) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await h.api(`providers/${a.id}/remove`, {})).status, 200);
  resolveExchange({ access_token: 'synthetic-a', refresh_token: 'synthetic-refresh', expires_in: 3600 });
  assert.equal((await pending).status, 409);
  assert.equal(fs.existsSync(path.join(h.registry.profileDir(a.id), 'oauth', 'tokens.json')), false);
  assert.equal(h.accounts[b.id].manager.isAuthenticated(), true);
  assert.equal((await h.chat(new URL(a.proxyUrl).pathname)).status, 404);
  assert.equal((await callback(loginA.callbackPath, loginA.state)).status, 404);
  assert.equal((await h.chat('/v1')).status, 200);
});

test('CLIs supporting independent accounts use matching private profiles for login, status and requests', async t => {
  const h = await serverFixture(t);
  for (const provider of CATALOG.filter(provider => provider.kind === 'cli' && provider.independentAccounts)) {
    const siblings = [await h.add(provider.id), await h.add(provider.id)];
    const homes = [];
    for (const connection of siblings) {
      assert.equal((await h.api(`providers/${connection.id}/login`, {})).status, 200);
      assert.equal((await h.chat(new URL(connection.proxyUrl).pathname)).status, 200);
      const login = h.logins.at(-1), request = h.requests.at(-1);
      assert.equal(login.provider, provider.id); assert.equal(request.provider, provider.id);
      assert.equal(login.env, request.options.process.env);
      assert.equal(login.homeDir, request.options.os.homedir());
      assert.equal(login.isolated, true); assert.ok(fs.existsSync(login.homeDir));
      homes.push(login.homeDir);
      if (provider.id === 'codex') assert.ok(request.options.config.codex_args.includes('cli_auth_credentials_store="file"'));
    }
    assert.notEqual(homes[0], homes[1]);
  }
});

test('Argon explicitly remains a single system account and cannot silently impersonate separate subscriptions', async t => {
  const h = await serverFixture(t);
  assert.equal(h.registry.catalog().find(provider => provider.id === 'argon').canAdd, false);
  assert.equal((await h.api('connections', { provider: 'argon' })).status, 409);
  await h.api('providers/argon/remove', {});
  assert.equal(h.registry.catalog().find(provider => provider.id === 'argon').canAdd, true);
  const connection = await h.add('argon');
  assert.equal(connection.independentAccounts, false);
  assert.equal((await h.chat(new URL(connection.proxyUrl).pathname)).status, 200);
  assert.equal(h.requests.at(-1).options.process.env, process.env);
  assert.equal((await h.api('connections', { provider: 'argon' })).status, 409);
});

test('MiMo model changes persist per connection and never alter another account or legacy config', async t => {
  const h = await serverFixture(t);
  const a = await h.add('mimo'), b = await h.add('mimo');
  assert.equal((await h.api(`providers/${a.id}/model`, { model: 'xiaomi/mimo-v2.6-flash' })).status, 200);
  const status = await (await h.api('status')).json();
  assert.equal(status.providers.find(provider => provider.id === a.id).modelSelection.selected, 'xiaomi/mimo-v2.6-flash');
  for (const id of [b.id, 'mimo']) assert.equal(status.providers.find(provider => provider.id === id).modelSelection.selected, 'xiaomi/mimo-v2.6-pro');
  assert.equal(createConnectionRegistry({ filename: h.filename }).get(a.id).settings.model, 'xiaomi/mimo-v2.6-flash');
  assert.equal((await h.api(`providers/${a.id}/model`, { model: 'ultraspeed' })).status, 400);
});

test('connection mutations require local same-origin requests, the dashboard header and proxy key', async t => {
  const h = await serverFixture(t, { proxy_api_key: 'synthetic-key' });
  assert.equal((await h.api('connections', { provider: 'claude' })).status, 401);
  assert.equal((await h.api('connections', { provider: 'claude' }, { 'X-Proxy-Key': 'synthetic-key', Origin: 'https://example.com' })).status, 403);
  assert.equal((await h.api('connections', { provider: 'claude' }, { 'X-Proxy-Key': 'synthetic-key', 'X-Dashboard-Request': '' })).status, 403);
  assert.equal((await h.api('connections', { provider: '../claude' }, { 'X-Proxy-Key': 'synthetic-key' })).status, 400);
  assert.equal((await h.api('connections', { provider: 'claude' }, { 'X-Proxy-Key': 'synthetic-key' })).status, 201);
  assert.equal((await h.api('providers/claude1/remove', {}, { 'X-Proxy-Key': 'synthetic-key', Origin: 'https://example.com' })).status, 403);
  assert.equal(h.registry.list().length, 9);
});

test('removing legacy connections disables their reserved URLs without redirecting to a different account', async t => {
  const h = await serverFixture(t);
  for (const id of ['claude2', 'kimi', 'grok', 'codex', 'argon', 'mimo', 'muse']) {
    await h.api(`providers/${id}/remove`, {});
    assert.equal((await h.chat(`/v1/${id}`)).status, 404);
  }
  assert.equal((await h.chat('/v1/kimi-1m')).status, 404);
  assert.equal((await h.chat('/v1')).status, 200);
  await h.api('providers/claude1/remove', {});
  assert.equal((await h.chat('/v1')).status, 404);
  assert.equal((await h.chat('/v1/pyrite')).status, 404);
  assert.deepEqual((await (await h.api('status')).json()).providers, []);
});
