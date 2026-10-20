const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const test = require('node:test');
const { createServer } = require('./server');
const { OAuthManager } = require('./OAuthManager');
const { createDashboard } = require('./Dashboard');
const { markActivityFailure } = require('./RequestActivity');

const quiet = { info() {}, error() {}, debug() {}, warn() {} };

async function setup(context, config = {}, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-dashboard-test-'));
  const accounts = Object.fromEntries(['claude1', 'claude2'].map((id, index) => {
    const manager = new OAuthManager({ homeDir: home, tokenPath: path.join(home, `${id}.json`), accountId: id });
    manager.exchangeCodeForTokens = async () => ({ access_token: `${id}-synthetic-access`, refresh_token: `${id}-synthetic-refresh`, expires_in: 3600 });
    return [id, { id, label: `Claude ${index + 1}`, authBase: index ? '/auth/claude2' : '/auth', manager }];
  }));
  const cleared = [];
  const calls = [];
  let cliClosed = false;
  const cliAuth = {
    async getStatuses() {
      return ['kimi', 'codex', 'grok', 'argon', 'mimo', 'muse'].map(id => ({ id, label: id, kind: 'cli', state: 'unknown', message: 'Synthetic CLI status', canLogin: true, canReset: false, canRefresh: false }));
    },
    async login(id) { calls.push(id); return { message: 'A login terminal opened.' }; },
    close() { cliClosed = true; }
  };
  class FakeRequest {
    constructor(req, options) { this.options = options; }
    static clearAccountCache(id) { cleared.push(id); }
    async handleResponse(res) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accountId: this.options.accountId, fallback: this.options.fallbackToClaudeCode }));
    }
  }
  const providers = Object.fromEntries(['Kimi', 'Codex', 'Grok', 'Argon', 'Mimo', 'Muse'].map(name => [
    `handle${name}Request`, async (req, res) => { res.writeHead(200); res.end('Synthetic reply content'); }
  ]));
  const configFile = path.join(home, 'config.txt');
  fs.writeFileSync(configFile, `port=42069\nmimo_model=${config.mimo_model || 'xiaomi/mimo-v2.6-pro'}\n`);
  const server = createServer({ accounts, cliAuth, providers, ClaudeRequest: FakeRequest, logger: quiet, configFile, config: { host: '127.0.0.1', ...config }, ...options });
  context.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (route, options = {}) => fetch(`${base}/dashboard/api/${route}`, {
    ...options,
    headers: { 'X-Dashboard-Request': '1', ...options.headers }
  });
  return { accounts, api, base, calls, cleared, server, configFile, isCliClosed: () => cliClosed };
}

test('dashboard serves only allowlisted assets with restrictive browser headers', async context => {
  const { base } = await setup(context);
  const response = await fetch(base, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/dashboard/');
  for (const asset of ['', 'app.js', 'style.css']) {
    const result = await fetch(`${base}/dashboard/${asset}`);
    assert.equal(result.status, 200, asset);
    assert.match(result.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.ok((await result.text()).length > 100);
  }
  assert.equal((await fetch(`${base}/dashboard/config.txt`)).status, 404);
  assert.equal((await fetch(`${base}/dashboard/%2e%2e%2fOAuthManager.js`)).status, 404);
});

test('dashboard lists independent Claude and CLI status without exposing tokens or paths', async context => {
  const { accounts, api } = await setup(context);
  accounts.claude1.manager.saveTokens({ access_token: 'synthetic-private-access', refresh_token: 'synthetic-private-refresh', expires_at: Date.now() + 3600000 });
  const response = await api('status');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.providers.length, 8);
  assert.equal(data.providers[0].state, 'authenticated');
  assert.equal(data.providers[1].state, 'missing');
  assert.match(data.providers[0].proxyUrl, /\/v1$/);
  assert.match(data.providers[1].proxyUrl, /\/v1\/claude2$/);
  assert.match(data.providers[7].proxyUrl, /\/v1\/muse$/);
  assert.doesNotMatch(JSON.stringify(data), /synthetic-private|tokenPath|\.json/);
});

test('dashboard API requires custom header and configured proxy key while shell remains public', async context => {
  const { base, api } = await setup(context, { proxy_api_key: 'synthetic-proxy-key' });
  assert.equal((await fetch(`${base}/dashboard/`)).status, 200);
  assert.equal((await fetch(`${base}/dashboard/api/status`)).status, 403);
  assert.equal((await api('status')).status, 401);
  assert.equal((await api('status', { headers: { 'X-Proxy-Key': 'synthetic-proxy-key' } })).status, 200);
});

test('dashboard rejects cross-origin, same-site cross-port and untrusted Host requests', async context => {
  const { api, base, calls } = await setup(context);
  for (const headers of [
    { Origin: 'https://attacker.invalid' },
    { Origin: 'http://localhost:8000' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' }
  ]) {
    assert.equal((await api('providers/kimi/login', { method: 'POST', headers })).status, 403, JSON.stringify(headers));
  }
  const preflight = await fetch(`${base}/dashboard/api/status`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8000', 'Access-Control-Request-Headers': 'x-dashboard-request' } });
  assert.equal(preflight.status, 403);
  const untrustedHostStatus = await new Promise((resolve, reject) => {
    const request = http.request(`${base}/dashboard/api/providers/kimi/login`, { method: 'POST', headers: { Host: 'attacker.invalid', 'X-Dashboard-Request': '1' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(untrustedHostStatus, 403);
  assert.equal(calls.length, 0);
  assert.equal((await api('status', { headers: { Origin: base } })).status, 200);
});

test('dashboard rejects nonlocal peers even with a forged loopback Host', async () => {
  const dashboard = createDashboard({});
  const req = { method: 'GET', socket: { remoteAddress: '100.64.0.2' }, headers: { host: '127.0.0.1:42069' } };
  await assert.rejects(dashboard(req, {}, '/dashboard/'), { statusCode: 403 });
});

test('MiMo model selection persists and appears in status without restarting the server', async context => {
  const { api, configFile } = await setup(context, { mimo_model: 'xiaomi/mimo-v2.6-pro' });
  const before = await (await api('status')).json();
  assert.equal(before.providers.find(provider => provider.id === 'mimo').modelSelection.selected, 'xiaomi/mimo-v2.6-pro');
  assert.ok(before.providers.filter(provider => provider.id !== 'mimo').every(provider => !provider.modelSelection));
  for (const model of ['xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro']) {
    const response = await api('providers/mimo/model', { method: 'POST', body: JSON.stringify({ model }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).modelSelection.selected, model);
    assert.ok(fs.readFileSync(configFile, 'utf8').includes(`mimo_model=${model}\n`));
    const status = await (await api('status')).json();
    assert.equal(status.providers.find(provider => provider.id === 'mimo').modelSelection.selected, model);
  }
});

test('MiMo model writes require same-origin, dashboard header, proxy key, POST and valid bounded JSON', async context => {
  const { api, base, configFile } = await setup(context, { proxy_api_key: 'synthetic-proxy-key' });
  const original = fs.readFileSync(configFile, 'utf8');
  const route = 'providers/mimo/model';
  const body = JSON.stringify({ model: 'xiaomi/mimo-v2.6-flash' });
  const headers = { 'X-Proxy-Key': 'synthetic-proxy-key' };
  assert.equal((await api(route, { method: 'POST', body })).status, 401);
  assert.equal((await fetch(`${base}/dashboard/api/${route}`, { method: 'POST', headers, body })).status, 403);
  assert.equal((await api(route, { method: 'POST', headers: { ...headers, Origin: 'http://localhost:8000' }, body })).status, 403);
  assert.equal((await api(route, { headers })).status, 405);
  for (const invalid of ['{', '{}', 'null', '[]', JSON.stringify({ model: 'xiaomi/mimo-v2.6-pro-ultraspeed' })]) {
    assert.equal((await api(route, { method: 'POST', headers, body: invalid })).status, 400);
  }
  assert.equal((await api(route, { method: 'POST', headers, body: ' '.repeat(1025) })).status, 413);
  assert.equal(fs.readFileSync(configFile, 'utf8'), original);
});

test('dashboard cannot be opted into allowed remote origins', async context => {
  const { api } = await setup(context, { allowed_origins: 'https://trusted-client.invalid' });
  assert.equal((await api('status', { headers: { Origin: 'https://trusted-client.invalid' } })).status, 403);
});

test('CLI login is POST-only, allowlisted and never exposes a CLI reset endpoint', async context => {
  const { api, calls } = await setup(context);
  assert.equal((await api('providers/kimi/login')).status, 405);
  assert.equal((await api('providers/kimi/reset', { method: 'POST' })).status, 400);
  assert.equal((await api('providers/not-a-provider/login', { method: 'POST' })).status, 404);
  assert.equal((await api('providers/kimi/login', { method: 'POST' })).status, 200);
  assert.deepEqual(calls, ['kimi']);
});

test('Claude reset invalidates only its old login, deletes only its own tokens and signs in without restart', async context => {
  const { accounts, api, base, cleared } = await setup(context);
  for (const account of Object.values(accounts)) account.manager.saveTokens({ access_token: 'old-synthetic-access', refresh_token: 'old-synthetic-refresh', expires_at: Date.now() + 3600000 });
  const oldLogin = await (await api('providers/claude1/login', { method: 'POST' })).json();
  const originalStatus = await (await api('status')).json();
  assert.equal(originalStatus.providers[0].authGeneration, oldLogin.authGeneration);
  const otherTokens = accounts.claude2.manager.loadTokens();
  const newLogin = await (await api('providers/claude1/reset', { method: 'POST' })).json();
  assert.equal(accounts.claude1.manager.loadTokens(), null);
  assert.equal(accounts.claude1.manager.allowsClaudeCodeFallback(), false);
  assert.deepEqual(accounts.claude2.manager.loadTokens(), otherTokens);
  assert.deepEqual(cleared, ['claude1']);
  assert.equal(newLogin.callbackPath, '/auth/callback');
  const callback = state => fetch(`${base}/auth/callback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, code: 'synthetic-code' }) });
  assert.equal((await callback(oldLogin.state)).status, 400);
  assert.equal((await callback(newLogin.state)).status, 200);
  const signedInStatus = await (await api('status')).json();
  assert.ok(signedInStatus.providers[0].authGeneration > newLogin.authGeneration);
  assert.equal(accounts.claude1.manager.isAuthenticated(), true);
  assert.equal(accounts.claude1.manager.allowsClaudeCodeFallback(), true);
  assert.deepEqual(accounts.claude2.manager.loadTokens(), otherTokens);
  assert.equal((await callback(newLogin.state)).status, 400);
});

test('dashboard logout suppresses Claude Code fallback for future requests', async context => {
  const { api, base } = await setup(context);
  assert.equal((await api('providers/claude1/logout', { method: 'POST' })).status, 200);
  const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'synthetic', messages: [{ role: 'user', content: 'Synthetic.' }] }) });
  assert.deepEqual(await response.json(), { accountId: 'claude1', fallback: false });
});

test('dashboard refresh uses only the selected manager and invalidates its cached credentials', async context => {
  const { accounts, api, cleared } = await setup(context);
  const refreshed = [];
  accounts.claude1.manager.refreshAccessToken = async () => { refreshed.push('claude1'); };
  accounts.claude2.manager.refreshAccessToken = async () => { refreshed.push('claude2'); };
  assert.equal((await api('providers/claude2/refresh', { method: 'POST' })).status, 200);
  assert.deepEqual(refreshed, ['claude2']);
  assert.deepEqual(cleared, ['claude2']);
});

test('reset while OAuth exchange awaits cannot resurrect the old login', async context => {
  const { accounts, api, base } = await setup(context);
  let finishExchange;
  let exchangeStarted;
  const started = new Promise(resolve => { exchangeStarted = resolve; });
  accounts.claude1.manager.exchangeCodeForTokens = () => new Promise(resolve => {
    finishExchange = resolve;
    exchangeStarted();
  });
  const login = await (await api('providers/claude1/login', { method: 'POST' })).json();
  const callback = fetch(`${base}/auth/callback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: login.state, code: 'synthetic-code' }) });
  await started;
  assert.equal((await api('providers/claude1/reset', { method: 'POST' })).status, 200);
  finishExchange({ access_token: 'old-access', refresh_token: 'old-refresh', expires_in: 3600 });
  assert.equal((await callback).status, 409);
  assert.equal(accounts.claude1.manager.loadTokens(), null);
});

test('legacy account actions reject same-site cross-port requests too', async context => {
  const { base } = await setup(context);
  for (const route of ['/auth/logout', '/auth/get-url', '/auth/claude2/logout']) {
    assert.equal((await fetch(`${base}${route}`, { headers: { Origin: 'http://localhost:8000' } })).status, 403);
  }
});

test('server close releases initialized CLI authentication resources', async context => {
  const { api, server, isCliClosed } = await setup(context);
  await api('status');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  assert.equal(isCliClosed(), true);
});

test('request activity records only fixed metadata for all eight account/provider routes', async context => {
  const { base, api } = await setup(context);
  const routes = ['', '/claude2', '/kimi', '/codex', '/grok', '/argon', '/mimo', '/muse'];
  for (const route of routes) {
    const response = await fetch(`${base}/v1${route}/messages?private=synthetic-query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'synthetic-secret-header' },
      body: JSON.stringify({ model: 'synthetic-private-model', system: 'synthetic-private-system', messages: [{ role: 'user', content: 'synthetic-private-prompt' }] })
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  const response = await api('activity');
  assert.equal(response.status, 200);
  const activity = await response.json();
  assert.equal(activity.requests.length, 8);
  assert.equal(activity.activeRequests, 0);
  assert.deepEqual(new Set(activity.requests.map(entry => entry.providerId)), new Set(['claude1', 'claude2', 'kimi', 'codex', 'grok', 'argon', 'mimo', 'muse']));
  for (const entry of activity.requests) {
    assert.equal(entry.status, 'success');
    assert.equal(entry.httpStatus, 200);
    assert.ok(entry.durationMs >= 0);
    assert.ok(Number.isFinite(Date.parse(entry.startedAt)));
    assert.deepEqual(Object.keys(entry).sort(), ['durationMs', 'httpStatus', 'id', 'providerId', 'startedAt', 'status', 'streaming'].sort());
  }
  assert.doesNotMatch(JSON.stringify(activity), /synthetic|prompt|reply|messages|model|system|headers|private|query/i);
});

test('request activity covers invalid requests without retaining parser or error details', async context => {
  const { base, api } = await setup(context);
  const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: 'synthetic-private-broken-json' });
  assert.equal(response.status, 400);
  await response.text();
  const { requests } = await (await api('activity')).json();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, 'error');
  assert.equal(requests[0].errorCategory, 'invalid_request');
  assert.equal(requests[0].httpStatus, 400);
  assert.doesNotMatch(JSON.stringify(requests), /synthetic|broken|json/i);
});

test('activity APIs are same-origin, key-protected, and excluded from the request feed', async context => {
  const { base, api } = await setup(context, { proxy_api_key: 'synthetic-proxy-key' });
  for (const route of ['activity', 'activity/clear']) {
    const method = route.endsWith('/clear') ? 'POST' : 'GET';
    assert.equal((await api(route, { method })).status, 401);
    assert.equal((await api(route, { method, headers: { 'X-Proxy-Key': 'synthetic-proxy-key', Origin: 'http://localhost:8000' } })).status, 403);
    assert.equal((await fetch(`${base}/dashboard/api/${route}`, { method, headers: { 'X-Proxy-Key': 'synthetic-proxy-key' } })).status, 403);
  }
  assert.equal((await api('activity/clear', { headers: { 'X-Proxy-Key': 'synthetic-proxy-key' } })).status, 405);
  const result = await (await api('activity', { headers: { 'X-Proxy-Key': 'synthetic-proxy-key' } })).json();
  assert.deepEqual(result.requests, []);
});

test('clearing activity does not stop running requests or reset the health active count', async context => {
  let release;
  let accepted;
  const started = new Promise(resolve => { accepted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { base, api } = await setup(context, {}, { providers: {
    async handleKimiRequest(req, res) { accepted(); await gate; res.end('Synthetic reply'); }
  }, instanceId: '0123456789abcdef' });
  const generation = fetch(`${base}/v1/kimi/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Synthetic prompt' }], stream: true }) });
  await started;
  const inFlight = await (await api('activity')).json();
  assert.equal(inFlight.requests[0].status, 'running');
  assert.equal(inFlight.requests[0].streaming, true);
  assert.equal(inFlight.activeRequests, 1);
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.activeRequests, 1);
  assert.equal(health.instanceId, '0123456789abcdef');
  assert.equal(health.activity, true);
  assert.equal((await api('activity/clear', { method: 'POST' })).status, 200);
  const cleared = await (await api('activity')).json();
  assert.deepEqual(cleared.requests, []);
  assert.equal(cleared.activeRequests, 1);
  release();
  assert.equal(await (await generation).text(), 'Synthetic reply');
  const finished = await (await api('activity')).json();
  assert.deepEqual(finished.requests, []);
  assert.equal(finished.activeRequests, 0);
});

test('an explicit streaming failure is not shown as successful just because HTTP was already 200', async context => {
  const { base, api } = await setup(context, {}, { providers: {
    async handleGrokRequest(req, res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {}\n\n');
      markActivityFailure(res, 'upstream_error');
      res.end('event: error\ndata: {"error":"Synthetic private provider error"}\n\n');
    }
  } });
  const response = await fetch(`${base}/v1/grok/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Synthetic prompt' }], stream: true }) });
  assert.equal(response.status, 200);
  await response.text();
  const { requests } = await (await api('activity')).json();
  assert.equal(requests[0].status, 'error');
  assert.equal(requests[0].httpStatus, 200);
  assert.equal(requests[0].errorCategory, 'upstream_error');
  assert.doesNotMatch(JSON.stringify(requests), /synthetic|private/i);
});
