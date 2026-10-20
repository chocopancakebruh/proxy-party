const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const test = require('node:test');
const { createMimoAuth, credentialPath } = require('./MimoAuth');
const { createCliAuth } = require('./CliAuth');
const { createDashboard } = require('./Dashboard');

const secret = 'synthetic-private-mimo-key';
const credential = (key = secret, base_url = 'https://token-plan-sgp.xiaomimimo.com/v1') => ({ xiaomi: { type: 'api', key, metadata: { base_url } } });

function setup(options = {}) {
  const env = { ...options.env };
  const home = 'C:\\Users\\Synthetic';
  let data = JSON.stringify(options.data ?? credential());
  let missing = false;
  let clock = 100;
  let handler = options.handler;
  const calls = [];
  const reads = [];
  const fs = {
    statSync() { if (missing) throw Object.assign(new Error('private path'), { code: 'ENOENT' }); return { size: Buffer.byteLength(data), isFile: () => true }; },
    readFileSync(filename) { reads.push(filename); if (options.readError) throw new Error('private file contents'); return data; }
  };
  const request = (url, settings, callback) => {
    const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; };
    const call = { url, settings, req, respond(status = 200, body = { data: [{ id: 'mimo-v2.6-pro' }] }) {
      const res = new PassThrough();
      res.statusCode = status;
      call.res = res;
      callback(res);
      if (!res.destroyed) res.end(typeof body === 'string' ? body : JSON.stringify(body));
    } };
    req.end = () => { calls.push(call); queueMicrotask(() => handler ? handler(call) : call.respond()); };
    return req;
  };
  const environment = name => env[name] || '';
  const auth = createMimoAuth({ fs, environment, home, path: path.win32, request, now: () => clock,
    timeoutMs: options.timeoutMs ?? 1000 });
  return { auth, env, home, fs, request, calls, reads,
    setData(value) { data = typeof value === 'string' ? value : JSON.stringify(value); },
    remove() { missing = true; }, advance(ms) { clock += ms; }, setHandler(value) { handler = value; } };
}

test('MiMo uses XDG defaults on Windows, macOS and Linux, with explicit overrides', () => {
  for (const [home, paths] of [['C:\\Users\\Synthetic', path.win32], ['/Users/synthetic', path.posix], ['/home/synthetic', path.posix]]) {
    const environment = () => '';
    assert.equal(credentialPath({ home, path: paths, environment }), paths.join(home, '.local', 'share', 'mimocode', 'auth.json'));
    const env = { XDG_DATA_HOME: paths.join(home, 'xdg'), MIMOCODE_HOME: paths.join(home, 'custom') };
    assert.equal(credentialPath({ home, path: paths, environment: name => env[name] }), paths.join(home, 'custom', 'data', 'auth.json'));
    delete env.MIMOCODE_HOME;
    assert.equal(credentialPath({ home, path: paths, environment: name => env[name] }), paths.join(home, 'xdg', 'mimocode', 'auth.json'));
    env.XDG_DATA_HOME = 'relative';
    assert.equal(credentialPath({ home, path: paths, environment: name => env[name] }), paths.join(home, '.local', 'share', 'mimocode', 'auth.json'));
    env.MIMOCODE_HOME = 'relative';
    assert.throws(() => credentialPath({ home, path: paths, environment: name => env[name] }));
  }
});

test('only a successful authenticated model-list response marks MiMo signed in', async () => {
  const h = setup();
  const status = await h.auth.getStatus();
  assert.equal(status.state, 'authenticated');
  assert.equal(h.reads[0], 'C:\\Users\\Synthetic\\.local\\share\\mimocode\\auth.json');
  assert.equal(h.calls[0].url, 'https://token-plan-sgp.xiaomimimo.com/v1/models');
  assert.deepEqual(h.calls[0].settings, { method: 'GET', headers: { Accept: 'application/json', 'api-key': secret } });
  assert.doesNotMatch(JSON.stringify(status), /synthetic|key|xiaomimimo\.com|C:\\/);
});

test('missing, unrelated, malformed, oversized and unreadable credentials are never authenticated', async () => {
  const missing = setup(); missing.remove();
  assert.equal((await missing.auth.getStatus()).state, 'missing');
  const unrelated = setup({ data: { other: { type: 'api', key: secret } } });
  assert.equal((await unrelated.auth.getStatus()).state, 'missing');
  for (const h of [setup({ readError: true }), setup({ data: [] }), setup({ data: { xiaomi: { type: 'oauth', access: secret } } })]) {
    assert.equal((await h.auth.getStatus()).state, 'unknown');
    assert.equal(h.calls.length, 0);
  }
  const malformed = setup(); malformed.setData('{broken');
  assert.equal((await malformed.auth.getStatus()).state, 'unknown');
  malformed.setData('x'.repeat(300000));
  assert.equal((await malformed.auth.getStatus()).state, 'unknown');
  assert.equal(malformed.calls.length, 0);
});

test('environment credentials override disk and invalid JSON falls back like the CLI', async () => {
  const h = setup({ env: { MIMOCODE_AUTH_CONTENT: JSON.stringify(credential('synthetic-env-key')) } });
  assert.equal((await h.auth.getStatus()).state, 'authenticated');
  assert.equal(h.reads.length, 0);
  assert.equal(h.calls[0].settings.headers['api-key'], 'synthetic-env-key');
  h.env.MIMOCODE_AUTH_CONTENT = '{}';
  assert.equal((await h.auth.getStatus()).state, 'missing');
  h.env.MIMOCODE_AUTH_CONTENT = 'invalid-json';
  assert.equal((await h.auth.getStatus()).state, 'authenticated');
  assert.equal(h.calls[1].settings.headers['api-key'], secret);
});

test('rejected credentials are signed out; permission, rate limit and server failures stay unverified', async () => {
  for (const [code, expected] of [[401, 'missing'], [403, 'unknown'], [429, 'unknown'], [500, 'unknown'], [302, 'unknown']]) {
    const h = setup({ handler: call => call.respond(code, { error: { message: secret } }) });
    const status = await h.auth.getStatus();
    assert.equal(status.state, expected);
    assert.doesNotMatch(JSON.stringify(status), /synthetic|private/);
    assert.equal(h.calls.length, 1);
  }
  for (const body of ['<html>login</html>', { ok: true }, { data: [], error: 'bad' }, 'x'.repeat(300000)]) {
    const h = setup({ handler: call => call.respond(200, body) });
    assert.equal((await h.auth.getStatus()).state, 'unknown');
  }
});

test('credentials are never sent to custom hosts, HTTP, URLs with secrets, or redirects', async () => {
  for (const base of ['http://api.xiaomimimo.com/v1', 'https://xiaomimimo.com.evil.invalid/v1',
    'https://custom.invalid/v1', 'https://api.xiaomimimo.com:444/v1', 'https://user:password@api.xiaomimimo.com/v1',
    'https://api.xiaomimimo.com/v1?key=secret', 'https://api.xiaomimimo.com/v1#fragment', 'https://api.xiaomimimo.com/other']) {
    const h = setup({ data: credential(secret, base) });
    assert.equal((await h.auth.getStatus()).state, 'unknown');
    assert.equal(h.calls.length, 0);
  }
  const h = setup({ data: { xiaomi: { type: 'api', key: secret } } });
  await h.auth.getStatus();
  assert.equal(h.calls[0].url, 'https://api.xiaomimimo.com/v1/models');
});

test('verification caches briefly, shares concurrent checks, and supports explicit refresh', async () => {
  const h = setup();
  const statuses = await Promise.all([h.auth.getStatus(), h.auth.getStatus(), h.auth.getStatus({ force: true })]);
  assert.ok(statuses.every(s => s.state === 'authenticated'));
  assert.equal(h.calls.length, 1);
  await h.auth.getStatus();
  assert.equal(h.calls.length, 1);
  h.advance(15001);
  await h.auth.getStatus();
  assert.equal(h.calls.length, 2);
  h.setHandler(call => call.respond(401));
  assert.equal((await h.auth.getStatus({ force: true })).state, 'missing');
  assert.equal(h.calls.length, 3);
});

test('credential changes and sign-out invalidate cached success, including in-flight verification', async () => {
  const h = setup();
  await h.auth.getStatus();
  h.setData(credential('replacement-key'));
  await h.auth.getStatus();
  assert.equal(h.calls.length, 2);
  h.remove();
  assert.equal((await h.auth.getStatus()).state, 'missing');
  const pending = setup({ handler() {} });
  const result = pending.auth.getStatus();
  await new Promise(resolve => setImmediate(resolve));
  pending.setData(credential('replacement-key'));
  pending.calls[0].respond();
  assert.equal((await result).state, 'unknown');
});

test('timeouts, network failures and shutdown return unverified and close owned requests', async () => {
  const timeout = setup({ handler() {}, timeoutMs: 10 });
  assert.equal((await timeout.auth.getStatus()).state, 'unknown');
  assert.equal(timeout.calls[0].req.destroyed, true);
  const failed = setup({ handler: call => call.req.emit('error', new Error(secret)) });
  assert.equal((await failed.auth.getStatus()).state, 'unknown');
  const pending = setup({ handler() {} });
  const result = pending.auth.getStatus();
  await new Promise(resolve => setImmediate(resolve));
  pending.auth.close();
  assert.equal((await result).state, 'unknown');
  assert.equal(pending.calls[0].req.destroyed, true);
  assert.equal((await pending.auth.getStatus()).state, 'unknown');
  assert.equal(pending.calls.length, 1);
});

test('dashboard exposes verified MiMo status and propagates manual refresh without credential details', async () => {
  const h = setup();
  const cliAuth = createCliAuth({ fs: h.fs, homeDir: h.home, platform: 'win32',
    env: { PATH: 'C:\\bin' }, mimoRequest: h.request });
  const connection = { id: 'mimo', provider: 'mimo', label: 'MiMo', legacy: true };
  const dashboard = createDashboard({ config: {}, authenticate() {}, getAccount: () => null,
    registry: { list: () => [connection], get: () => connection, catalog: () => [] }, profiles: { auth: () => cliAuth },
    mimoModels: { getSelection: () => ({ selected: null, options: [] }) },
    sendJson(res, status, value) { res.status = status; res.value = value; } });
  const req = { url: '/dashboard/api/status', method: 'GET', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost:42069', 'x-dashboard-request': '1' } };
  const res = { setHeader() {} };
  await dashboard(req, res, '/dashboard/api/status');
  assert.equal(res.status, 200);
  const mimo = res.value.providers.find(p => p.id === 'mimo');
  assert.equal(mimo.state, 'authenticated');
  assert.equal(mimo.proxyUrl, 'http://localhost:42069/v1/mimo');
  assert.doesNotMatch(JSON.stringify(res.value), /synthetic-private|base_url|auth\.json/);
  h.setHandler(call => call.respond(401));
  req.url = '/dashboard/api/status?verify=1';
  await dashboard(req, res, '/dashboard/api/status');
  assert.equal(res.value.providers.find(p => p.id === 'mimo').state, 'missing');
  assert.equal(h.calls.length, 2);
  cliAuth.close();
});
