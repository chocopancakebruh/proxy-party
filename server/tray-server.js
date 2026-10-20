const readline = require('node:readline');
const { startServer } = require('./server');
const { loadConfig, positiveInteger } = require('./Config');

function traySettings(config) {
  const port = positiveInteger(config.port, 42069);
  if (port > 65535) throw new Error('Invalid proxy port');
  const host = config.host || '127.0.0.1';
  const localHost = ['::1', '[::1]', '::'].includes(host) ? '[::1]' : host === 'localhost' ? 'localhost' : '127.0.0.1';
  const base = `http://${localHost}:${port}`;
  return { host, port, dashboardUrl: `${base}/dashboard/`, healthUrl: `${base}/health` };
}

function attachTrayControl(server, options = {}) {
  const input = options.input || process.stdin;
  const runtime = options.runtime || process;
  const commands = readline.createInterface({ input, terminal: false });
  let stopping = false;
  let shutdownTimer;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    commands.close();
    input.pause();
    input.unref?.();
    server.close();
    server.closeIdleConnections?.();
    shutdownTimer = setTimeout(() => server.closeAllConnections(), options.graceMs ?? 2000);
    shutdownTimer.unref();
  };
  commands.on('line', command => { if (command === 'shutdown') stop(); });
  input.once('end', stop);
  input.once('error', stop);
  runtime.once('SIGINT', stop);
  runtime.once('SIGTERM', stop);
  const cleanup = () => {
    clearTimeout(shutdownTimer);
    commands.close();
    input.pause();
    input.unref?.();
    input.off('end', stop);
    input.off('error', stop);
    runtime.off('SIGINT', stop);
    runtime.off('SIGTERM', stop);
  };
  server.once('close', cleanup);
  server.once('error', cleanup);
  return { stop };
}

function startTrayServer(options = {}) {
  const config = options.config || loadConfig();
  traySettings(config);
  const server = (options.startServer || startServer)({
    ...options, config: { ...config, auto_open_browser: false },
    instanceId: options.instanceId || process.env.CLAUDE_PROXY_TRAY_ID
  });
  attachTrayControl(server, options);
  server.once('error', () => { process.exitCode = 1; });
  return server;
}

if (require.main === module) {
  try {
    if (process.argv[2] === '--settings') process.stdout.write(JSON.stringify(traySettings(loadConfig())));
    else startTrayServer();
  } catch {
    process.stderr.write('The proxy could not start. Check the installation and configuration.\n');
    process.exitCode = 1;
  }
}

module.exports = { attachTrayControl, startTrayServer, traySettings };
