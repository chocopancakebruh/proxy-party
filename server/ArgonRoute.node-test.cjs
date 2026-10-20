const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createArgonHandler } = require('./providers/argon');

const conversationId = '859e2fc2-a491-42df-b767-a56bf24737b0';
const otherConversationId = '329b0f63-4be4-4775-a67e-db7c129a426f';
const answer = 'Hello 🌟\nWorld!';
const thinking = 'The model-provided reasoning text.';

class Response extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
    this.endCalls = 0;
  }
  writeHead(status, headers) {
    assert.equal(this.destroyed || this.writableEnded, false);
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }
  write(chunk) {
    assert.equal(this.destroyed || this.writableEnded, false, 'write after disconnect/end');
    this.chunks.push(String(chunk));
    return true;
  }
  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
    this.endCalls++;
    this.writableEnded = true;
    this.emit('close');
  }
  disconnect() {
    this.destroyed = true;
    this.emit('close');
  }
  events() {
    return this.chunks.join('').split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)));
  }
}

function harness(t, { readThinking = async () => thinking, resultId = conversationId, events: suppliedEvents, rawOutput, onInput, onHeartbeat } = {}) {
  const testRoot = fs.mkdtempSync(path.join(__dirname, '.argon-route-test-'));
  t.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));
  const req = new EventEmitter();
  req.aborted = false;
  const res = new Response();
  const reads = [];
  const spawned = [];
  const treeTerminations = [];
  const directSignals = [];
  const errors = [];
  const context = {
    fs, path, randomUUID,
    process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } },
    os: { ...os, tmpdir: () => testRoot },
    setTimeout, clearTimeout, clearInterval,
    setInterval(callback, milliseconds) {
      if (!onHeartbeat) return setInterval(callback, milliseconds);
      assert.equal(milliseconds, 15000);
      queueMicrotask(() => { onHeartbeat({ req, res }); callback(); });
      return { unref() {} };
    },
    config: { argon_model: 'gemini-4-argon-high', argon_timeout_ms: 1000 },
    Logger: { debug() {}, error(...args) { errors.push(args); } },
    async readArgonThinking(...args) {
      reads.push(args);
      return readThinking({ args, req, res });
    },
    spawn(command, args, options) {
      if (path.win32.basename(command).toLowerCase() === 'taskkill.exe') {
        const target = spawned.find(entry => String(entry.child.pid) === args[1]);
        const killer = new EventEmitter();
        killer.pid = 54321;
        killer.kill = () => { killer.emit('close', 1, null); return true; };
        treeTerminations.push({
          command, args, options,
          rootWasAlive: target?.child.exitCode === null && target?.child.signalCode === null,
          inputWasOpen: target?.child.stdin.writableEnded === false
        });
        queueMicrotask(() => {
          target?.exit(null, 1);
          killer.emit('close', 0, null);
        });
        return killer;
      }
      const child = new EventEmitter();
      child.pid = 12345;
      child.exitCode = null;
      child.signalCode = null;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const exit = (signal, code = 0) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.exitCode = signal ? null : code;
        child.signalCode = signal || null;
        child.stdout.end();
        child.stderr.end();
        child.emit('exit', child.exitCode, child.signalCode);
        child.emit('close', child.exitCode, child.signalCode);
      };
      child.kill = signal => { directSignals.push(signal); exit(signal); return true; };
      child.stdin.once('finish', () => exit());
      child.stdin.once('data', input => {
        assert.equal(JSON.parse(String(input)).event, 'user');
        queueMicrotask(() => {
          if (onInput) onInput({ req, res, child });
          if (rawOutput !== undefined) {
            child.stdout.write(rawOutput);
            return;
          }
          const events = suppliedEvents || [
            { event: 'init', conversation_id: conversationId, init: {
              agent: 'claude-proxy-argon', model: 'gemini-4-argon-high', tools: [],
            } },
            ...['Hello 🌟', '\nWorld'].map(text_delta => ({
              event: 'step_update', step_update: {
                conversation_id: conversationId, step_type: 'agent_response', text_delta,
              },
            })),
            { event: 'result', result: {
              conversation_id: resultId, status: 'SUCCESS', response: answer,
              usage: { input_tokens: 12, output_tokens: 18, thinking_tokens: 8 },
            } },
          ];
          for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`);
        });
      });
      spawned.push({ command, args, options, child, exit });
      return child;
    },
  };
  const handleRoute = createArgonHandler(context);
  return {
    req, res, reads, spawned, errors, treeTerminations, directSignals,
    run: (stream, overrides = {}) => handleRoute(req, res, {
      stream, messages: [{ role: 'user', content: 'A synthetic integration test prompt.' }],
      ...overrides
    }),
    assertStopped() {
      assert.equal(spawned.length, 1);
      assert.equal(fs.existsSync(spawned[0].options.cwd), false, 'request workspace removed');
      assert.ok(spawned[0].child.exitCode !== null || spawned[0].child.signalCode !== null, 'mock child stopped');
      assert.equal(treeTerminations.length, 1, 'Windows process tree is terminated once');
      assert.deepEqual(treeTerminations[0].args, ['/PID', '12345', '/T', '/F']);
      assert.equal(treeTerminations[0].rootWasAlive, true, 'tree cleanup receives a live root');
      assert.equal(treeTerminations[0].inputWasOpen, true, 'stdin stays open until tree termination');
      assert.equal(treeTerminations[0].options.windowsHide, true);
      assert.equal(treeTerminations[0].options.shell, false);
      assert.deepEqual(directSignals, [], 'no premature direct root termination');
      assert.equal(spawned[0].child.exitCode, 1, 'mock Windows tree termination completed');
      assert.equal(req.listenerCount('aborted'), 0);
      assert.equal(res.listenerCount('close'), 0);
    },
    assertClean() {
      this.assertStopped();
      assert.deepEqual(errors, []);
    },
  };
}

const initEvent = { event: 'init', conversation_id: conversationId, init: {
  agent: 'claude-proxy-argon', model: 'gemini-4-argon-high', tools: []
} };

test('invalid stream-json rejects the request and removes the child workspace', async t => {
  const current = harness(t, { rawOutput: 'not-json\n' });
  await current.run(false);
  assert.equal(current.res.status, 502);
  assert.match(JSON.parse(current.res.chunks.join('')).error.message, /not valid stream-json/);
  assert.deepEqual(current.reads, []);
  current.assertStopped();
});

test('unexpected startup model is rejected before response streaming begins', async t => {
  const current = harness(t, { events: [{ ...initEvent, init: { ...initEvent.init, model: 'unexpected-model' } }] });
  await current.run(true);
  assert.equal(current.res.status, 502);
  assert.match(JSON.parse(current.res.chunks.join('')).error.message, /selected a model other than/);
  assert.deepEqual(current.reads, []);
  current.assertStopped();
});

test('unsuccessful CLI result becomes an SSE error after initialization', async t => {
  const current = harness(t, { events: [initEvent, { event: 'result', result: { status: 'ERROR', error: 'Synthetic provider error' } }] });
  await current.run(true);
  assert.equal(current.res.status, 200);
  assert.equal(current.res.events().at(-1).type, 'error');
  assert.match(current.res.events().at(-1).error.message, /Synthetic provider error/);
  assert.equal(current.res.events().some(event => event.type === 'message_stop'), false);
  assert.equal(current.res.endCalls, 1);
  current.assertStopped();
});

test('tool operations are rejected in the conversational CLI session', async t => {
  const current = harness(t, { events: [initEvent, { event: 'step_update', step_update: { step_type: 'tool', tool_info: {} } }] });
  await current.run(false);
  assert.equal(current.res.status, 502);
  assert.match(JSON.parse(current.res.chunks.join('')).error.message, /attempted a tool operation/);
  current.assertStopped();
});

test('disconnect before CLI initialization stops work without writing a response', async t => {
  const current = harness(t, { onInput: ({ res }) => res.disconnect() });
  await current.run(true);
  assert.deepEqual(current.res.chunks, []);
  assert.equal(current.res.endCalls, 0);
  assert.deepEqual(current.reads, []);
  current.assertStopped();
});

test('unsupported request tools and malformed stream values are rejected before spawning Argon', async t => {
  for (const overrides of [
    { tools: [{ name: 'synthetic_tool' }] },
    { tools: {} },
    { tool_choice: { type: 'auto' } },
    { stream: 'true' },
    { messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }
  ]) {
    const current = harness(t);
    await current.run(false, overrides);
    assert.equal(current.res.status, 400);
    assert.equal(JSON.parse(current.res.chunks.join('')).error.type, 'invalid_request_error');
    assert.deepEqual(current.spawned, []);
    assert.deepEqual(current.reads, []);
    assert.equal(current.req.listenerCount('aborted'), 0);
    assert.equal(current.res.listenerCount('close'), 0);
  }
});

test('heartbeat backpressure fails only the stalled request and cleans up the process', async t => {
  const current = harness(t, {
    events: [initEvent],
    onHeartbeat: ({ res }) => { res.writableLength = 4 * 1024 * 1024 + 1; }
  });
  await current.run(true);
  assert.equal(current.res.status, 200);
  assert.equal(current.res.endCalls, 1);
  assert.equal(current.errors.length, 1);
  assert.match(current.errors[0][1], /not consuming the response stream/);
  assert.equal(current.res.events().some(event => event.type === 'message_stop'), false);
  assert.deepEqual(current.reads, []);
  current.assertStopped();
});

test('streamed answer stays intact and late thinking precedes message_stop and response end', async t => {
  const h = harness(t, { readThinking: async ({ args, res }) => {
    assert.deepEqual(args, [conversationId, answer]);
    assert.equal(res.events().filter(e => e.delta?.type === 'text_delta')
      .map(e => e.delta.text).join(''), answer, 'answer has already streamed');
    assert.equal(res.writableEnded, false, 'response remains open while reading reasoning');
    return thinking;
  } });
  await h.run(true);
  assert.equal(h.res.status, 200);
  const events = h.res.events();
  assert.equal(events.filter(e => e.delta?.type === 'text_delta')
    .map(e => e.delta.text).join(''), answer);
  const thoughts = events.filter(e => e.delta?.type === 'thinking_delta');
  assert.deepEqual(thoughts.map(e => e.delta.thinking), [thinking]);
  const thoughtIndex = events.findIndex(e => e.delta?.type === 'thinking_delta');
  const stopIndex = events.findIndex(e => e.type === 'message_stop');
  assert.ok(thoughtIndex > events.findLastIndex(e => e.delta?.type === 'text_delta'));
  assert.ok(stopIndex > thoughtIndex);
  assert.equal(events.at(-1).type, 'message_stop');
  assert.equal(h.res.endCalls, 1);
  assert.equal(h.res.writableEnded, true);
  assert.equal(h.reads.length, 1);
  h.assertClean();
});

test('nonstreaming response returns one thinking block before one complete answer', async t => {
  const h = harness(t);
  await h.run(false);
  const message = JSON.parse(h.res.chunks.join(''));
  assert.equal(h.res.status, 200);
  assert.deepEqual(message.content, [
    { type: 'thinking', thinking, signature: '' },
    { type: 'text', text: answer },
  ]);
  assert.equal(message.stop_reason, 'end_turn');
  assert.deepEqual(message.usage, { input_tokens: 12, output_tokens: 18 });
  assert.deepEqual(h.reads, [[conversationId, answer]]);
  assert.equal(h.res.endCalls, 1);
  h.assertClean();
});

for (const stream of [false, true]) {
  test(`missing reasoning preserves the ${stream ? 'streaming' : 'nonstreaming'} answer`, async t => {
    const h = harness(t, { readThinking: async () => '' });
    await h.run(stream);
    if (stream) {
      assert.equal(h.res.events().some(e => e.delta?.type === 'thinking_delta'), false);
      assert.equal(h.res.events().filter(e => e.delta?.type === 'text_delta')
        .map(e => e.delta.text).join(''), answer);
      assert.equal(h.res.events().at(-1).type, 'message_stop');
    } else {
      assert.deepEqual(JSON.parse(h.res.chunks.join('')).content, [{ type: 'text', text: answer }]);
    }
    assert.equal(h.res.status, 200);
    assert.equal(h.res.endCalls, 1);
    h.assertClean();
  });
}

test('mismatched init/result conversation ids do not read another transcript', async t => {
  const h = harness(t, { resultId: otherConversationId });
  await h.run(false);
  assert.deepEqual(h.reads, []);
  assert.deepEqual(JSON.parse(h.res.chunks.join('')).content, [{ type: 'text', text: answer }]);
  h.assertClean();
});

for (const stream of [false, true]) {
  test(`disconnect during late reasoning read safely stops the ${stream ? 'streaming' : 'nonstreaming'} response`, async t => {
    let readerStarted;
    const started = new Promise(resolve => { readerStarted = resolve; });
    let releaseReader;
    const pending = new Promise(resolve => { releaseReader = resolve; });
    const h = harness(t, { readThinking: () => { readerStarted(); return pending; } });
    const running = h.run(stream);
    await started;
    const chunksBeforeDisconnect = [...h.res.chunks];
    h.res.disconnect();
    releaseReader(thinking);
    await running;
    assert.deepEqual(h.res.chunks, chunksBeforeDisconnect, 'no output after disconnect');
    assert.equal(h.res.endCalls, 0);
    assert.equal(h.res.events().some(e => e.type === 'message_stop'), false);
    assert.equal(h.res.events().some(e => e.delta?.type === 'thinking_delta'), false);
    h.assertClean();
  });
}
