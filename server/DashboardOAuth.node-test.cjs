const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { OAuthManager } = require('./OAuthManager');
const Logger = require('./Logger');

Logger.init({ log_level: 'ERROR' });

function fixture(context, options = {}) {
  const temporaryRoot = process.env.PROXY_TEST_TEMP_ROOT || os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'proxy-dashboard-oauth-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manager = new OAuthManager({
    tokenPath: path.join(directory, 'tokens.json'),
    request: () => assert.fail('Status tests must never contact an account service'),
    ...options
  });
  return manager;
}

function tokenRecord(expiresAt = Date.now() + 3600000) {
  return { access_token: 'synthetic-access-credential', refresh_token: 'synthetic-refresh-credential', expires_at: expiresAt };
}

function writeRecord(manager, record) {
  fs.writeFileSync(manager.tokenPath, JSON.stringify(record));
}

test('missing saved authentication has an honest offline status and keeps legacy fallback available', context => {
  const manager = fixture(context);
  assert.deepEqual(manager.getStatus(), {
    state: 'missing', message: 'No saved proxy sign-in. Sign in to connect this account.',
    expiresAt: null, canLogin: true, canReset: false, canRefresh: false
  });
  assert.equal(manager.allowsClaudeCodeFallback(), true);
  assert.equal(manager.getTokenExpiration(), null);
});

test('valid saved credentials report local validity without returning tokens or making requests', context => {
  const manager = fixture(context);
  const record = tokenRecord();
  writeRecord(manager, record);
  const status = manager.getStatus();
  assert.equal(status.state, 'authenticated');
  assert.match(status.message, /locally valid/);
  assert.match(status.message, /not been verified online/);
  assert.equal(status.expiresAt, new Date(record.expires_at).toISOString());
  assert.deepEqual([status.canLogin, status.canReset, status.canRefresh], [true, true, true]);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-access|synthetic-refresh/);
  assert.equal(manager.cachedToken, null);
});

test('expired credentials are not presented as authenticated while compatibility checks still permit refresh', async context => {
  const manager = fixture(context);
  writeRecord(manager, tokenRecord(0));
  const status = manager.getStatus();
  assert.equal(status.state, 'expired');
  assert.match(status.message, /Refresh it or sign in/);
  assert.equal(status.expiresAt, '1970-01-01T00:00:00.000Z');
  assert.equal(status.canRefresh, true);
  assert.equal(manager.isAuthenticated(), true);
  manager._makeTokenRequest = async () => ({ access_token: 'synthetic-refreshed-credential', expires_in: 3600 });
  await manager.refreshAccessToken();
  assert.equal(manager.getStatus().state, 'authenticated');
  assert.equal(await manager.getValidAccessToken(), 'synthetic-refreshed-credential');
});

test('malformed JSON is unknown and neither status nor loadTokens logs token fragments', context => {
  const manager = fixture(context);
  const logged = [];
  context.mock.method(Logger, 'error', (...args) => logged.push(args));
  fs.writeFileSync(manager.tokenPath, '{"access_token":"synthetic-secret-fragment",broken');
  assert.equal(manager.getStatus().state, 'unknown');
  assert.equal(manager.getStatus().canRefresh, false);
  assert.equal(manager.getStatus().canReset, true);
  assert.equal(manager.loadTokens(), null);
  assert.doesNotMatch(JSON.stringify({ status: manager.getStatus(), logged }), /synthetic-secret-fragment/);
});

test('non-object and incomplete credential records are unknown rather than authenticated', context => {
  const manager = fixture(context);
  for (const record of [null, [], 'not-a-record', 42, {},
    { ...tokenRecord(), access_token: '   ' }, { ...tokenRecord(), access_token: { secret: 'placeholder' } },
    { ...tokenRecord(), refresh_token: '' }, { ...tokenRecord(), refresh_token: 42 }]) {
    writeRecord(manager, record);
    const status = manager.getStatus();
    assert.equal(status.state, 'unknown');
    assert.equal(status.canLogin, true);
    assert.equal(status.canReset, true);
    assert.equal(status.canRefresh, typeof record?.refresh_token === 'string' && record.refresh_token.trim().length > 0);
    assert.doesNotMatch(JSON.stringify(status), /synthetic-access|synthetic-refresh|placeholder/);
  }
});

test('invalid expiry values never produce Invalid Date or throw when rendering status', context => {
  const manager = fixture(context);
  for (const expiresAt of [null, undefined, 'not-a-date', '2030-01-01T00:00:00.000Z', {}, [],
    Number.MAX_VALUE, -Number.MAX_VALUE, 8640000000000001, -8640000000000001, NaN, Infinity]) {
    writeRecord(manager, { ...tokenRecord(), expires_at: expiresAt });
    const status = manager.getStatus();
    assert.equal(status.state, 'unknown');
    assert.equal(status.expiresAt, null);
    assert.equal(manager.getTokenExpiration(), null);
    assert.equal(status.canRefresh, true);
  }
});

test('finite Date range boundaries are handled without overflow', context => {
  const manager = fixture(context);
  for (const [expiresAt, state] of [[8640000000000000, 'authenticated'], [-8640000000000000, 'expired']]) {
    writeRecord(manager, tokenRecord(expiresAt));
    assert.equal(manager.getStatus().state, state);
    assert.equal(manager.getStatus().expiresAt, new Date(expiresAt).toISOString());
    assert.equal(manager.getTokenExpiration().getTime(), expiresAt);
  }
});

test('unreadable token records produce a safe unknown status', context => {
  const manager = fixture(context);
  const readFileSync = fs.readFileSync;
  context.mock.method(fs, 'readFileSync', (filename, ...args) => {
    if (filename === manager.tokenPath) throw Object.assign(new Error('private storage detail'), { code: 'EACCES' });
    return readFileSync(filename, ...args);
  });
  const status = manager.getStatus();
  assert.equal(status.state, 'unknown');
  assert.equal(status.canRefresh, false);
  assert.doesNotMatch(JSON.stringify(status), /private storage detail/);
});

test('primary and secondary statuses remain independent', context => {
  const primary = fixture(context, { accountId: 'claude1' });
  const secondary = fixture(context, { accountId: 'claude2' });
  primary.saveTokens(tokenRecord());
  secondary.saveTokens(tokenRecord(0));
  assert.equal(primary.getStatus().state, 'authenticated');
  assert.equal(secondary.getStatus().state, 'expired');
  primary.logout();
  assert.equal(primary.getStatus().state, 'missing');
  assert.equal(primary.allowsClaudeCodeFallback(), false);
  assert.equal(secondary.getStatus().state, 'expired');
  assert.equal(secondary.allowsClaudeCodeFallback(), true);
});

test('explicit logout persists fallback suppression across manager restarts until successful sign-in', async context => {
  const manager = fixture(context);
  manager.saveTokens(tokenRecord());
  const previousGeneration = manager.generation;
  manager.logout();
  assert.equal(manager.generation, previousGeneration + 1);
  assert.equal(manager.cachedToken, null);
  assert.equal(fs.existsSync(manager.tokenPath), false);
  assert.equal(fs.existsSync(manager.signedOutPath), true);
  assert.equal(manager.getStatus().canReset, false);
  assert.match(manager.getStatus().message, /Signed out in this proxy/);
  const restarted = new OAuthManager({ tokenPath: manager.tokenPath, request: () => assert.fail('No real requests') });
  assert.equal(restarted.allowsClaudeCodeFallback(), false);
  assert.equal(restarted.isAuthenticated(), false);
  await assert.rejects(restarted.getValidAccessToken(), /No authentication/);
  await assert.rejects(restarted.refreshAccessToken(), /No refresh token/);
  restarted.saveTokens(tokenRecord());
  assert.equal(restarted.allowsClaudeCodeFallback(), true);
  assert.equal(manager.getStatus().state, 'authenticated');
});

test('logout marker is written before deletion and blocks leftover tokens after a delete failure', async context => {
  const manager = fixture(context);
  manager.saveTokens(tokenRecord());
  const unlinkSync = fs.unlinkSync;
  context.mock.method(Logger, 'error', () => {});
  context.mock.method(fs, 'unlinkSync', filename => {
    if (filename === manager.tokenPath) {
      assert.equal(fs.existsSync(manager.signedOutPath), true);
      throw Object.assign(new Error('Synthetic deletion failure'), { code: 'EACCES' });
    }
    return unlinkSync(filename);
  });
  assert.throws(() => manager.logout(), /Synthetic deletion failure/);
  assert.equal(fs.existsSync(manager.tokenPath), true);
  assert.equal(manager.getStatus().state, 'missing');
  assert.equal(manager.getStatus().canReset, true);
  assert.equal(manager.allowsClaudeCodeFallback(), false);
  assert.equal(manager.isAuthenticated(), false);
  assert.equal(manager.loadTokens(), null);
  await assert.rejects(manager.getValidAccessToken(), /No authentication/);
});

test('an unreadable sign-out marker fails closed without claiming authentication', context => {
  const manager = fixture(context);
  writeRecord(manager, tokenRecord());
  const statSync = fs.statSync;
  context.mock.method(fs, 'statSync', (filename, ...args) => {
    if (filename === manager.signedOutPath) throw Object.assign(new Error('private marker detail'), { code: 'EACCES' });
    return statSync(filename, ...args);
  });
  assert.equal(manager.getStatus().state, 'unknown');
  assert.equal(manager.getStatus().canRefresh, false);
  assert.equal(manager.allowsClaudeCodeFallback(), false);
  assert.equal(manager.loadTokens(), null);
});

test('invalid saves cannot remove durable logout state', context => {
  const manager = fixture(context);
  manager.logout();
  for (const record of [{}, tokenRecord(Number.MAX_VALUE), { ...tokenRecord(), refresh_token: '' }]) {
    assert.throws(() => manager.saveTokens(record), /incomplete or malformed/);
    assert.equal(manager.allowsClaudeCodeFallback(), false);
  }
});

test('logout wins over an in-flight refresh and the marker stays durable', async context => {
  const manager = fixture(context);
  manager.saveTokens(tokenRecord(0));
  let finishRefresh;
  manager._makeTokenRequest = () => new Promise(resolve => { finishRefresh = resolve; });
  const pending = manager.refreshAccessToken();
  await new Promise(resolve => setImmediate(resolve));
  manager.logout();
  finishRefresh({ access_token: 'synthetic-stale-result', expires_in: 3600 });
  await assert.rejects(pending, /Authentication changed/);
  assert.equal(manager.getStatus().state, 'missing');
  assert.equal(manager.allowsClaudeCodeFallback(), false);
  assert.equal(fs.existsSync(manager.tokenPath), false);
});

test('marker follows an explicitly replaced tokenPath instead of touching a previous store', context => {
  const manager = fixture(context);
  const previousPath = manager.tokenPath;
  manager.tokenPath = path.join(path.dirname(previousPath), 'another-account.json');
  manager.logout();
  assert.equal(manager.signedOutPath, `${manager.tokenPath}.signed-out`);
  assert.equal(fs.existsSync(`${previousPath}.signed-out`), false);
});

test('malformed provider JSON and overflowing expiry never expose response fragments', async context => {
  for (const responseBody of ['{"access_token":"synthetic-provider-secret",broken',
    JSON.stringify({ access_token: 'synthetic-provider-secret', expires_in: Number.MAX_VALUE })]) {
    const manager = fixture(context, { request(options, callback) {
      const outgoing = new EventEmitter();
      outgoing.destroy = () => {};
      outgoing.end = () => queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        callback(response);
        response.end(responseBody);
      });
      return outgoing;
    } });
    await assert.rejects(manager._makeTokenRequest('{}'), error => {
      assert.match(error.message, /Invalid token response/);
      assert.doesNotMatch(error.message, /synthetic-provider-secret/);
      return true;
    });
  }
});
