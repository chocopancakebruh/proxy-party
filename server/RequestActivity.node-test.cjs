const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const {
  createRequestActivity, markActivityFailure, PROVIDER_IDS, ERROR_CATEGORIES
} = require('./RequestActivity');
const { writeAnthropicEvent } = require('./providers/AnthropicStream');
const { sendError } = require('./providers/common');
const ClaudeRequest = require('./ClaudeRequest');
const Logger = require('./Logger');

class Response extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headersSent = false;
    this.destroyed = false;
    this.writableEnded = false;
    this.writableFinished = false;
    this.writableLength = 0;
  }
  writeHead(status) { this.statusCode = status; this.headersSent = true; }
  write() { this.headersSent = true; }
  end() {
    this.headersSent = true;
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit('finish');
  }
}

class StreamResponse extends Writable {
  constructor() {
    super();
    this.headers = {};
    this.headersSent = false;
    this.statusCode = 200;
  }
  getHeaders() { return { ...this.headers }; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  removeHeader(name) { delete this.headers[name.toLowerCase()]; }
  writeHead(status) { this.statusCode = status; this.headersSent = true; }
  _write(chunk, encoding, callback) { this.headersSent = true; callback(); }
}

function request() {
  const req = new EventEmitter();
  req.aborted = false;
  return req;
}

function fixture(options) {
  const activity = createRequestActivity(options);
  const req = request();
  const res = new Response();
  const handle = activity.track(req, res, { providerId: 'claude1' });
  return { activity, req, res, handle };
}

function row(activity) { return activity.list().requests[0]; }

test('records only fixed metadata, with live elapsed time and stable completed duration', () => {
  let current = Date.UTC(2026, 9, 16, 12);
  const { activity, res, handle } = fixture({ now: () => current });
  const initial = row(activity);
  assert.deepEqual(Object.keys(initial).sort(), [
    'durationMs', 'httpStatus', 'id', 'providerId', 'startedAt', 'status', 'streaming'
  ]);
  assert.match(initial.id, /^[a-f\d-]{36}$/);
  assert.equal(initial.startedAt, '2026-10-16T12:00:00.000Z');
  assert.equal(initial.status, 'running');
  assert.equal(initial.httpStatus, null);
  assert.equal(activity.activeCount(), 1);
  current += 125;
  handle.setStreaming(true);
  assert.equal(row(activity).durationMs, 125);
  assert.equal(row(activity).streaming, true);
  res.end();
  current += 500;
  assert.equal(row(activity).durationMs, 125);
  assert.equal(row(activity).httpStatus, 200);
  assert.equal(row(activity).status, 'success');
  assert.equal(activity.activeCount(), 0);
});

test('all eight supported provider IDs are accepted and arbitrary provider input is rejected safely', () => {
  const activity = createRequestActivity();
  for (const providerId of PROVIDER_IDS) {
    const res = new Response();
    activity.track(request(), res, { providerId });
    res.end();
  }
  assert.equal(activity.list().requests.length, 8);
  assert.throws(() => activity.track(request(), new Response(), { providerId: 'secret-provider' }),
    { message: 'Unknown activity provider' });
  assert.equal(JSON.stringify(activity.list()).includes('secret-provider'), false);
  assert.equal(activity.activeCount(), 0);
});

test('never inspects request contents or stores untrusted metadata, error messages, or response content', () => {
  const activity = createRequestActivity();
  const req = request();
  const res = new Response();
  for (const field of ['headers', 'body', 'url', 'method', 'model', 'presetName', 'socket']) {
    Object.defineProperty(req, field, { get() { throw new Error(`Read forbidden field: ${field}`); } });
  }
  for (const field of ['headers', 'body', 'chunks', 'message']) {
    Object.defineProperty(res, field, { get() { throw new Error(`Read forbidden field: ${field}`); } });
  }
  const handle = activity.track(req, res, {
    providerId: 'muse', streaming: 'secret-streaming',
    model: 'secret-model', presetName: 'secret-preset', prompt: 'secret-prompt',
    headers: { authorization: 'Bearer secret-token' }, url: '/secret?key=secret-query'
  });
  handle.setStreaming('secret-streaming');
  const error = new Error('secret-error-with-prompt');
  Object.defineProperty(error, 'message', { get() { throw new Error('Read error.message'); } });
  handle.fail(error);
  markActivityFailure(res, 'secret-category');
  res.end('secret-completion');
  const saved = row(activity);
  assert.equal(saved.streaming, false);
  assert.equal(saved.errorCategory, 'upstream_error');
  assert.equal(JSON.stringify(activity.list()).includes('secret'), false);
  assert.equal(Object.keys(res).some(key => /activity/i.test(key)), false);
});

test('returned snapshots cannot mutate or add fields to stored history', () => {
  const { activity } = fixture();
  const snapshot = activity.list();
  snapshot.requests[0].providerId = 'secret-provider';
  snapshot.requests[0].token = 'secret-token';
  snapshot.requests.push({ prompt: 'secret-prompt' });
  assert.equal(activity.list().requests.length, 1);
  assert.equal(row(activity).providerId, 'claude1');
  assert.equal(JSON.stringify(activity.list()).includes('secret'), false);
});

test('history is newest-first, bounded at 100, and does not lose active counts when evicted', () => {
  const activity = createRequestActivity({ limit: 1000 });
  const responses = [];
  for (let index = 0; index < 105; index += 1) {
    const res = new Response();
    responses.push(res);
    activity.track(request(), res, { providerId: index === 104 ? 'mimo' : 'codex' });
  }
  assert.equal(activity.list().requests.length, 100);
  assert.equal(row(activity).providerId, 'mimo');
  assert.equal(activity.activeCount(), 105);
  for (const res of responses) res.end();
  assert.equal(activity.activeCount(), 0);
  assert.equal(activity.list().requests.every(entry => entry.status === 'success'), true);
});

test('custom history limits are honored and invalid limits use the bounded default', () => {
  for (const limit of [2, 0, -1, NaN, Infinity, 'secret-limit']) {
    const activity = createRequestActivity({ limit });
    for (let index = 0; index < 101; index += 1) {
      const res = new Response();
      activity.track(request(), res, { providerId: 'kimi' });
      res.end();
    }
    assert.equal(activity.list().requests.length, limit === 2 ? 2 : 100);
  }
});

test('clear removes rows without stopping active requests or reinserting them on completion', () => {
  const { activity, res } = fixture();
  activity.clear();
  assert.deepEqual(activity.list(), { requests: [] });
  assert.equal(activity.activeCount(), 1);
  res.end();
  assert.equal(activity.activeCount(), 0);
  assert.deepEqual(activity.list(), { requests: [] });
});

test('finish wins over subsequent close, abort, and failure notifications', () => {
  const { activity, req, res, handle } = fixture();
  res.end();
  res.emit('close');
  req.emit('aborted');
  handle.fail('timeout');
  handle.setStreaming(true);
  markActivityFailure(res, 'upstream_error');
  assert.equal(row(activity).status, 'success');
  assert.equal(row(activity).streaming, false);
  assert.equal(activity.activeCount(), 0);
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(res.listenerCount('finish'), 0);
});

test('a premature close or request abort is cancelled, even if finish subsequently fires', () => {
  for (const event of ['close', 'aborted']) {
    const { activity, req, res } = fixture();
    (event === 'close' ? res : req).emit(event);
    res.end();
    assert.equal(row(activity).status, 'cancelled');
    assert.equal(row(activity).errorCategory, 'cancelled');
    assert.equal(row(activity).httpStatus, null);
    assert.equal(activity.activeCount(), 0);
  }
});

test('cancelled streaming responses retain only the already-sent HTTP status', () => {
  const { activity, res, handle } = fixture();
  handle.setStreaming(true);
  res.writeHead(200);
  res.emit('close');
  assert.equal(row(activity).status, 'cancelled');
  assert.equal(row(activity).httpStatus, 200);
  assert.equal(row(activity).streaming, true);
});

test('known HTTP error statuses become safe categories', () => {
  for (const [status, category] of [[400, 'invalid_request'], [401, 'authentication'],
    [403, 'authentication'], [408, 'timeout'], [413, 'invalid_request'],
    [500, 'upstream_error'], [504, 'timeout']]) {
    const { activity, res } = fixture();
    res.writeHead(status);
    res.end();
    assert.equal(row(activity).status, 'error');
    assert.equal(row(activity).errorCategory, category);
    assert.equal(row(activity).httpStatus, status);
  }
});

test('invalid HTTP statuses are not persisted or treated as successful', () => {
  for (const status of [NaN, Infinity, 0, 999, 'secret-http-status']) {
    const { activity, res } = fixture();
    res.statusCode = status;
    res.end();
    assert.equal(row(activity).httpStatus, null);
    assert.equal(row(activity).status, 'error');
    assert.equal(JSON.stringify(activity.list()).includes('secret'), false);
  }
});

test('explicit failure remains an error when a streamed response is destroyed', () => {
  const { activity, res } = fixture();
  res.writeHead(200);
  markActivityFailure(res, 'timeout');
  markActivityFailure(res, 'upstream_error');
  res.emit('close');
  assert.equal(row(activity).status, 'error');
  assert.equal(row(activity).errorCategory, 'timeout');
});

test('safe categories are allowlisted and unknown failures become a generic category', () => {
  for (const category of [...ERROR_CATEGORIES, undefined, 'secret-error', { message: 'secret-error' }]) {
    const { activity, res, handle } = fixture();
    handle.fail(category);
    res.end();
    assert.equal(row(activity).status, category === 'cancelled' ? 'cancelled' : 'error');
    assert.equal(row(activity).errorCategory, ERROR_CATEGORIES.includes(category) ? category : 'upstream_error');
    assert.equal(JSON.stringify(activity.list()).includes('secret'), false);
  }
  assert.doesNotThrow(() => markActivityFailure(new Response(), 'secret-error'));
});

test('responses already aborted, destroyed, or completed are finalized without listener leaks', () => {
  for (const state of ['aborted', 'destroyed', 'writableFinished']) {
    const activity = createRequestActivity();
    const req = request();
    const res = new Response();
    (state === 'aborted' ? req : res)[state] = true;
    activity.track(req, res, { providerId: 'grok' });
    assert.equal(activity.activeCount(), 0);
    assert.equal(row(activity).status, state === 'writableFinished' ? 'success' : 'cancelled');
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('finish'), 0);
  }
});

test('tracking the same response twice does not double count or copy new metadata', () => {
  const { activity, req, res, handle } = fixture();
  assert.equal(activity.track(req, res, { providerId: 'muse' }), handle);
  assert.equal(activity.list().requests.length, 1);
  assert.equal(activity.activeCount(), 1);
  res.end();
  assert.equal(activity.activeCount(), 0);
});

test('clock regression and invalid dates cannot produce negative durations or invalid ISO dates', () => {
  let current = 10000;
  const { activity, res } = fixture({ now: () => current });
  current = 9000;
  assert.equal(row(activity).durationMs, 0);
  res.end();
  assert.equal(row(activity).durationMs, 0);
  for (const value of [NaN, Infinity, 8640000000000001, 'secret-time']) {
    const result = fixture({ now: () => value });
    assert.equal(Number.isFinite(Date.parse(row(result.activity).startedAt)), true);
    result.res.end();
    assert.equal(Number.isFinite(row(result.activity).durationMs), true);
  }
});

test('provider SSE errors mark HTTP 200 as error without storing the event payload', () => {
  const { activity, res, handle } = fixture();
  handle.setStreaming(true);
  res.writeHead(200);
  writeAnthropicEvent(res, { type: 'error', error: { message: 'secret-provider-prompt' } });
  res.end();
  assert.equal(row(activity).status, 'error');
  assert.equal(row(activity).errorCategory, 'upstream_error');
  assert.equal(row(activity).httpStatus, 200);
  assert.equal(JSON.stringify(activity.list()).includes('secret'), false);
});

test('common provider errors preserve specific timeout categories for streaming and JSON replies', () => {
  for (const streaming of [false, true]) {
    const { activity, res, handle } = fixture();
    handle.setStreaming(streaming);
    if (streaming) res.writeHead(200);
    const error = new Error('secret-provider-details');
    error.httpStatus = 504;
    sendError(res, 'secret-provider-name', error, { error() {} });
    assert.equal(row(activity).status, 'error');
    assert.equal(row(activity).errorCategory, 'timeout');
    assert.equal(row(activity).httpStatus, streaming ? 200 : 504);
    assert.equal(JSON.stringify(activity.list()).includes('secret'), false);
  }
});

test('Claude handled upstream failures mark activity without storing error content', async () => {
  const req = request();
  req.headers = {};
  const res = new StreamResponse();
  const activity = createRequestActivity();
  activity.track(req, res, { providerId: 'claude2' });
  const claude = new ClaudeRequest(req, {
    config: {}, oauthManager: { accountId: 'synthetic-activity-test' }, fallbackToClaudeCode: false
  });
  claude.processRequestBody = () => ({});
  claude.makeRequest = async () => {
    const error = new Error('Synthetic upstream failure');
    error.code = 'ETIMEDOUT';
    throw error;
  };
  const oldError = Logger.error;
  Logger.error = () => {};
  try {
    const finished = new Promise(resolve => res.once('finish', resolve));
    await claude.handleResponse(res, { messages: [] });
    await finished;
  } finally {
    Logger.error = oldError;
  }
  assert.equal(row(activity).status, 'error');
  assert.equal(row(activity).errorCategory, 'timeout');
  assert.equal(row(activity).httpStatus, 504);
  assert.equal(JSON.stringify(activity.list()).includes('Synthetic'), false);
});

test('Claude raw SSE transport is not decoded or saved by activity tracking', async () => {
  const req = request();
  req.headers = {};
  const res = new StreamResponse();
  const activity = createRequestActivity();
  activity.track(req, res, { providerId: 'claude1', streaming: true });
  const claude = new ClaudeRequest(req, {
    config: {}, oauthManager: { accountId: 'synthetic-activity-test' }, fallbackToClaudeCode: false
  });
  claude.processRequestBody = () => ({});
  claude.makeRequest = async () => {
    const upstream = new PassThrough();
    upstream.statusCode = 200;
    upstream.headers = { 'content-type': 'text/event-stream' };
    upstream.end('event: error\ndata: {"error":{"message":"secret-raw-payload"}}\n\n');
    return upstream;
  };
  await claude.handleResponse(res, { stream: true, messages: [] });
  assert.equal(row(activity).status, 'success');
  assert.equal(row(activity).httpStatus, 200);
  assert.equal(JSON.stringify(activity.list()).includes('secret'), false);
});
