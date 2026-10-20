const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { createMuseHandler, MUSE_ARGS, commandId } = require('./providers/muse');

class Response extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
  }
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }
  write(chunk) {
    assert.equal(this.writableEnded || this.destroyed, false);
    this.chunks.push(String(chunk));
    return true;
  }
  end(chunk) { if (chunk !== undefined) this.write(chunk); this.writableEnded = true; this.emit('close'); }
  json() { return JSON.parse(this.chunks.join('')); }
  events() {
    return this.chunks.join('').split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  }
}

function harness({ config = {}, onRequest, turnEvents } = {}) {
  const req = new EventEmitter();
  req.aborted = false;
  const res = new Response();
  const calls = [];
  const spawned = [];
  const removed = [];
  let nextWorkspace = 0;
  const dependencies = {
    config, Logger: { error() {} }, randomUUID,
    process: { platform: 'linux', env: { HOME: '/existing-login', META_API_KEY: 'test-only', MUSE_TRANSPORT_TRACE: '1' } },
    os: { tmpdir: () => '/scratch' }, path: require('node:path').posix,
    fs: { mkdtempSync: prefix => `${prefix}${++nextWorkspace}`, rmSync: target => removed.push(target) },
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.pid = 65432;
      child.exitCode = null;
      child.signalCode = null;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const exit = () => {
        if (child.exitCode !== null) return;
        child.exitCode = 0;
        child.stdout.end();
        child.stderr.end();
        child.emit('exit', 0);
        child.emit('close', 0);
      };
      child.kill = () => { exit(); return true; };
      child.stdin.once('finish', exit);
      spawned.push({ command, args, options, child });
      const send = message => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
      let sessionId;
      child.stdin.on('data', data => {
        const request = JSON.parse(String(data));
        calls.push(request);
        queueMicrotask(() => {
          if (onRequest?.({ request, send, child, req, res, calls, sessionId }) === true) return;
          if (!Object.hasOwn(request, 'id')) return;
          if (request.method === 'initialize') {
            send({ id: request.id, result: { serverInfo: { name: 'muse', version: '1.4.10' },
              schema: { version: 1, fingerprint: 'fixture' }, sessionDurability: 'ephemeral' } });
          } else if (request.method === 'session/start') {
            sessionId = request.params.sessionId;
            send({ id: request.id, result: { session: { sessionId, path: '', providerId: 'meta', modelId: request.params.modelId || 'muse-spark-1.2',
              approvalMode: { mode: 'denyUnmatched' } } } });
          } else if (request.method === 'turn/start') {
            const turnId = 'authoritative-turn';
            const notify = (method, params) => send({ method, params: { sessionId, ...params } });
            const ack = () => send({ id: request.id, result: { status: 'accepted', disposition: 'started', turnId } });
            const complete = extra => notify('turn/completed', { turnId, terminal: 'completed', ...extra });
            if (turnEvents) { turnEvents({ notify, ack, complete, send, child, sessionId, turnId, req, res }); return; }
            ack();
            notify('item/started', { item: { itemId: 'reason', turnId, kind: 'reasoning', revision: 1, status: 'inProgress' } });
            notify('item/delta', { itemId: 'reason', field: 'summary.0', delta: 'Thought' });
            notify('item/completed', { item: { itemId: 'reason', turnId, kind: 'reasoning', revision: 2,
              status: 'completed', summary: ['Thought'], text: 'Raw thought' } });
            notify('item/started', { item: { itemId: 'answer', turnId, kind: 'agentMessage', messagePhase: 'finalAnswer',
              revision: 1, status: 'inProgress' } });
            const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/delta', params: {
              sessionId, itemId: 'answer', delta: 'Hello 🌟'
            } })}\n`);
            const unicode = frame.indexOf(Buffer.from('🌟'));
            child.stdout.write(frame.subarray(0, unicode + 2));
            child.stdout.write(frame.subarray(unicode + 2));
            notify('item/completed', { item: { itemId: 'answer', turnId, kind: 'agentMessage', messagePhase: 'finalAnswer',
              revision: 2, status: 'completed', text: 'Hello 🌟!' } });
            complete({ usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 2 } });
          } else if (['approval/decide', 'turn/cancel'].includes(request.method)) {
            send({ id: request.id, result: { status: 'accepted' } });
          } else { throw new Error(`Unexpected method ${request.method}`); }
        });
      });
      return child;
    }
  };
  const handler = createMuseHandler(dependencies);
  const run = (body = {}) => handler(req, res, { messages: [{ role: 'user', content: 'Hello' }], ...body });
  return { req, res, calls, spawned, removed, run, handler, dependencies };
}

for (const stream of [false, true]) {
  test(`Muse translates UTF-8, reasoning, authoritative suffix and usage (${stream ? 'SSE' : 'JSON'})`, async () => {
    const fixture = harness();
    await fixture.run({ stream });
    assert.equal(fixture.res.status, 200);
    if (stream) {
      const events = fixture.res.events();
      assert.equal(events.filter(event => event.delta?.text).map(event => event.delta.text).join(''), 'Hello 🌟!');
      assert.equal(events.filter(event => event.delta?.thinking).map(event => event.delta.thinking).join(''), 'Thought');
      assert.equal(events.filter(event => event.type === 'message_stop').length, 1);
      assert.equal(events.find(event => event.type === 'message_start').message.model, 'muse-spark-1.2');
    } else {
      assert.deepEqual(fixture.res.json().content.map(block => block.text || block.thinking), ['Thought', 'Hello 🌟!']);
      assert.equal(fixture.res.json().model, 'muse-spark-1.2');
      assert.deepEqual(fixture.res.json().usage, { input_tokens: 10, output_tokens: 3,
        cache_read_input_tokens: 4, cache_creation_input_tokens: 2 });
    }
    assert.deepEqual(fixture.removed, [fixture.spawned[0].options.cwd]);
    assert.equal(fixture.spawned[0].child.exitCode, 0);
    assert.equal(fixture.req.listenerCount('aborted'), 0);
    assert.equal(fixture.res.listenerCount('close'), 0);
  });
}

test('Muse uses verified host restrictions, fresh session, UUIDv7 commands and explicit settings', async () => {
  const fixture = harness({ config: { muse_command: '/portable/muse', muse_model: 'chosen-model', muse_effort: 'medium' } });
  await fixture.run({ system: 'Conversation instruction' });
  assert.equal(fixture.spawned[0].command, '/portable/muse');
  assert.deepEqual(fixture.spawned[0].args, MUSE_ARGS);
  assert.equal(fixture.spawned[0].options.shell, false);
  assert.equal(fixture.spawned[0].options.env.HOME, '/existing-login');
  assert.equal(fixture.spawned[0].options.env.META_API_KEY, 'test-only');
  assert.equal(fixture.spawned[0].options.env.MUSE_TRANSPORT_TRACE, undefined);
  assert.equal(fixture.spawned[0].options.env.MUSE_NO_AUTO_UPDATE, '1');
  const session = fixture.calls.find(call => call.method === 'session/start').params;
  assert.equal(session.modelId, 'chosen-model');
  assert.equal(session.approvalMode, 'denyUnmatched');
  assert.equal(session.providerId, 'meta');
  assert.equal(session.workspaceRoot, fixture.spawned[0].options.cwd);
  const turn = fixture.calls.find(call => call.method === 'turn/start').params;
  assert.equal(turn.reasoningEffort, 'medium');
  assert.match(turn.input[0].text, /Conversation instruction/);
  assert.deepEqual(fixture.calls[0].params.capabilities.requestedCapabilities, []);
  assert.equal(fixture.calls[0].params.capabilities.userInputDialogs, false);
  for (const call of fixture.calls) {
    assert.equal(call.jsonrpc, '2.0');
    if (call.params?.commandId) assert.match(call.params.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  assert.notEqual(commandId(randomUUID), commandId(randomUUID));
});

test('Muse preserves notifications before the authoritative turn acknowledgement', async () => {
  const fixture = harness({ turnEvents({ notify, ack, complete, turnId }) {
    notify('item/completed', { item: { kind: 'agentMessage', itemId: 'answer', turnId, revision: 1, status: 'completed', text: 'Early' } });
    complete();
    ack();
  } });
  await fixture.run();
  assert.equal(fixture.res.json().content[0].text, 'Early');
});

test('Muse ignores foreign sessions, foreign turns, commentary and duplicate final snapshots', async () => {
  const fixture = harness({ turnEvents({ notify, ack, complete, turnId }) {
    ack();
    const item = { kind: 'agentMessage', itemId: 'answer', turnId, revision: 1, status: 'completed', text: 'Answer' };
    notify('item/completed', { sessionId: 'foreign', item });
    notify('item/completed', { item: { ...item, turnId: 'foreign' } });
    notify('item/started', { item: { ...item, itemId: 'comment', status: 'inProgress', text: '' } });
    notify('item/delta', { itemId: 'comment', delta: 'Hidden commentary' });
    notify('item/completed', { item: { ...item, itemId: 'comment', messagePhase: 'commentary', revision: 2, text: 'Hidden commentary' } });
    notify('item/completed', { item });
    notify('item/completed', { item });
    complete();
  } });
  await fixture.run({ stream: true });
  assert.equal(fixture.res.events().filter(event => event.delta?.text).map(event => event.delta.text).join(''), 'Answer');
});

for (const [mode, expected] of [['summary', 'Thought'], ['raw', 'Raw thought'], ['both', 'ThoughtRaw thought'], ['none', '']]) {
  test(`Muse supports ${mode} reasoning without duplicate completions`, async () => {
    const fixture = harness({ config: { muse_reasoning_mode: mode } });
    await fixture.run({ stream: true });
    assert.equal(fixture.res.events().filter(event => event.delta?.thinking).map(event => event.delta.thinking).join(''), expected);
  });
}

test('Muse denies approval notifications using the current requirement and cancels the turn', async () => {
  const requirementId = { approvalId: 'approval', sourceIndex: 2 };
  const fixture = harness({ turnEvents({ notify, ack, turnId }) {
    ack();
    notify('approval/requested', { turnId, approvalId: 'approval', currentRequirementId: requirementId,
      availableChoices: [{ choiceId: 'approve', decision: 'approved', scope: 'once' },
        { choiceId: 'reject-it', decision: 'denied', scope: 'once' }] });
  } });
  await fixture.run();
  assert.equal(fixture.res.status, 502);
  const decision = fixture.calls.find(call => call.method === 'approval/decide').params;
  assert.equal(decision.choiceId, 'reject-it');
  assert.deepEqual(decision.requirementId, requirementId);
  assert.ok(fixture.calls.some(call => call.method === 'turn/cancel'));
});

for (const kind of ['toolCall', 'userShell', 'subagent', 'workflow', 'webSearch']) {
  test(`Muse rejects unexpected ${kind} operations`, async () => {
    const fixture = harness({ turnEvents({ notify, ack, turnId }) {
      ack();
      notify('item/started', { item: { kind, itemId: 'unsafe', turnId, revision: 1, status: 'inProgress' } });
    } });
    await fixture.run();
    assert.equal(fixture.res.status, 502);
    assert.match(fixture.res.json().error.message, /tool operation/);
  });
}

test('Muse failed turns use typed auth errors without exposing provider details', async () => {
  const fixture = harness({ turnEvents({ ack, complete, child }) {
    ack();
    child.stderr.write('secret-stderr-test-marker');
    complete({ terminal: 'failed', error: { kind: 'authRequired', message: 'secret-provider-test-marker' } });
  } });
  await fixture.run();
  assert.equal(fixture.res.status, 502);
  assert.match(fixture.res.json().error.message, /not signed in/);
  assert.doesNotMatch(fixture.res.chunks.join(''), /secret/);
});

for (const bad of ['null\n', '{not-json}\n']) {
  test(`Muse malformed protocol output fails cleanly: ${bad.trim()}`, async () => {
    const fixture = harness({ onRequest({ child }) { child.stdout.write(bad); return true; } });
    await fixture.run();
    assert.equal(fixture.res.status, 502);
    assert.equal(fixture.spawned[0].child.exitCode, 0);
  });
}

test('Muse disconnect sends protocol cancellation and awaits owned process cleanup', async () => {
  const fixture = harness({ turnEvents({ ack, req, res }) {
    ack();
    setImmediate(() => { req.aborted = true; res.destroyed = true; req.emit('aborted'); });
  } });
  await fixture.run();
  assert.equal(fixture.res.chunks.length, 0);
  assert.ok(fixture.calls.some(call => call.method === 'turn/cancel'));
  assert.equal(fixture.spawned[0].child.exitCode, 0);
  assert.equal(fixture.removed.length, 1);
});

test('Muse initialization timeout is bounded and returns 504', async () => {
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const fixture = harness({ config: { muse_timeout_ms: 1000 }, onRequest() { return true; } });
    await fixture.run();
    assert.equal(fixture.res.status, 504);
    assert.equal(fixture.spawned[0].child.exitCode, 0);
  } finally { clearTimeout(keepAlive); }
});

for (const body of [{ tools: [{ name: 'shell' }] }, { messages: [{ role: 'user', content: [{ type: 'image' }] }] }, { stream: 'true' }]) {
  test(`Muse rejects unsupported request before spawning: ${JSON.stringify(body)}`, async () => {
    const fixture = harness();
    await fixture.run(body);
    assert.equal(fixture.res.status, 400);
    assert.equal(fixture.spawned.length, 0);
  });
}

test('Muse rejects older hosts before creating a session', async () => {
  const fixture = harness({ onRequest({ request, send }) {
    if (request.method !== 'initialize') return false;
    send({ id: request.id, result: { serverInfo: { name: 'muse', version: '1.4.2' }, schema: { version: 1 }, sessionDurability: 'ephemeral' } });
    return true;
  } });
  await fixture.run();
  assert.equal(fixture.res.status, 502);
  assert.equal(fixture.calls.some(call => call.method === 'session/start'), false);
});

test('Muse refuses inconsistent authoritative text instead of duplicating a response', async () => {
  const fixture = harness({ turnEvents({ notify, ack, turnId }) {
    ack();
    const item = { kind: 'agentMessage', itemId: 'answer', turnId, revision: 1, status: 'inProgress', messagePhase: 'finalAnswer' };
    notify('item/started', { item });
    notify('item/delta', { itemId: 'answer', delta: 'One' });
    notify('item/completed', { item: { ...item, status: 'completed', revision: 2, text: 'Two' } });
  } });
  await fixture.run({ stream: true });
  const events = fixture.res.events();
  assert.equal(events.some(event => event.type === 'message_stop'), false);
  assert.ok(events.some(event => event.type === 'error'));
});

test('Muse reports a missing executable without leaking raw spawn diagnostics', async () => {
  const fixture = harness({ onRequest({ child }) {
    const error = new Error('private-path-spawn-diagnostic');
    error.code = 'ENOENT';
    child.emit('error', error);
    return true;
  } });
  await fixture.run();
  assert.equal(fixture.res.status, 502);
  assert.match(fixture.res.json().error.message, /muse_command/);
  assert.doesNotMatch(fixture.res.chunks.join(''), /private-path/);
});

test('Muse never deletes a temporary workspace outside the expected root', async () => {
  const fixture = harness();
  fixture.dependencies.fs.mkdtempSync = () => '/unrelated-directory/claude-proxy-muse-foreign';
  await fixture.run();
  assert.equal(fixture.res.status, 502);
  assert.equal(fixture.spawned.length, 0);
  assert.deepEqual(fixture.removed, []);
});

test('Muse treats a turn ending without final item snapshots as incomplete', async () => {
  const fixture = harness({ turnEvents({ notify, ack, complete, turnId }) {
    ack();
    notify('item/started', { item: { kind: 'agentMessage', itemId: 'answer', turnId,
      revision: 1, status: 'inProgress', messagePhase: 'finalAnswer' } });
    notify('item/delta', { itemId: 'answer', delta: 'Partial' });
    complete();
  } });
  await fixture.run();
  assert.equal(fixture.res.status, 502);
  assert.match(fixture.res.json().error.message, /without completing/);
});

for (const overrides of [{ providerId: 'other-provider' }, { modelId: 'different-model' }, { modelId: null }]) {
  test(`Muse validates the authoritative model and provider: ${JSON.stringify(overrides)}`, async () => {
    const fixture = harness({ config: { muse_model: 'chosen-model' }, onRequest({ request, send }) {
      if (request.method !== 'session/start') return false;
      send({ id: request.id, result: { session: { sessionId: request.params.sessionId, path: '',
        approvalMode: { mode: 'denyUnmatched' }, providerId: 'meta', modelId: 'chosen-model', ...overrides } } });
      return true;
    } });
    await fixture.run();
    assert.equal(fixture.res.status, 502);
    assert.equal(fixture.calls.some(call => call.method === 'turn/start'), false);
  });
}
