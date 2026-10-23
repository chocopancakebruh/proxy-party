const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createProviderHandlers } = require('./providers');
const { JsonLineClient } = require('./providers/JsonLineClient');
const { chatConfiguration, DISABLED_FEATURES } = require('./providers/codex');
const { resolveCommand, spawnProvider, stopProcess } = require('./providers/process');

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
  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    this.emit('close');
  }
  json() { return JSON.parse(this.chunks.join('')); }
  events() {
    return this.chunks.join('').split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)));
  }
}

function fakeChild({ exitOnInputEnd = true } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  const exit = signal => {
    child.exitCode = signal ? null : 0;
    child.signalCode = signal || null;
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', child.exitCode, child.signalCode);
    child.emit('close', child.exitCode, child.signalCode);
  };
  child.kill = signal => { child.kills.push(signal); exit(signal); return true; };
  if (exitOnInputEnd) child.stdin.once('finish', () => exit());
  return child;
}

function harness({ config = {}, onRequest } = {}) {
  const req = new EventEmitter();
  req.aborted = false;
  const res = new Response();
  const calls = [];
  const spawned = [];
  const handlers = createProviderHandlers({
    config, Logger: { error() {}, debug() {} },
    process: { platform: 'linux', env: {} },
    os: { tmpdir: () => '/test-workspace' }, randomUUID: () => 'fixture-id',
    spawn(command, args, options) {
      const child = fakeChild();
      spawned.push({ command, args, options, child });
      const send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
      child.stdin.on('data', chunk => {
        const request = JSON.parse(String(chunk));
        calls.push(request);
        queueMicrotask(() => {
          if (onRequest?.({ request, send, req, res, child, calls }) === true) return;
          if (!Object.hasOwn(request, 'id')) return;
          const results = {
            initialize: {}, 'session/new': { sessionId: 'session' },
            'session/set_config_option': {}, 'config/read': { config: { mcp_servers: { testServer: {} } } },
            'thread/start': { thread: { id: 'thread' } }, 'turn/interrupt': {}
          };
          if (request.method === 'session/prompt') {
            send({ method: 'session/update', params: { sessionId: 'session', update: {
              sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reasoning' }
            } } });
            send({ method: 'session/update', params: { sessionId: 'session', update: {
              sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello 🌟' }
            } } });
            send({ id: request.id, result: { stopReason: 'end_turn' } });
            return;
          }
          if (request.method === 'turn/start') {
            send({ id: request.id, result: { turn: { id: 'turn', status: 'inProgress' } } });
            send({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn',
              item: { id: 'commentary', type: 'agentMessage', phase: 'commentary' } } });
            send({ method: 'item/agentMessage/delta', params: { itemId: 'commentary', delta: 'Do not show' } });
            send({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'reason', delta: 'Reasoning' } });
            send({ method: 'item/started', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer' } } });
            send({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'Hello 🌟' } });
            send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', text: 'Hello 🌟' } } });
            send({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: {
              inputTokens: 100, outputTokens: 20, cachedInputTokens: 60
            } } } });
            send({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } });
            return;
          }
          assert.ok(Object.hasOwn(results, request.method), `Unexpected request ${request.method}`);
          send({ id: request.id, result: results[request.method] });
        });
      });
      return child;
    }
  });
  return { req, res, calls, spawned, handlers };
}

for (const provider of ['Kimi', 'Grok', 'Codex']) {
  for (const stream of [false, true]) {
    test(`${provider} returns thought and answer once (${stream ? 'stream' : 'JSON'})`, async () => {
      const fixture = harness();
      await fixture.handlers[`handle${provider}Request`](fixture.req, fixture.res, {
        messages: [{ role: 'user', content: 'Hello' }], stream
      }, 'kimi-code/k3');
      assert.equal(fixture.res.status, 200);
      if (stream) {
        const events = fixture.res.events();
        assert.equal(events.filter(event => event.type === 'message_stop').length, 1);
        assert.equal(events.filter(event => event.delta?.text).map(event => event.delta.text).join(''), 'Hello 🌟');
        assert.equal(events.filter(event => event.delta?.thinking).map(event => event.delta.thinking).join(''), 'Reasoning');
      } else {
        assert.deepEqual(fixture.res.json().content.map(block => block.text || block.thinking), ['Reasoning', 'Hello 🌟']);
      }
      assert.equal(fixture.spawned[0].child.exitCode, 0);
      assert.equal(fixture.req.listenerCount('aborted'), 0);
      assert.equal(fixture.res.listenerCount('close'), 0);
    });
  }
}

test('Kimi snapshots the selected model before initialization and honors explicit route overrides', async () => {
  for (const override of [undefined, 'kimi-code/k3']) {
    const config = { kimi_model: 'kimi-code/k3.1-pro' };
    const fixture = harness({ config, onRequest({ request }) {
      if (request.method === 'initialize') config.kimi_model = 'kimi-code/k3.1-pro-highspeed';
    } });
    await fixture.handlers.handleKimiRequest(fixture.req, fixture.res, { messages: [{ role: 'user', content: 'Hi' }] }, override);
    assert.equal(fixture.res.status, 200);
    const expected = override || 'kimi-code/k3.1-pro';
    assert.equal(fixture.calls.find(r => r.method === 'session/set_config_option').params.value, expected);
    assert.equal(fixture.res.json().model, expected);
  }
});

test('Kimi never prompts or falls back when the CLI rejects a selected model', async () => {
  const fixture = harness({ config: { kimi_model: 'kimi-code/k3.1-pro' }, onRequest({ request, send }) {
    if (request.method !== 'session/set_config_option') return;
    send({ id: request.id, error: { code: -32602, message: 'Model unavailable' } });
    return true;
  } });
  await fixture.handlers.handleKimiRequest(fixture.req, fixture.res, { messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(fixture.res.status, 502);
  assert.equal(fixture.calls.filter(r => r.method === 'session/set_config_option').length, 1);
  assert.equal(fixture.calls.some(r => r.method === 'session/prompt'), false);
});

test('Codex disables configured tools and preserves native usage', async () => {
  const fixture = harness();
  await fixture.handlers.handleCodexRequest(fixture.req, fixture.res, { messages: [{ role: 'user', content: 'Hi' }] });
  const thread = fixture.calls.find(request => request.method === 'thread/start');
  assert.deepEqual(thread.params.config.mcp_servers, { testServer: { enabled: false } });
  assert.ok(DISABLED_FEATURES.every(feature => thread.params.config.features[feature] === false));
  assert.equal(fixture.spawned[0].args.filter(argument => argument === '--disable').length, DISABLED_FEATURES.length);
  assert.deepEqual(fixture.res.json().usage, { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60 });
});

test('tool configuration uses only table names, never credential values', () => {
  const mcp = {};
  Object.defineProperty(mcp, 'secretServer', { enumerable: true, get() { throw new Error('credentials read'); } });
  const config = chatConfiguration({ mcp_servers: mcp, apps: { app: {} }, plugins: { plugin: {} } });
  assert.deepEqual(config.mcp_servers, { secretServer: { enabled: false } });
  assert.equal(config.apps.app.enabled, false);
  assert.equal(config.plugins.plugin.enabled, false);
});

for (const [mode, expected] of [['summary', 'Summary'], ['raw', 'Raw'], ['both', 'SummaryRaw'], ['none', undefined]]) {
  test(`Codex preserves ${mode} reasoning mode without duplicate completed text`, async () => {
    const fixture = harness({ config: { codex_reasoning_mode: mode }, onRequest({ request, send }) {
      if (request.method !== 'turn/start') return false;
      send({ id: request.id, result: { turn: { id: 'turn', status: 'inProgress' } } });
      send({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'reason', delta: 'Summary' } });
      send({ method: 'item/reasoning/textDelta', params: { itemId: 'reason', delta: 'Raw' } });
      send({ method: 'item/completed', params: { item: {
        id: 'reason', type: 'reasoning', summary: ['Summary'], content: ['Raw']
      } } });
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', text: 'Answer' } } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } });
      return true;
    } });
    await fixture.handlers.handleCodexRequest(fixture.req, fixture.res, { messages: [{ role: 'user', content: 'Hi' }] });
    assert.equal(fixture.res.status, 200);
    assert.equal(fixture.res.json().content.find(block => block.type === 'thinking')?.thinking, expected);
    assert.equal(fixture.res.json().content.find(block => block.type === 'text').text, 'Answer');
    if (mode === 'none') assert.equal(fixture.calls.find(request => request.method === 'turn/start').params.summary, 'none');
  });
}

test('a Codex tool event becomes an SSE error and shuts down the provider', async () => {
  const fixture = harness({ onRequest({ request, send }) {
    if (request.method !== 'turn/start') return false;
    send({ id: request.id, result: { turn: { id: 'turn', status: 'inProgress' } } });
    send({ method: 'item/started', params: { item: { id: 'command', type: 'commandExecution' } } });
    return true;
  } });
  await fixture.handlers.handleCodexRequest(fixture.req, fixture.res, { messages: [{ role: 'user', content: 'Hi' }], stream: true });
  assert.equal(fixture.res.events().filter(event => event.type === 'error').length, 1);
  assert.equal(fixture.spawned[0].child.exitCode, 0);
});

test('unsupported content is rejected before starting a provider', async () => {
  const fixture = harness();
  await fixture.handlers.handleKimiRequest(fixture.req, fixture.res, {
    messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }]
  });
  assert.equal(fixture.res.status, 400);
  assert.equal(fixture.spawned.length, 0);
});

test('ACP drains a final update queued just after the prompt result', async () => {
  const fixture = harness({ onRequest({ request, send }) {
    if (request.method !== 'session/prompt') return false;
    send({ id: request.id, result: { stopReason: 'end_turn' } });
    setTimeout(() => send({ method: 'session/update', params: {
      sessionId: 'session', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Final chunk' }
      }
    } }), 5);
    return true;
  } });
  await fixture.handlers.handleKimiRequest(fixture.req, fixture.res, { messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(fixture.res.json().content[0].text, 'Final chunk');
});

test('Codex disconnect interrupts its active turn and waits for process shutdown', async () => {
  const fixture = harness({ onRequest({ request, send, req }) {
    if (request.method !== 'turn/start') return false;
    send({ id: request.id, result: { turn: { id: 'turn', status: 'inProgress' } } });
    queueMicrotask(() => { req.aborted = true; req.emit('aborted'); });
    return true;
  } });
  await fixture.handlers.handleCodexRequest(fixture.req, fixture.res, { messages: [{ role: 'user', content: 'Hi' }] });
  assert.ok(fixture.calls.some(request => request.method === 'turn/interrupt'));
  assert.equal(fixture.spawned[0].child.exitCode, 0);
  assert.equal(fixture.res.chunks.length, 0);
});

test('ACP disconnect cancels a pending prompt', async () => {
  const fixture = harness({ onRequest({ request, req }) {
    if (request.method !== 'session/prompt') return false;
    req.aborted = true;
    req.emit('aborted');
    return true;
  } });
  await fixture.handlers.handleGrokRequest(fixture.req, fixture.res, { messages: [{ role: 'user', content: 'Hi' }] });
  assert.ok(fixture.calls.some(request => request.method === 'session/cancel'));
  assert.equal(fixture.spawned[0].child.exitCode, 0);
});

test('provider timeout cancels initialization and returns 504', async () => {
  const fixture = harness({ config: { kimi_timeout_ms: 1000 }, onRequest: () => true });
  const keepAlive = setTimeout(() => {}, 1500);
  try {
    await fixture.handlers.handleKimiRequest(fixture.req, fixture.res, { messages: [{ role: 'user', content: 'Hi' }] });
    assert.equal(fixture.res.status, 504);
    assert.equal(fixture.spawned[0].child.exitCode, 0);
  } finally { clearTimeout(keepAlive); }
});

for (const invalid of ['null\n', '[]\n', '{"method":"event","params":2}\n', 'not JSON\n']) {
  test(`invalid protocol envelope is request-local: ${invalid.trim()}`, async () => {
    const child = fakeChild();
    let fatal;
    const client = new JsonLineClient(child, { name: 'fixture', onFatal: error => { fatal = error; } });
    const pending = client.request('initialize', {});
    assert.doesNotThrow(() => child.stdout.write(invalid));
    await assert.rejects(pending);
    assert.ok(fatal instanceof Error);
    assert.equal(client.pending.size, 0);
    child.stdin.end();
  });
}

test('protocol dispatch errors and oversized unterminated lines fail the request', async () => {
  for (const options of [
    { input: '{"method":"event"}\n', onNotification() { throw new Error('bad event'); } },
    { input: '123456789', maxLineLength: 8 }
  ]) {
    const child = fakeChild();
    const client = new JsonLineClient(child, { name: 'fixture', ...options });
    const pending = client.request('initialize', {});
    assert.doesNotThrow(() => child.stdout.write(options.input));
    await assert.rejects(pending);
    child.stdin.end();
  }
});

test('Windows resolves native executables ahead of shell wrappers', () => {
  const command = resolveCommand('codex', { platform: 'win32', env: { PATH: 'C:\\bin' },
    filesystem: { existsSync: candidate => ['C:\\bin\\codex.exe', 'C:\\bin\\codex.cmd'].includes(candidate) } });
  assert.equal(command, 'C:\\bin\\codex.exe');
});

test('Windows cleanup terminates the owned process tree and is idempotent', async () => {
  const child = fakeChild({ exitOnInputEnd: false });
  const launches = [];
  const spawn = (command, args, options) => {
    launches.push({ command, args, options });
    if (command.endsWith('taskkill.exe')) {
      const killer = new EventEmitter();
      killer.kill = () => {};
      queueMicrotask(() => { child.kill('SIGTERM'); killer.emit('close', 0); });
      return killer;
    }
    return child;
  };
  const owned = spawnProvider('C:\\bin\\codex.cmd', ['app-server'], {}, {
    spawn, platform: 'win32', fs: { existsSync: () => true }
  });
  await Promise.all([
    stopProcess(owned, { spawn, platform: 'win32', graceMs: 1 }),
    stopProcess(owned, { spawn, platform: 'win32', graceMs: 1 })
  ]);
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[1].args, ['/PID', String(child.pid), '/T', '/F']);
  assert.equal(launches[1].options.shell, false);
  assert.equal(child.signalCode, 'SIGTERM');
});

test('Windows cleanup terminates real owned descendants', { skip: process.platform !== 'win32', timeout: 8000 }, async () => {
  const path = require('node:path');
  const child = spawnProvider(process.execPath, [path.join(__dirname, 'fixtures', 'owned-process.cjs')]);
  let descendantPid;
  try {
    descendantPid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture did not start')), 3000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.once('data', chunk => {
        clearTimeout(timer);
        resolve(JSON.parse(String(chunk)).descendantPid);
      });
    });
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    await stopProcess(child);
    assert.throws(() => process.kill(descendantPid, 0));
  } finally {
    await stopProcess(child);
    if (descendantPid) { try { process.kill(descendantPid); } catch {} }
  }
});
