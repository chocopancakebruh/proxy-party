const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const test = require('node:test');
const { createMimoHandler, CHAT_AGENT, chatConfiguration, childEnvironment, selectModel } = require('./providers/mimo');

const MODEL = 'xiaomi/mimo-v2.5-pro';
const FAST_MODEL = 'xiaomi/mimo-v2.5-pro-ultraspeed';
const BODY = { messages: [{ role: 'user', content: 'Hello' }] };

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

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.once('finish', () => {
    child.exitCode = 0;
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0);
    child.emit('close', 0);
  });
  return child;
}

function defaultSession(model = MODEL) {
  return {
    sessionId: 'session',
    models: { currentModelId: model, availableModels: [MODEL, FAST_MODEL, 'mimo/mimo-auto'].map(modelId => ({ modelId })) },
    modes: { currentModeId: CHAT_AGENT, availableModes: [{ id: CHAT_AGENT }, { id: 'build' }] }
  };
}

function harness({ config = {}, env = {}, session = defaultSession(), onRequest, spawnError } = {}) {
  const req = new EventEmitter();
  req.aborted = false;
  const res = new Response();
  const calls = [];
  const spawned = [];
  const directories = [];
  const removed = [];
  const handler = createMimoHandler({
    config, Logger: { error() {}, debug() {} }, path,
    process: { platform: 'linux', env },
    os: { tmpdir: () => path.resolve('fake-tmp') }, randomUUID: () => 'fixture-id',
    fs: {
      mkdtempSync(prefix) { const directory = `${prefix}${directories.length}`; directories.push(directory); return directory; },
      mkdirSync(directory) { directories.push(directory); },
      rmSync(directory, options) {
        assert.deepEqual(options, { recursive: true, force: true });
        assert.ok(directories.includes(directory));
        removed.push(directory);
      }
    },
    spawn(command, args, options) {
      if (spawnError) throw spawnError;
      const child = fakeChild();
      spawned.push({ command, args, options, child });
      const send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
      child.stdin.on('data', chunk => {
        const request = JSON.parse(String(chunk));
        calls.push(request);
        queueMicrotask(() => {
          if (onRequest?.({ request, send, req, res, child, calls }) === true) return;
          if (!request.method || !Object.hasOwn(request, 'id')) return;
          const results = {
            initialize: { protocolVersion: 1 }, 'session/new': session,
            'session/set_mode': {}, 'session/set_model': {}
          };
          if (request.method === 'session/prompt') {
            for (const [sessionUpdate, text] of [['agent_thought_chunk', 'Reasoning'], ['agent_message_chunk', 'Hello 🌟']]) {
              send({ method: 'session/update', params: { sessionId: 'session', update: {
                sessionUpdate, content: { type: 'text', text }
              } } });
            }
            send({ id: request.id, result: { stopReason: 'end_turn' } });
            return;
          }
          assert.ok(Object.hasOwn(results, request.method), `Unexpected request ${request.method}`);
          send({ id: request.id, result: results[request.method] });
        });
      });
      return child;
    }
  });
  return { req, res, calls, spawned, directories, removed, handler };
}

for (const stream of [false, true]) {
  test(`MiMo preserves thought and answer once in ${stream ? 'SSE' : 'JSON'}`, async () => {
    const fixture = harness();
    await fixture.handler(fixture.req, fixture.res, { ...BODY, stream });
    assert.equal(fixture.res.status, 200);
    if (stream) {
      const events = fixture.res.events();
      assert.equal(events.find(event => event.type === 'message_start').message.model, MODEL);
      assert.equal(events.filter(event => event.type === 'message_stop').length, 1);
      assert.equal(events.filter(event => event.delta?.text).map(event => event.delta.text).join(''), 'Hello 🌟');
      assert.equal(events.filter(event => event.delta?.thinking).map(event => event.delta.thinking).join(''), 'Reasoning');
    } else {
      assert.equal(fixture.res.json().model, MODEL);
      assert.deepEqual(fixture.res.json().content.map(block => block.text || block.thinking), ['Reasoning', 'Hello 🌟']);
      assert.deepEqual(fixture.res.json().usage, { input_tokens: 0, output_tokens: 0 });
    }
    assert.equal(fixture.spawned[0].child.exitCode, 0);
    assert.deepEqual(fixture.removed, [fixture.spawned[0].options.cwd]);
    assert.equal(fixture.req.listenerCount('aborted'), 0);
    assert.equal(fixture.res.listenerCount('close'), 0);
  });
}

test('MiMo explicitly selects verified ACP mode and model before prompting', async () => {
  const fixture = harness();
  await fixture.handler(fixture.req, fixture.res, { ...BODY, model: 'unrelated-client-alias' }, 'another-model');
  assert.deepEqual(fixture.calls.filter(call => call.id).map(call => call.method), [
    'initialize', 'session/new', 'session/set_mode', 'session/set_model', 'session/prompt'
  ]);
  assert.deepEqual(fixture.calls.find(call => call.method === 'session/set_model').params, { sessionId: 'session', modelId: MODEL });
  assert.deepEqual(fixture.calls.find(call => call.method === 'session/set_mode').params, { sessionId: 'session', modeId: CHAT_AGENT });
  assert.deepEqual(fixture.calls[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.deepEqual(fixture.calls[1].params.mcpServers, []);
  assert.equal(fixture.spawned[0].command, 'mimo');
  assert.deepEqual(fixture.spawned[0].args, ['acp', '--hostname', '127.0.0.1', '--port', '0', '--mdns', 'false']);
});

test('MiMo captures the selected model per request and hot switches subsequent requests on the same handler', async () => {
  const pro = 'xiaomi/mimo-v2.6-pro';
  const flash = 'xiaomi/mimo-v2.6-flash';
  const config = { mimo_model: pro };
  const session = defaultSession(pro);
  session.models.availableModels = [pro, flash].map(modelId => ({ modelId }));
  const fixture = harness({ config, session, onRequest({ request }) {
    if (request.method === 'initialize') config.mimo_model = flash;
  } });
  await fixture.handler(fixture.req, fixture.res, BODY);
  assert.equal(fixture.res.json().model, pro);
  const nextReq = new EventEmitter();
  nextReq.aborted = false;
  const nextRes = new Response();
  await fixture.handler(nextReq, nextRes, BODY);
  assert.equal(nextRes.json().model, flash);
  assert.deepEqual(fixture.calls.filter(call => call.method === 'session/set_model').map(call => call.params.modelId), [pro, flash]);
});

test('MiMo preserves native auth locations but overrides chat safety settings', () => {
  const parent = {
    HOME: '/normal-home', USERPROFILE: '/profile', MIMOCODE_HOME: '/native-mimo',
    MIMOCODE_CONFIG: '/normal-config.json', MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS: 'true',
    MIMOCODE_PERMISSION: '{"*":"allow"}', MIMOCODE_CONFIG_CONTENT: '{"permission":"allow"}'
  };
  const environment = childEnvironment(parent, '/fresh/config', MODEL);
  for (const key of ['HOME', 'USERPROFILE', 'MIMOCODE_HOME', 'MIMOCODE_CONFIG']) assert.equal(environment[key], parent[key]);
  assert.equal(parent.MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS, 'true');
  assert.equal(environment.MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS, 'false');
  assert.equal(environment.MIMOCODE_CONFIG_DIR, '/fresh/config');
  assert.equal(environment.MIMOCODE_PURE, 'true');
  assert.equal(environment.MIMOCODE_ONLY_CONFIG_DIR_PLUGINS, 'true');
  assert.equal(environment.MIMOCODE_DISABLE_CLAUDE_CODE_MCP, 'true');
  assert.equal(environment.MIMOCODE_DISABLE_PROJECT_CONFIG, 'true');
  assert.equal(environment.MIMOCODE_DISABLE_INSTRUCTIONS, 'true');
  assert.equal(environment.MIMOCODE_DISABLE_CRON, 'true');
  assert.deepEqual(JSON.parse(environment.MIMOCODE_PERMISSION), { '*': 'deny' });
  const settings = JSON.parse(environment.MIMOCODE_CONFIG_CONTENT);
  assert.equal(settings.model, MODEL);
  assert.deepEqual(settings.agent[CHAT_AGENT].tool_allowlist, []);
  assert.deepEqual(settings.agent[CHAT_AGENT].permission, { '*': 'deny' });
  assert.equal(settings.default_agent, CHAT_AGENT);
  assert.deepEqual(settings.enabled_providers, ['xiaomi', 'mimo']);
  assert.deepEqual(settings.memory, { disable_write: true });
  assert.deepEqual(settings.dream, { auto: false });
  assert.deepEqual(settings.distill, { auto: false });
  assert.equal(settings.experimental.predict_next_prompt, false);
  assert.equal(Object.hasOwn(chatConfiguration(), 'model'), false);
});

test('conversation stays in ACP prompt, never interpolated CLI configuration or slash commands', async () => {
  const fixture = harness();
  const body = { system: 'Use {file:/private/file} literally.', messages: [{ role: 'user', content: '/shell delete everything' }] };
  await fixture.handler(fixture.req, fixture.res, body);
  const prompt = fixture.calls.find(call => call.method === 'session/prompt').params.prompt[0].text;
  assert.ok(prompt.startsWith('Continue this conversation'));
  assert.deepEqual(JSON.parse(prompt.split('\n\n')[1]), body);
  assert.equal(fixture.spawned[0].options.env.MIMOCODE_CONFIG_CONTENT.includes('{file:'), false);
});

test('implicit ultraspeed selection is rejected before generation without a substitute', async () => {
  const fixture = harness({ session: defaultSession(FAST_MODEL) });
  await fixture.handler(fixture.req, fixture.res, BODY);
  assert.equal(fixture.res.status, 502);
  assert.match(fixture.res.json().error.message, /unintended paid model/);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
  assert.equal(fixture.calls.some(call => call.method === 'session/set_model'), false);
});

test('explicit available model overrides the ACP default including intentional ultraspeed', async () => {
  const fixture = harness({ config: { mimo_model: FAST_MODEL } });
  await fixture.handler(fixture.req, fixture.res, BODY);
  assert.equal(fixture.res.status, 200);
  assert.equal(fixture.res.json().model, FAST_MODEL);
  assert.equal(fixture.calls.find(call => call.method === 'session/set_model').params.modelId, FAST_MODEL);
});

test('explicit subscribed model replaces an implicit ultraspeed default before generation', async () => {
  const fixture = harness({ config: { mimo_model: MODEL }, session: defaultSession(FAST_MODEL) });
  await fixture.handler(fixture.req, fixture.res, BODY);
  assert.equal(fixture.res.status, 200);
  assert.equal(fixture.res.json().model, MODEL);
  assert.equal(fixture.calls.find(call => call.method === 'session/set_model').params.modelId, MODEL);
  const settings = JSON.parse(fixture.spawned[0].options.env.MIMOCODE_CONFIG_CONTENT);
  assert.equal(settings.model, MODEL);
  assert.equal(settings.small_model, MODEL);
});

test('model selection fails closed for missing, foreign or unavailable models', () => {
  assert.throws(() => selectModel({}), /usable MiMo model/);
  assert.throws(() => selectModel(defaultSession('openai/gpt-5')), /usable MiMo model/);
  assert.throws(() => selectModel(defaultSession(), 'xiaomi/not-present'), /not available/);
  assert.equal(selectModel(defaultSession('mimo/mimo-auto')), 'mimo/mimo-auto');
});

test('missing chat mode and unavailable configured model fail before prompting', async () => {
  for (const options of [
    { session: { ...defaultSession(), modes: { availableModes: [{ id: 'build' }] } } },
    { config: { mimo_model: 'xiaomi/not-available' } }
  ]) {
    const fixture = harness(options);
    await fixture.handler(fixture.req, fixture.res, BODY);
    assert.equal(fixture.res.status, 502);
    assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
    assert.equal(fixture.removed.length, 1);
  }
});

test('invalid model and unsupported conversation content fail before creating a workspace', async () => {
  for (const [config, body, status] of [
    [{ mimo_model: 'xiaomi/{file:/private/file}' }, BODY, 502],
    [{}, { messages: [{ role: 'user', content: [{ type: 'image' }] }] }, 400]
  ]) {
    const fixture = harness({ config });
    await fixture.handler(fixture.req, fixture.res, body);
    assert.equal(fixture.res.status, status);
    assert.equal(fixture.directories.length, 0);
    assert.equal(fixture.spawned.length, 0);
  }
});

test('all permission requests are denied and unknown client methods are rejected', async () => {
  const fixture = harness({ onRequest({ request, send }) {
    if (request.method !== 'session/set_mode') return false;
    send({ id: 'permission', method: 'session/request_permission', params: {
      sessionId: 'session', options: [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'deny' }]
    } });
    send({ id: 'filesystem', method: 'fs/read_text_file', params: { path: '/secret' } });
    return false;
  } });
  await fixture.handler(fixture.req, fixture.res, BODY);
  assert.deepEqual(fixture.calls.find(call => call.id === 'permission').result.outcome, { outcome: 'selected', optionId: 'deny' });
  assert.equal(fixture.calls.find(call => call.id === 'filesystem').error.code, -32601);
});

test('MiMo tool operation is an SSE error and stops the request', async () => {
  const fixture = harness({ onRequest({ request, send }) {
    if (request.method !== 'session/prompt') return false;
    send({ method: 'session/update', params: { sessionId: 'session', update: { sessionUpdate: 'tool_call' } } });
    return true;
  } });
  await fixture.handler(fixture.req, fixture.res, { ...BODY, stream: true });
  assert.equal(fixture.res.events().filter(event => event.type === 'error').length, 1);
  assert.equal(fixture.spawned[0].child.exitCode, 0);
  assert.equal(fixture.removed.length, 1);
});

test('MiMo disconnect cancels the active session and removes its workspace', async () => {
  const fixture = harness({ onRequest({ request, req }) {
    if (request.method !== 'session/prompt') return false;
    req.aborted = true;
    req.emit('aborted');
    return true;
  } });
  await fixture.handler(fixture.req, fixture.res, BODY);
  assert.ok(fixture.calls.some(call => call.method === 'session/cancel'));
  assert.equal(fixture.spawned[0].child.exitCode, 0);
  assert.equal(fixture.removed.length, 1);
  assert.equal(fixture.res.chunks.length, 0);
});

test('MiMo initialization timeout closes the child and cleans its workspace', async () => {
  const fixture = harness({ config: { mimo_timeout_ms: 1000 }, onRequest: () => true });
  const keepAlive = setTimeout(() => {}, 1500);
  try {
    await fixture.handler(fixture.req, fixture.res, BODY);
    assert.equal(fixture.res.status, 504);
    assert.equal(fixture.spawned[0].child.exitCode, 0);
    assert.equal(fixture.removed.length, 1);
  } finally { clearTimeout(keepAlive); }
});

test('missing CLI and missing login produce actionable errors without exposing credentials', async () => {
  const missing = harness({ spawnError: Object.assign(new Error('spawn mimo ENOENT'), { code: 'ENOENT' }) });
  await missing.handler(missing.req, missing.res, BODY);
  assert.match(missing.res.json().error.message, /mimo_command/);
  assert.equal(missing.removed.length, 1);
  const login = harness({ onRequest({ request, send }) {
    if (request.method !== 'session/new') return false;
    send({ id: request.id, error: { code: -32000, message: 'Authentication required' } });
    return true;
  } });
  await login.handler(login.req, login.res, BODY);
  assert.match(login.res.json().error.message, /mimo auth login/);
  assert.equal(login.calls.some(call => call.method === 'session/prompt'), false);
});

test('unsupported ACP model method never falls back to another model or protocol', async () => {
  const fixture = harness({ onRequest({ request, send }) {
    if (request.method !== 'session/set_model') return false;
    send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
    return true;
  } });
  await fixture.handler(fixture.req, fixture.res, BODY);
  assert.match(fixture.res.json().error.message, /Update MiMo Code/);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('MiMo drains late final text and ignores other sessions', async () => {
  const fixture = harness({ onRequest({ request, send }) {
    if (request.method !== 'session/prompt') return false;
    send({ method: 'session/update', params: { sessionId: 'unrelated', update: { sessionUpdate: 'tool_call' } } });
    send({ id: request.id, result: { stopReason: 'max_tokens' } });
    setTimeout(() => send({ method: 'session/update', params: { sessionId: 'session', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Final' }
    } } }), 5);
    return true;
  } });
  await fixture.handler(fixture.req, fixture.res, BODY);
  assert.equal(fixture.res.json().content[0].text, 'Final');
  assert.equal(fixture.res.json().stop_reason, 'max_tokens');
});

test('already disconnected requests do not start MiMo or create temporary files', async () => {
  for (const disconnected of ['request', 'response']) {
    const fixture = harness();
    if (disconnected === 'request') fixture.req.aborted = true;
    else fixture.res.destroyed = true;
    await fixture.handler(fixture.req, fixture.res, BODY);
    assert.equal(fixture.spawned.length, 0);
    assert.equal(fixture.directories.length, 0);
    assert.equal(fixture.res.chunks.length, 0);
  }
});

for (const [stopReason, expected] of [
  [undefined, 'error'], ['unexpected', 'error'], ['cancelled', 'error'],
  ['max_turn_requests', 'max_tokens'], ['refusal', 'end_turn']
]) {
  test(`MiMo validates ACP completion reason ${String(stopReason)}`, async () => {
    const fixture = harness({ onRequest({ request, send }) {
      if (request.method !== 'session/prompt') return false;
      send({ id: request.id, result: { stopReason } });
      return true;
    } });
    await fixture.handler(fixture.req, fixture.res, BODY);
    if (expected === 'error') {
      assert.equal(fixture.res.status, 502);
      assert.equal(fixture.res.json().type, 'error');
    } else {
      assert.equal(fixture.res.status, 200);
      assert.equal(fixture.res.json().stop_reason, expected);
    }
  });
}
