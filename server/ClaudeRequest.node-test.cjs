const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { gzipSync } = require('node:zlib');
const ClaudeRequest = require('./ClaudeRequest');
const Logger = require('./Logger');

Logger.init({ log_level: 'ERROR' });

class ClientResponse extends Writable {
  constructor() {
    super();
    this.headers = {};
    this.chunks = [];
    this.headersSent = false;
    this.statusCode = 200;
  }

  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  removeHeader(name) { delete this.headers[name.toLowerCase()]; }
  getHeaderNames() { return Object.keys(this.headers); }
  getHeaders() { return { ...this.headers }; }
  writeHead(status, headers) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
  }
  _write(chunk, encoding, callback) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

function createManager() {
  return {
    accountId: 'test-account',
    isAuthenticated: () => true,
    getValidAccessToken: async () => 'configured-token'
  };
}

function createTransport(scenarios) {
  const calls = [];
  const request = (options, callback) => {
    const scenario = scenarios[calls.length];
    assert.ok(scenario, 'Unexpected upstream request');
    const outgoing = new EventEmitter();
    outgoing.destroyed = false;
    outgoing.destroy = error => {
      outgoing.destroyed = true;
      if (error) queueMicrotask(() => outgoing.emit('error', error));
    };
    const call = { options, outgoing };
    calls.push(call);
    outgoing.end = payload => {
      call.payload = payload;
      if (scenario.stallHeaders) return;
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = scenario.status ?? 200;
        response.headers = scenario.headers ?? { 'content-type': 'application/json' };
        call.response = response;
        callback(response);
        if (scenario.abort) {
          setImmediate(() => response.destroy(new Error('Connection reset')));
        } else if (!scenario.stallBody) {
          for (const chunk of scenario.chunks ?? [Buffer.from('{}')]) response.write(chunk);
          response.end();
        }
      });
    };
    return outgoing;
  };
  return { request, calls };
}

function incoming(headers = {}) {
  const request = new EventEmitter();
  request.headers = headers;
  return request;
}

test('client credentials are request-local and never overwrite configured account tokens', async () => {
  const manager = createManager();
  const options = { config: {}, oauthManager: manager, fallbackToClaudeCode: false };
  const first = new ClaudeRequest(incoming({ 'x-api-key': 'sk-ant-first-placeholder' }), options);
  const second = new ClaudeRequest(incoming({ 'x-api-key': 'sk-ant-second-placeholder' }), options);
  const headerless = new ClaudeRequest(incoming(), options);
  assert.equal(await first.getAuthToken(), 'Bearer sk-ant-first-placeholder');
  assert.equal(await second.getAuthToken(), 'Bearer sk-ant-second-placeholder');
  assert.equal(await headerless.getAuthToken(), 'Bearer configured-token');
});

test('the manager is consulted on each request so expiry and reauthentication are visible', async () => {
  let token = 'first-placeholder';
  const manager = createManager();
  manager.getValidAccessToken = async () => token;
  const request = new ClaudeRequest(null, { config: {}, oauthManager: manager });
  assert.equal(await request.getAuthToken(), 'Bearer first-placeholder');
  token = 'replacement-placeholder';
  assert.equal(await request.getAuthToken(), 'Bearer replacement-placeholder');
});

test('a proxy password that resembles a provider key is never forwarded upstream', async () => {
  const password = 'sk-ant-local-proxy-password';
  const request = new ClaudeRequest(incoming({ 'x-api-key': password }), {
    config: { proxy_api_key: password }, oauthManager: createManager()
  });
  assert.equal(await request.getAuthToken(), 'Bearer configured-token');
});

test('Claude 2 never reads primary credentials when it has no stored account', async () => {
  const manager = createManager();
  manager.isAuthenticated = () => false;
  const request = new ClaudeRequest(null, {
    config: {}, oauthManager: manager, accountId: 'claude2', fallbackToClaudeCode: false
  });
  request.loadCredentialsFromFile = () => assert.fail('Primary credentials must not be accessed');
  await assert.rejects(request.getAuthToken(), /No authentication tokens found/);
});

test('body preparation preserves cache markers, leaves inputs untouched and normalizes string system prompts', () => {
  const request = new ClaudeRequest(null, { config: {}, oauthManager: createManager() });
  request.loadPreset = () => ({ system: 'preset', suffix: 'suffix' });
  const body = {
    system: [{ type: 'text', text: 'instructions', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'question', cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
    tools: [{ name: 'example', cache_control: { type: 'ephemeral' } }],
    cache_control: { type: 'ephemeral' }
  };
  const original = structuredClone(body);
  const processed = request.processRequestBody(body, 'test');
  assert.deepEqual(request.processRequestBody(body, 'test'), processed);
  assert.deepEqual(body, original);
  assert.deepEqual(processed.system[1].cache_control, { type: 'ephemeral' });
  assert.deepEqual(processed.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(processed.tools, body.tools);
  assert.deepEqual(processed.cache_control, body.cache_control);
  assert.equal(processed.system.length, 3);
  assert.equal(processed.messages.length, 2);
  const stringSystem = request.processRequestBody({ system: 'plain text', messages: [] });
  assert.deepEqual(stringSystem.system[1], { type: 'text', text: 'plain text' });
});

test('beta headers preserve client features without duplicate caching entries', () => {
  const request = new ClaudeRequest(incoming({ 'anthropic-beta': 'custom-beta,prompt-caching-2024-07-31,custom-beta' }), {
    config: {}, oauthManager: createManager()
  });
  const betas = request.getHeaders('placeholder')['anthropic-beta'].split(',');
  assert.equal(betas.filter(beta => beta === 'custom-beta').length, 1);
  assert.equal(betas.filter(beta => beta === 'prompt-caching-2024-07-31').length, 1);
});

test('401 retry sends identical prepared bytes and refreshes the rejected token', async () => {
  const transport = createTransport([{ status: 401, stallBody: true }, {}]);
  const manager = createManager();
  manager.getValidAccessToken = async options => options.rejectedToken === 'old-placeholder'
    ? 'new-placeholder' : 'old-placeholder';
  const request = new ClaudeRequest(incoming(), { config: {}, oauthManager: manager, request: transport.request });
  request.loadPreset = () => ({ system: 'preset', suffix: 'suffix' });
  const body = { system: 'instructions', messages: [{ role: 'user', content: 'hello' }] };
  const original = structuredClone(body);
  const response = new ClientResponse();
  await request.handleResponse(response, body, 'example');
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[0].payload, transport.calls[1].payload);
  assert.equal(transport.calls[0].response.destroyed, true);
  assert.equal(transport.calls[1].options.headers.Authorization, 'Bearer new-placeholder');
  assert.deepEqual(body, original);
  assert.equal(response.statusCode, 200);
});

test('a rejected request-local key is not retried with configured credentials', async () => {
  const transport = createTransport([{ status: 401 }]);
  const manager = createManager();
  manager.getValidAccessToken = () => assert.fail('A request override must not fall back to another account');
  const request = new ClaudeRequest(incoming({ 'x-api-key': 'sk-ant-override-placeholder' }), {
    config: {}, oauthManager: manager, request: transport.request
  });
  const response = new ClientResponse();
  await request.handleResponse(response, { messages: [] });
  assert.equal(transport.calls.length, 1);
  assert.equal(response.statusCode, 401);
});

test('JSON bytes, split Unicode and Content-Length survive forwarding unchanged', async () => {
  const bytes = Buffer.from('{\n  "text": "é🙂", "escaped": "\\u0061"\n}');
  const transport = createTransport([{
    headers: { 'content-type': 'application/json', 'content-length': String(bytes.length), connection: 'keep-alive, custom-hop', 'custom-hop': 'hidden' },
    chunks: [...bytes].map(byte => Buffer.from([byte]))
  }]);
  const request = new ClaudeRequest(incoming(), { config: {}, oauthManager: createManager(), request: transport.request });
  const response = new ClientResponse();
  await request.handleResponse(response, { messages: [] });
  assert.deepEqual(Buffer.concat(response.chunks), bytes);
  assert.equal(response.headers['content-length'], String(bytes.length));
  assert.equal(response.headers.connection, undefined);
  assert.equal(response.headers['custom-hop'], undefined);
});

test('compressed replies keep original bytes and content encoding', async () => {
  const bytes = gzipSync(Buffer.from('{"text":"hello"}'));
  const transport = createTransport([{
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(bytes.length) },
    chunks: [bytes]
  }]);
  const request = new ClaudeRequest(null, { config: {}, oauthManager: createManager(), request: transport.request });
  const response = new ClientResponse();
  await request.handleResponse(response, { messages: [] });
  assert.deepEqual(Buffer.concat(response.chunks), bytes);
  assert.equal(response.headers['content-encoding'], 'gzip');
});

test('timeouts abort stalled upstream headers and return 504', async () => {
  const transport = createTransport([{ stallHeaders: true }]);
  const request = new ClaudeRequest(incoming(), { config: { claude_timeout_ms: 20 }, oauthManager: createManager(), request: transport.request });
  const response = new ClientResponse();
  await request.handleResponse(response, { messages: [] });
  assert.equal(response.statusCode, 504);
  assert.equal(transport.calls[0].outgoing.destroyed, true);
});

test('timeouts also cover an authentication wait without starting a provider request', async () => {
  const manager = createManager();
  manager.getValidAccessToken = () => new Promise(() => {});
  const request = new ClaudeRequest(incoming(), {
    config: { claude_timeout_ms: 20 }, oauthManager: manager,
    request: () => assert.fail('Timed-out authentication must not start a provider request')
  });
  const response = new ClientResponse();
  await request.handleResponse(response, { messages: [] });
  assert.equal(response.statusCode, 504);
});

test('timeouts abort an upstream body that stalls after headers', async () => {
  const transport = createTransport([{ stallBody: true, headers: { 'content-length': '1000' } }]);
  const request = new ClaudeRequest(incoming(), {
    config: { claude_timeout_ms: 20 }, oauthManager: createManager(), request: transport.request
  });
  const response = new ClientResponse();
  await request.handleResponse(response, { messages: [] });
  assert.equal(response.statusCode, 504);
  assert.equal(transport.calls[0].response.destroyed, true);
  assert.equal(response.headers['content-length'], undefined);
});

test('disconnects abort upstream requests before headers arrive', async () => {
  const transport = createTransport([{ stallHeaders: true }]);
  const source = incoming();
  const request = new ClaudeRequest(source, { config: {}, oauthManager: createManager(), request: transport.request });
  const response = new ClientResponse();
  const completion = request.handleResponse(response, { messages: [] });
  await new Promise(resolve => setImmediate(resolve));
  response.destroy();
  await completion;
  assert.equal(transport.calls[0].outgoing.destroyed, true);
  assert.equal(source.listenerCount('aborted'), 0);
});

test('streaming disconnects abort the upstream body', async () => {
  const transport = createTransport([{ headers: { 'content-type': 'text/event-stream' }, stallBody: true }]);
  const request = new ClaudeRequest(incoming(), { config: {}, oauthManager: createManager(), request: transport.request });
  const response = new ClientResponse();
  const completion = request.handleResponse(response, { messages: [] });
  await new Promise(resolve => setImmediate(resolve));
  response.destroy();
  await completion;
  assert.equal(transport.calls[0].response.destroyed, true);
});

test('upstream failure before body bytes clears stale content headers', async () => {
  const transport = createTransport([{ abort: true, headers: { 'content-encoding': 'gzip', 'content-length': '999' } }]);
  const request = new ClaudeRequest(null, { config: {}, oauthManager: createManager(), request: transport.request });
  const response = new ClientResponse();
  response.setHeader('Access-Control-Allow-Origin', 'http://localhost:8000');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  await request.handleResponse(response, { messages: [] });
  assert.equal(response.statusCode, 502);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(response.headers['content-length'], undefined);
  assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:8000');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});

test('synchronous transport failures settle without leaking the request timer', async () => {
  const request = new ClaudeRequest(null, {
    config: {}, oauthManager: createManager(),
    request: () => { throw new Error('Synchronous request failure'); }
  });
  const response = new ClientResponse();
  await request.handleResponse(response, { messages: [] });
  assert.equal(response.statusCode, 502);
});

test('shared configuration string booleans control fallback and sampling filtering', () => {
  const request = new ClaudeRequest(null, {
    config: { fallback_to_claude_code: 'false', filter_sampling_params: 'true' }, oauthManager: createManager()
  });
  assert.equal(request.fallbackToClaudeCode, false);
  const processed = request.processRequestBody({ messages: [], temperature: 0.5, top_p: 1 });
  assert.equal(processed.temperature, 0.5);
  assert.equal(processed.top_p, undefined);
});
