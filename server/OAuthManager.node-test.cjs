const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { OAuthManager } = require('./OAuthManager');
const ClaudeRequest = require('./ClaudeRequest');
const Logger = require('./Logger');

Logger.init({ log_level: 'ERROR' });

function createManager(context, options = {}) {
  const temporaryRoot = process.env.PROXY_TEST_TEMP_ROOT || os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'proxy-oauth-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new OAuthManager({
    tokenPath: path.join(directory, 'tokens.json'),
    request: () => assert.fail('Real network access is forbidden in tests'),
    ...options
  });
}

function tokens(access = 'access-placeholder', expiresAt = Date.now() + 3600000) {
  return { access_token: access, refresh_token: 'refresh-placeholder', expires_at: expiresAt };
}

test('saving replacement tokens immediately changes subsequent Claude requests', async context => {
  const manager = createManager(context);
  manager.saveTokens(tokens('first-placeholder'));
  const request = new ClaudeRequest(null, { config: {}, oauthManager: manager });
  assert.equal(await request.getAuthToken(), 'Bearer first-placeholder');
  manager.saveTokens(tokens('replacement-placeholder'));
  ClaudeRequest.clearAccountCache(manager.accountId);
  assert.equal(await request.getAuthToken(), 'Bearer replacement-placeholder');
  assert.equal(manager.cachedToken, 'replacement-placeholder');
});

test('an external token-file replacement is authoritative over memory', async context => {
  const manager = createManager(context);
  manager.saveTokens(tokens('old-placeholder'));
  fs.writeFileSync(manager.tokenPath, JSON.stringify(tokens('external-placeholder')));
  assert.equal(await manager.getValidAccessToken(), 'external-placeholder');
});

test('expiring tokens refresh once for concurrent requests and preserve omitted refresh tokens', async context => {
  const manager = createManager(context);
  manager.saveTokens(tokens('expired-placeholder', Date.now() + 30000));
  let refreshCalls = 0;
  manager._makeTokenRequest = async () => {
    refreshCalls += 1;
    await new Promise(resolve => setImmediate(resolve));
    return { access_token: 'fresh-placeholder', expires_in: 3600 };
  };
  const results = await Promise.all(Array.from({ length: 5 }, () => manager.getValidAccessToken()));
  assert.deepEqual(results, Array(5).fill('fresh-placeholder'));
  assert.equal(refreshCalls, 1);
  assert.equal(manager.loadTokens().refresh_token, 'refresh-placeholder');
  assert.equal(manager.refreshPromise, null);
});

test('a rejected access token forces refresh even before its recorded expiry', async context => {
  const manager = createManager(context);
  manager.saveTokens(tokens('rejected-placeholder'));
  manager._makeTokenRequest = async () => ({ access_token: 'fresh-placeholder', expires_in: 3600 });
  assert.equal(await manager.getValidAccessToken({ rejectedToken: 'rejected-placeholder' }), 'fresh-placeholder');
  manager._makeTokenRequest = () => assert.fail('A stale 401 must not refresh an already replaced token');
  assert.equal(await manager.getValidAccessToken({ rejectedToken: 'rejected-placeholder' }), 'fresh-placeholder');
});

test('a failed refresh does not leave a permanently rejected single-flight promise', async context => {
  const manager = createManager(context);
  await assert.rejects(manager.refreshAccessToken(), /No refresh token/);
  assert.equal(manager.refreshPromise, null);
  manager.saveTokens(tokens('expired-placeholder', 0));
  manager._makeTokenRequest = async () => ({ access_token: 'fresh-placeholder', expires_in: 3600 });
  assert.equal(await manager.getValidAccessToken(), 'fresh-placeholder');
});

test('reauthentication during refresh cannot overwrite the new account', async context => {
  const manager = createManager(context);
  manager.saveTokens(tokens('old-placeholder', 0));
  let finishRefresh;
  manager._makeTokenRequest = () => new Promise(resolve => { finishRefresh = resolve; });
  const pending = manager.refreshAccessToken();
  await new Promise(resolve => setImmediate(resolve));
  manager.saveTokens(tokens('replacement-placeholder'));
  finishRefresh({ access_token: 'stale-refresh-placeholder', refresh_token: 'stale-refresh', expires_in: 3600 });
  await assert.rejects(pending, /Authentication changed/);
  assert.equal(await manager.getValidAccessToken(), 'replacement-placeholder');
});

test('logout during refresh cannot recreate the token file', async context => {
  const manager = createManager(context);
  manager.saveTokens(tokens('old-placeholder', 0));
  let finishRefresh;
  manager._makeTokenRequest = () => new Promise(resolve => { finishRefresh = resolve; });
  const pending = manager.refreshAccessToken();
  await new Promise(resolve => setImmediate(resolve));
  manager.logout();
  finishRefresh({ access_token: 'stale-placeholder', expires_in: 3600 });
  await assert.rejects(pending, /Authentication changed/);
  assert.equal(fs.existsSync(manager.tokenPath), false);
});

test('replacement before a queued refresh prevents sending the replacement refresh token', async context => {
  const manager = createManager(context);
  manager.saveTokens(tokens('expired-placeholder', 0));
  manager._makeTokenRequest = () => assert.fail('An invalidated refresh must not reach the provider');
  const pending = manager.refreshAccessToken();
  manager.saveTokens(tokens('replacement-placeholder'));
  await assert.rejects(pending, /Authentication changed/);
  assert.equal(await manager.getValidAccessToken(), 'replacement-placeholder');
});

test('account token stores and refresh promises stay independent', async context => {
  const primary = createManager(context, { accountId: 'claude1' });
  const secondary = createManager(context, { accountId: 'claude2' });
  primary.saveTokens(tokens('primary-placeholder', 0));
  secondary.saveTokens(tokens('secondary-placeholder', 0));
  primary._makeTokenRequest = async () => ({ access_token: 'primary-fresh', expires_in: 3600 });
  secondary._makeTokenRequest = async () => ({ access_token: 'secondary-fresh', expires_in: 3600 });
  assert.deepEqual(await Promise.all([primary.getValidAccessToken(), secondary.getValidAccessToken()]), [
    'primary-fresh', 'secondary-fresh'
  ]);
});

test('token transport timeout destroys a stalled request', async context => {
  let outgoing;
  const manager = createManager(context, {
    timeoutMs: 20,
    request: () => {
      outgoing = new EventEmitter();
      outgoing.end = () => {};
      outgoing.destroy = () => { outgoing.destroyed = true; };
      return outgoing;
    }
  });
  await assert.rejects(manager._makeTokenRequest('{}'), /timeout/);
  assert.equal(outgoing.destroyed, true);
});

test('token transport rejects an interrupted response promptly', async context => {
  const manager = createManager(context, {
    request: (options, callback) => {
      const outgoing = new EventEmitter();
      outgoing.destroy = () => {};
      outgoing.end = () => queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        callback(response);
        response.emit('aborted');
        response.destroy();
      });
      return outgoing;
    }
  });
  await assert.rejects(manager._makeTokenRequest('{}'), /interrupted/);
});

test('token errors do not echo sensitive provider response bodies', async context => {
  const manager = createManager(context, {
    request: (options, callback) => {
      const outgoing = new EventEmitter();
      outgoing.destroy = () => {};
      outgoing.end = () => queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = 400;
        callback(response);
        response.end(JSON.stringify({ error: 'invalid_grant', refresh_token: 'sensitive-placeholder' }));
      });
      return outgoing;
    }
  });
  await assert.rejects(manager._makeTokenRequest('{}'), error => {
    assert.match(error.message, /invalid_grant/);
    assert.doesNotMatch(error.message, /sensitive-placeholder/);
    return true;
  });
});

test('logger honors ERROR level and redacts bearer and token fields', () => {
  Logger.init({ log_level: 'ERROR' });
  assert.equal(Logger.getLogLevel(), 0);
  const text = JSON.stringify(Logger.redact({
    Authorization: 'Bearer sensitive-placeholder',
    'x-proxy-key': 'proxy-placeholder',
    proxy_api_key: 'config-placeholder',
    nested: { refresh_token: 'secret-placeholder' },
    note: 'Bearer opaque-placeholder and sk-ant-example-placeholder'
  }));
  assert.doesNotMatch(text, /sensitive-placeholder|secret-placeholder|opaque-placeholder|sk-ant-example-placeholder|proxy-placeholder|config-placeholder/);
  assert.match(text, /REDACTED/);
  assert.doesNotMatch(Logger.redact('{"x-api-key":"secret-placeholder"}'), /secret-placeholder/);
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => Logger.redact(circular));
});

test('synchronous token transport failures settle and clear the timer', async context => {
  const manager = createManager(context, { request: () => { throw new Error('Synchronous transport failure'); } });
  await assert.rejects(manager._makeTokenRequest('{}'), /Synchronous transport failure/);
});
