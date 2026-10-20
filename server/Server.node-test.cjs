const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createApp, createServer } = require('./server');

const message = { model: 'test-model', messages: [{ role: 'user', content: 'Synthetic prompt.' }] };
const logger = { init() {}, info() {}, debug() {}, warn() {}, error() {} };

class Response extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  getHeader(name) {
    return this.headers[name.toLowerCase()];
  }

  writeHead(status, headers = {}) {
    assert.equal(this.writableEnded || this.destroyed, false);
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }

  write(chunk) {
    assert.equal(this.writableEnded || this.destroyed, false);
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(chunk) {
    if (chunk != null) this.write(chunk);
    this.writableEnded = true;
    this.emit('finish');
    this.emit('close');
    return this;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }

  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  json() {
    return JSON.parse(this.text());
  }
}

function makeManager(id) {
  let sequence = 0;
  return {
    saved: null,
    exchanges: [],
    generatePKCE() {
      sequence++;
      return { state: `${id}-state-${sequence}`, code_verifier: `${id}-verifier-${sequence}`, code_challenge: 'synthetic' };
    },
    buildAuthorizationURL(pkce) {
      return `https://provider.invalid/authorize?state=${pkce.state}`;
    },
    async exchangeCodeForTokens(...args) {
      this.exchanges.push(args);
      return { access_token: `${id}-access`, refresh_token: `${id}-refresh`, expires_in: 3600 };
    },
    saveTokens(tokens) { this.saved = tokens; },
    isAuthenticated() { return this.saved !== null; },
    getTokenExpiration() { return this.saved ? new Date(this.saved.expires_at) : null; },
    logout() { this.saved = null; }
  };
}

function harness(config = {}) {
  const calls = [];
  const cleared = [];
  const accounts = Object.fromEntries(['claude1', 'claude2'].map(id => [id, {
    id, label: id === 'claude1' ? 'Claude 1' : 'Claude 2',
    authBase: id === 'claude1' ? '/auth' : '/auth/claude2', manager: makeManager(id)
  }]));
  class ClaudeRequest {
    constructor(req, options) { this.req = req; this.options = options; }
    async handleResponse(res, body, presetName) {
      calls.push({ provider: 'claude', body, presetName, options: this.options, headers: this.req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ provider: 'claude' }));
    }
    static clearAccountCache(accountId) { cleared.push(accountId); }
  }
  const providers = Object.fromEntries(['Kimi', 'Grok', 'Codex', 'Argon', 'Mimo', 'Muse'].map(name => [
    `handle${name}Request`, async (req, res, body, model) => {
      calls.push({ provider: name.toLowerCase(), body, model, headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ provider: name.toLowerCase() }));
    }
  ]));
  let clock = 1000000;
  const options = { config, accounts, providers, ClaudeRequest, logger, now: () => clock };
  const app = createApp(options);
  return { app, options, accounts, calls, cleared, advance: milliseconds => { clock += milliseconds; } };
}

async function invoke(app, pathname, { method = 'GET', headers = {}, body, raw, chunks, pending = false, aborted = false, abortDuringRead = false, beforeBody } = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = pathname;
  req.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  req.socket = { remoteAddress: '127.0.0.1' };
  req.connection = req.socket;
  req.aborted = aborted;
  const res = new Response();
  const running = app(req, res);
  beforeBody?.();
  if (abortDuringRead) {
    req.write('{"messages":');
    req.aborted = true;
    req.emit('aborted');
    req.destroy();
  } else if (chunks) {
    for (const chunk of chunks) req.write(chunk);
    req.end();
  } else if (!pending) {
    req.end(raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : '');
  }
  await running;
  return { req, res };
}

test('server factory imports without listening and returns an unstarted real server', () => {
  const { options } = harness();
  const server = createServer(options);
  assert.equal(server.listening, false);
  assert.equal(server.listenerCount('request'), 1);
  server.close();
});

test('health and both login pages remain available when a proxy key is configured', async () => {
  const { app } = harness({ proxy_api_key: 'synthetic-secret' });
  for (const pathname of ['/health', '/auth/login', '/auth/claude2/login']) {
    const { res } = await invoke(app, pathname);
    assert.equal(res.statusCode, 200, pathname);
    assert.equal(res.writableEnded, true);
  }
});

test('proxy authentication protects provider requests and account administration', async () => {
  const { app, calls } = harness({ proxy_api_key: 'synthetic-secret' });
  for (const pathname of ['/auth/get-url', '/auth/status', '/auth/logout', '/auth/claude2/get-url', '/auth/claude2/status', '/auth/claude2/logout']) {
    assert.equal((await invoke(app, pathname)).res.statusCode, 401, pathname);
  }
  for (const headers of [{}, { 'x-api-key': 'wrong-key' }, { authorization: 'Bearer synthetic-secret-extra' }]) {
    const { res } = await invoke(app, '/v1/codex/messages', { method: 'POST', headers, body: message });
    assert.equal(res.statusCode, 401);
  }
  assert.equal(calls.length, 0);
  for (const headers of [
    { 'x-proxy-key': 'synthetic-secret' },
    { authorization: 'Bearer synthetic-secret' },
    { 'x-api-key': 'synthetic-secret' }
  ]) {
    assert.equal((await invoke(app, '/v1/codex/messages', { method: 'POST', headers, body: message })).res.statusCode, 200);
  }
  assert.equal(calls.length, 3);
});

test('browser origins are checked before requests or preflights can reach providers', async () => {
  const { app, calls } = harness({ allowed_origins: 'https://frontend.example' });
  for (const origin of ['https://untrusted.example', 'null', 'http://localhost.evil.example']) {
    for (const method of ['POST', 'OPTIONS']) {
      assert.equal((await invoke(app, '/v1/messages', { method, headers: { origin }, body: message })).res.statusCode, 403);
    }
  }
  assert.equal(calls.length, 0);
  for (const origin of ['http://localhost:8000', 'http://127.0.0.1:8000', 'http://[::1]:8000', 'https://frontend.example']) {
    const { res } = await invoke(app, '/v1/messages', { method: 'POST', headers: { origin }, body: message });
    assert.equal(res.statusCode, 200, origin);
    assert.equal(res.getHeader('access-control-allow-origin'), origin);
  }
});

test('allowed preflights advertise the actual proxy and Anthropic headers without requiring a key', async () => {
  const { app, calls } = harness({ proxy_api_key: 'synthetic-secret' });
  const { res } = await invoke(app, '/v1/messages', { method: 'OPTIONS', headers: { origin: 'http://localhost:8000' } });
  assert.ok([200, 204].includes(res.statusCode));
  const allowed = String(res.getHeader('access-control-allow-headers')).toLowerCase();
  for (const header of ['x-api-key', 'x-proxy-key', 'authorization', 'anthropic-beta', 'anthropic-version']) assert.ok(allowed.includes(header));
  assert.equal(calls.length, 0);
});

test('each OAuth flow is account-bound, single-use and saves only its own credentials', async () => {
  const { app, accounts, cleared } = harness({ proxy_api_key: 'synthetic-secret' });
  const headers = { 'x-proxy-key': 'synthetic-secret' };
  const primaryState = (await invoke(app, '/auth/get-url', { headers })).res.json().state;
  const secondState = (await invoke(app, '/auth/claude2/get-url', { headers })).res.json().state;
  const mismatch = await invoke(app, `/auth/claude2/callback?code=synthetic&state=${primaryState}`);
  assert.equal(mismatch.res.statusCode, 400);
  assert.equal(accounts.claude1.manager.exchanges.length + accounts.claude2.manager.exchanges.length, 0);
  const primary = await invoke(app, `/auth/callback?manual_code=${encodeURIComponent(`primary-code#${primaryState}`)}`);
  assert.equal(primary.res.statusCode, 200);
  assert.deepEqual(accounts.claude1.manager.exchanges, [['primary-code', 'claude1-verifier-1', primaryState]]);
  assert.equal(accounts.claude2.manager.saved, null);
  const second = await invoke(app, '/auth/claude2/callback', { method: 'POST', body: { code: 'second-code', state: secondState } });
  assert.equal(second.res.statusCode, 200);
  assert.deepEqual(accounts.claude2.manager.exchanges, [['second-code', 'claude2-verifier-1', secondState]]);
  assert.equal((await invoke(app, `/auth/callback?code=primary-code&state=${primaryState}`)).res.statusCode, 400);
  assert.equal(accounts.claude1.manager.exchanges.length, 1);
  assert.deepEqual(cleared, ['claude1', 'claude2']);
  for (const account of Object.values(accounts)) {
    const { res } = await invoke(app, `${account.authBase}/status`, { headers });
    assert.equal(res.json().account, account.id);
    assert.equal(res.json().authenticated, true);
  }
  assert.equal((await invoke(app, '/auth/claude2/logout', { method: 'POST', headers })).res.statusCode, 200);
  assert.equal(accounts.claude2.manager.saved, null);
  assert.ok(accounts.claude1.manager.saved);
  assert.deepEqual(cleared, ['claude1', 'claude2', 'claude2']);
});

test('expired or unknown OAuth state never reaches the token exchange', async () => {
  const current = harness();
  const { state } = (await invoke(current.app, '/auth/get-url')).res.json();
  current.advance(60 * 60 * 1000);
  for (const query of [`code=synthetic&state=${state}`, 'code=synthetic&state=unknown', 'manual_code=missing-separator']) {
    assert.equal((await invoke(current.app, `/auth/callback?${query}`)).res.statusCode, 400);
  }
  assert.deepEqual(current.accounts.claude1.manager.exchanges, []);
});

test('known message endpoints dispatch to the selected provider and Kimi model', async () => {
  const { app, calls } = harness();
  const routes = [
    ['/v1/kimi/messages', 'kimi', 'kimi-code/k3-256k'],
    ['/v1/kimi-256k/messages', 'kimi', 'kimi-code/k3-256k'],
    ['/v1/kimi-1m/messages', 'kimi', 'kimi-code/k3'],
    ['/v1/grok/messages', 'grok'],
    ['/v1/codex/messages', 'codex'],
    ['/v1/argon/messages', 'argon'],
    ['/v1/mimo/messages', 'mimo'],
    ['/v1/muse/messages', 'muse']
  ];
  for (const [pathname, provider, model] of routes) {
    assert.equal((await invoke(app, pathname, { method: 'POST', body: message })).res.statusCode, 200, pathname);
    assert.equal(calls.at(-1).provider, provider);
    assert.equal(calls.at(-1).model, model);
    assert.deepEqual(calls.at(-1).body, message);
  }
});

test('MiMo and Muse routes enforce proxy authentication and validate requests before dispatch', async () => {
  const { app, calls } = harness({ proxy_api_key: 'synthetic-secret' });
  for (const pathname of ['/v1/mimo/messages', '/v1/muse/messages']) {
    assert.equal((await invoke(app, pathname, { method: 'POST', body: message })).res.statusCode, 401);
    assert.equal((await invoke(app, pathname, {
      method: 'POST', headers: { 'x-proxy-key': 'synthetic-secret' }, body: { messages: [] }
    })).res.statusCode, 400);
    assert.equal((await invoke(app, pathname, { method: 'GET', headers: { 'x-proxy-key': 'synthetic-secret' } })).res.statusCode, 404);
  }
  assert.equal(calls.length, 0);
  for (const [name, pathname] of [['mimo', '/v1/mimo/messages'], ['muse', '/v1/muse/messages']]) {
    const { res } = await invoke(app, pathname, {
      method: 'POST', headers: { 'x-api-key': 'synthetic-secret' }, body: { ...message, stream: true }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.at(-1).provider, name);
    assert.equal(calls.at(-1).body.stream, true);
    assert.equal(calls.at(-1).headers['x-api-key'], undefined);
  }
});

test('Claude routing preserves preset selection and isolates the second account', async () => {
  const { app, accounts, calls } = harness({ fallback_to_claude_code: 'true' });
  for (const [pathname, accountId, presetName] of [
    ['/v1/messages', 'claude1', null],
    ['/v1/pyrite/messages', 'claude1', 'pyrite'],
    ['/v1/claude2/messages', 'claude2', null]
  ]) {
    assert.equal((await invoke(app, pathname, { method: 'POST', body: message })).res.statusCode, 200);
    assert.equal(calls.at(-1).provider, 'claude');
    assert.equal(calls.at(-1).options.accountId, accountId);
    assert.equal(calls.at(-1).options.oauthManager, accounts[accountId].manager);
    assert.equal(calls.at(-1).presetName, presetName);
    if (accountId === 'claude2') assert.equal(calls.at(-1).options.fallbackToClaudeCode, false);
  }
});

test('invalid JSON and malformed messages fail before any provider is called', async () => {
  const { app, calls } = harness();
  const invalidBodies = ['{', 'null', '[]', '{}', '{"messages":[]}', '{"messages":[null]}', '{"messages":[{"role":"system","content":"bad"}]}'];
  for (const raw of invalidBodies) {
    for (const pathname of ['/v1/messages', '/v1/codex/messages']) {
      const { res } = await invoke(app, pathname, { method: 'POST', raw });
      assert.equal(res.statusCode, 400, raw);
    }
  }
  assert.equal(calls.length, 0);
});

test('body size is measured in bytes and oversize requests never reach providers', async () => {
  const { app, calls } = harness({ max_body_bytes: 100 });
  const raw = JSON.stringify({ messages: [{ role: 'user', content: '🌟'.repeat(20) }] });
  assert.ok(raw.length < 100 && Buffer.byteLength(raw) > 100);
  assert.equal((await invoke(app, '/v1/messages', { method: 'POST', raw })).res.statusCode, 413);
  assert.equal(calls.length, 0);
});

test('body read deadline ends stalled requests without invoking providers', async () => {
  const { app, calls } = harness({ body_timeout_ms: 25 });
  const keepAlive = setInterval(() => {}, 50);
  try {
    const { req, res } = await invoke(app, '/v1/messages', { method: 'POST', pending: true });
    assert.equal(res.statusCode, 408);
    assert.equal(calls.length, 0);
    req.destroy();
  } finally {
    clearInterval(keepAlive);
  }
});

test('unknown routes and unsupported message methods do not dispatch', async () => {
  const { app, calls } = harness();
  for (const [pathname, method] of [['/missing', 'GET'], ['/v1/messages', 'GET'], ['/v1/no-such-route/extra', 'POST']]) {
    assert.equal((await invoke(app, pathname, { method, body: message })).res.statusCode, 404);
  }
  assert.equal(calls.length, 0);
});

test('loopback binding rejects nonlocal Host headers before reaching a provider', async () => {
  const { app, calls } = harness();
  for (const host of ['attacker.example:42069', '127.0.0.1.attacker.example', '[invalid']) {
    const { res } = await invoke(app, '/v1/messages', { method: 'POST', headers: { host }, body: message });
    assert.equal(res.statusCode, 403, host);
  }
  assert.equal(calls.length, 0);
  for (const host of ['localhost:42069', '127.0.0.1:42069', '[::1]:42069']) {
    assert.equal((await invoke(app, '/v1/messages', { method: 'POST', headers: { host }, body: message })).res.statusCode, 200);
  }
});

test('cross-site navigations without Origin cannot alter accounts but OAuth redirects remain usable', async () => {
  const { app, accounts } = harness();
  accounts.claude1.manager.saved = { access_token: 'synthetic', expires_at: 2000000 };
  const headers = { 'sec-fetch-site': 'cross-site', host: 'localhost:42069' };
  assert.equal((await invoke(app, '/auth/logout', { headers })).res.statusCode, 403);
  assert.ok(accounts.claude1.manager.saved);
  assert.equal((await invoke(app, '/auth/get-url', { headers })).res.statusCode, 403);
  const { state } = (await invoke(app, '/auth/get-url')).res.json();
  assert.equal((await invoke(app, `/auth/callback?code=synthetic&state=${state}`, { headers })).res.statusCode, 200);
  assert.equal(accounts.claude1.manager.exchanges.length, 1);
});

test('request parsing preserves UTF-8 characters split across incoming byte chunks', async () => {
  const { app, calls } = harness();
  const body = { messages: [{ role: 'user', content: 'Hello 🌟 世界' }] };
  const bytes = Buffer.from(JSON.stringify(body));
  const star = bytes.indexOf(Buffer.from('🌟'));
  const chunks = [bytes.subarray(0, star + 1), bytes.subarray(star + 1, star + 3), bytes.subarray(star + 3)];
  assert.equal((await invoke(app, '/v1/messages', { method: 'POST', chunks })).res.statusCode, 200);
  assert.deepEqual(calls[0].body, body);
});

for (const phase of ['before', 'during']) {
  test(`client abort ${phase} body reading removes request listeners and does not respond`, async () => {
    const { app, calls } = harness();
    const { req, res } = await invoke(app, '/v1/messages', {
      method: 'POST', aborted: phase === 'before', abortDuringRead: phase === 'during', pending: phase === 'before'
    });
    assert.equal(calls.length, 0);
    assert.equal(res.headersSent, false);
    assert.equal(res.writableEnded, false);
    for (const event of ['data', 'end', 'error', 'aborted']) assert.equal(req.listenerCount(event), 0, event);
    req.destroy();
  });
}

test('logout invalidates a callback that is already exchanging an authorization code', async () => {
  const current = harness();
  const manager = current.accounts.claude1.manager;
  const { state } = (await invoke(current.app, '/auth/get-url')).res.json();
  let releaseTokens;
  let signalExchange;
  const exchangeStarted = new Promise(resolve => { signalExchange = resolve; });
  manager.exchangeCodeForTokens = () => {
    signalExchange();
    return new Promise(resolve => { releaseTokens = resolve; });
  };
  const callback = invoke(current.app, '/auth/callback', { method: 'POST', body: { code: 'synthetic', state } });
  await exchangeStarted;
  assert.equal((await invoke(current.app, '/auth/logout', { method: 'POST' })).res.statusCode, 200);
  releaseTokens({ access_token: 'stale-access', refresh_token: 'stale-refresh', expires_in: 3600 });
  assert.equal((await callback).res.statusCode, 409);
  assert.equal(manager.saved, null);
  assert.deepEqual(current.cleared, ['claude1']);
});

test('OAuth state expiring while a callback body is being read cannot be exchanged', async () => {
  const current = harness();
  const { state } = (await invoke(current.app, '/auth/get-url')).res.json();
  current.advance(10 * 60 * 1000 - 10);
  const { res } = await invoke(current.app, '/auth/callback', {
    method: 'POST', body: { code: 'synthetic', state }, beforeBody: () => current.advance(20)
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(current.accounts.claude1.manager.exchanges, []);
  assert.equal(current.accounts.claude1.manager.saved, null);
});

test('proxy credentials are removed from the upstream token header while distinct override tokens survive', async () => {
  const secret = 'sk-ant-synthetic-proxy-password';
  const { app, calls } = harness({ proxy_api_key: secret });
  const first = await invoke(app, '/v1/messages', { method: 'POST', headers: { 'x-api-key': secret }, body: message });
  assert.equal(first.res.statusCode, 200);
  assert.equal(calls[0].headers['x-api-key'], undefined);
  const second = await invoke(app, '/v1/messages', {
    method: 'POST', headers: { 'x-proxy-key': secret, 'x-api-key': 'sk-ant-synthetic-upstream' }, body: message
  });
  assert.equal(second.res.statusCode, 200);
  assert.equal(calls[1].headers['x-api-key'], 'sk-ant-synthetic-upstream');
});
