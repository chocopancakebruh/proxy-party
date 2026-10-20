const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { attachTrayControl, startTrayServer, traySettings } = require('./tray-server');

test('tray settings expose only validated local addresses, not config credentials', () => {
  const config = { port: '42069', host: '0.0.0.0', proxy_api_key: 'private-test-key', custom: 'private-content' };
  assert.deepEqual(traySettings(config), {
    host: '0.0.0.0', port: 42069,
    dashboardUrl: 'http://127.0.0.1:42069/dashboard/', healthUrl: 'http://127.0.0.1:42069/health'
  });
  assert.match(traySettings({ host: '::1' }).dashboardUrl, /^http:\/\/\[::1\]:42069/);
  assert.match(traySettings({ host: 'localhost' }).healthUrl, /^http:\/\/localhost:42069/);
  assert.throws(() => traySettings({ port: 65536 }), /port/);
  assert.doesNotMatch(JSON.stringify(traySettings(config)), /private/);
});

test('tray launch preserves config, suppresses browser launch, and passes instance identity', () => {
  const input = new PassThrough();
  const runtime = new EventEmitter();
  const server = new EventEmitter();
  const config = { host: '127.0.0.1', port: 42069, auto_open_browser: true };
  let options;
  const started = startTrayServer({ config, input, runtime, instanceId: '0123456789abcdef', startServer(value) { options = value; return server; } });
  assert.equal(started, server);
  assert.equal(options.config.auto_open_browser, false);
  assert.equal(config.auto_open_browser, true);
  assert.equal(options.instanceId, '0123456789abcdef');
  server.emit('close');
  assert.equal(runtime.listenerCount('SIGTERM'), 0);
  input.destroy();
});

test('tray stdin shutdown closes server once and removes its signal handlers', async () => {
  const server = http.createServer((req, res) => res.end('synthetic'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const input = new PassThrough();
  const runtime = new EventEmitter();
  attachTrayControl(server, { input, runtime, graceMs: 20 });
  input.write('not-a-command\n');
  assert.equal(server.listening, true);
  const closed = once(server, 'close');
  input.write('shutdown\nshutdown\n');
  await closed;
  assert.equal(server.listening, false);
  assert.equal(runtime.listenerCount('SIGINT'), 0);
  assert.equal(runtime.listenerCount('SIGTERM'), 0);
  input.destroy();
});

test('tray disappearance shuts down only the server attached to its input', async () => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const input = new PassThrough();
  const runtime = new EventEmitter();
  attachTrayControl(server, { input, runtime, graceMs: 20 });
  const closed = once(server, 'close');
  input.end();
  await closed;
  assert.equal(server.listening, false);
  assert.equal(input.listenerCount('error'), 0);
});

test('tray shutdown eventually disconnects stalled requests so provider cleanup can run', async () => {
  let response;
  const accepted = new Promise(resolve => {
    response = resolve;
  });
  const server = http.createServer((req, res) => { res.writeHead(200); res.write('synthetic'); response(res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const input = new PassThrough();
  const runtime = new EventEmitter();
  const control = attachTrayControl(server, { input, runtime, graceMs: 20 });
  const request = http.get(`http://127.0.0.1:${server.address().port}/`, reply => { reply.on('error', () => {}); reply.resume(); });
  request.on('error', () => {});
  const ongoing = await accepted;
  const disconnected = once(ongoing, 'close');
  const closed = once(server, 'close');
  control.stop();
  await disconnected;
  await closed;
  assert.equal(ongoing.destroyed, true);
  input.destroy();
});
