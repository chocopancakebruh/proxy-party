const assert = require('node:assert/strict');
const test = require('node:test');
const { probeConnection } = require('./dashboard/connection-test');
const { codexModels, museModels } = require('./ModelCatalog');

test('test connection uses each card URL, returns the response model and waits for completed dialogue', async () => {
  const origin = 'http://localhost:42069';
  const proxyUrl = origin + '/v1/connections/claude-123';
  const message = { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }], model: 'confirmed-model' };
  const capture = async (url, options) => {
    assert.equal(url.href, proxyUrl + '/messages');
    assert.equal(options.headers['X-Proxy-Key'], 'fixture');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.stream, false);
    assert.equal(body.model, 'claude-fable-5-2');
    return Response.json(message);
  };
  const settings = { origin, proxyUrl, proxyKey: 'fixture', claudeModel: 'claude-fable-5-2' };
  assert.equal(await probeConnection({ ...settings, fetchImpl: capture }), 'confirmed-model');
  for (const response of [{}, { ...message, stop_reason: 'max_tokens' }, { ...message, content: [] }, { error: { message: 'Unavailable' } }]) {
    await assert.rejects(probeConnection({ ...settings, fetchImpl: async () => Response.json(response) }));
  }
  await assert.rejects(probeConnection({ ...settings, fetchImpl: async () => Response.json({ error: { message: 'Sign in' } }, { status: 401 }) }), /401.*Sign in/);
  await assert.rejects(probeConnection({ ...settings, proxyUrl: 'https://other.invalid/v1', fetchImpl: () => assert.fail() }), /Invalid connection URL/);
});

test('Codex catalog pages use reported model IDs and supported effort pairs', async () => {
  const cursors = [];
  const client = { notify() {}, async request(method, params) {
    if (method === 'initialize') return {};
    assert.equal(method, 'model/list');
    cursors.push(params.cursor);
    const row = { model: params.cursor ? 'two' : 'one', displayName: 'Display', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] };
    return { data: [row, { ...row, hidden: true }], nextCursor: params.cursor ? null : 'next' };
  } };
  const options = await codexModels(client);
  assert.deepEqual(cursors, [null, 'next']);
  assert.deepEqual(options.map(o => [o.id, o.efforts]), [['one', ['low']], ['two', ['low']]]);
});

test('Muse catalog queries a restricted ephemeral session, exposes only offered standard Meta models', async () => {
  let sessionId;
  const client = { notify() {}, async request(method, params) {
    if (method === 'initialize') return { serverInfo: { name: 'muse', version: '1.4.10' }, schema: { version: 1 }, sessionDurability: 'ephemeral' };
    if (method === 'session/start') {
      sessionId = params.sessionId;
      assert.equal(params.approvalMode, 'denyUnmatched');
      return { session: { sessionId, providerId: 'meta', path: '' } };
    }
    assert.equal(method, 'model/list');
    assert.equal(params.sessionId, sessionId);
    return { models: [{ providerId: 'meta', modelId: 'muse-wonder-full' }, { providerId: 'other', modelId: 'private' },
      { providerId: 'meta', modelId: 'muse-spark-1.3-contributor' }] };
  } };
  assert.deepEqual((await museModels(client, '/fixture')).map(x => x.id), ['muse-wonder-full']);
});
