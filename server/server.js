const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { spawn } = require('node:child_process');
const ClaudeRequest = require('./ClaudeRequest');
const OAuthManager = require('./OAuthManager');
const Logger = require('./Logger');
const { DEFAULT_CONFIG, loadConfig, positiveInteger, timeoutMilliseconds, isLoopback } = require('./Config');
const { parseBody, requestError, validateMessageBody } = require('./HttpRequest');
const { loginPage, resultPage } = require('./AuthPages');
const { createDashboard, requireSameOrigin } = require('./Dashboard');
const { createRequestActivity, markActivityFailure } = require('./RequestActivity');
const { createMimoModels } = require('./MimoModels');
const path = require('node:path');
const { createConnectionRegistry, providerDefinition } = require('./ConnectionRegistry');
const { createConnectionProfiles } = require('./ConnectionProfiles');

const KIMI_ROUTE_MODELS = Object.freeze({
  '/v1/kimi/messages': 'kimi-code/k3-256k',
  '/v1/kimi-256k/messages': 'kimi-code/k3-256k',
  '/v1/kimi-1m/messages': 'kimi-code/k3'
});
const PKCE_EXPIRY_MS = 10 * 60 * 1000;

function matchesSecret(candidate, expected) {
  if (typeof candidate !== 'string') return false;
  const actualBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function authenticate(req, secret) {
  if (!secret) return;
  const authorization = req.headers.authorization;
  const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice(7) : undefined;
  if (![req.headers['x-proxy-key'], bearer, req.headers['x-api-key']].some(value => matchesSecret(value, secret))) {
    throw requestError('A valid proxy API key is required', 401);
  }
  if (matchesSecret(req.headers['x-api-key'], secret)) delete req.headers['x-api-key'];
}

function applyCors(req, res, config) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowedOrigins = String(config.allowed_origins || '').split(',').map(value => value.trim()).filter(Boolean);
  let allowed = allowedOrigins.includes(origin);
  try {
    const parsed = new URL(origin);
    allowed ||= ['http:', 'https:'].includes(parsed.protocol) && isLoopback(parsed.hostname) && parsed.origin === origin;
  } catch {}
  if (!allowed) throw requestError('Origin is not allowed', 403);
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Api-Key, X-Proxy-Key, Anthropic-Version, Anthropic-Beta');
}

function validateRequestSource(req, pathname, config) {
  if (req.headers.host && isLoopback(config.host || '127.0.0.1')) {
    let hostname;
    try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch {}
    if (!isLoopback(hostname)) throw requestError('Host is not allowed', 403);
  }
  if (req.headers['sec-fetch-site'] === 'cross-site' && !req.headers.origin &&
      !/^\/auth(?:\/[a-z0-9-]+)?\/callback$/.test(pathname)) {
    throw requestError('Cross-site request is not allowed', 403);
  }
}

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function sendError(res, error) {
  if (res.destroyed || res.writableEnded || error.statusCode === 499) return;
  const status = error.statusCode || error.httpStatus || 500;
  const payload = { type: 'error', error: {
    type: status === 401 ? 'authentication_error' : status < 500 ? 'invalid_request_error' : 'api_error',
    message: error.message || 'Request failed'
  } };
  if (res.headersSent) {
    if (String(res.getHeader?.('content-type') || '').includes('text/event-stream')) {
      res.end(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    } else {
      res.end();
    }
    return;
  }
  if ([408, 413].includes(status)) res.setHeader('Connection', 'close');
  sendJson(res, status, payload);
}

function createApp(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options.config };
  const registry = options.registry || createConnectionRegistry({ config, filename: options.connectionsFile, profilesDir: options.profilesDir });
  const accounts = options.accounts || {};
  const Request = options.ClaudeRequest || ClaudeRequest;
  const logger = options.logger || Logger;
  const now = options.now || Date.now;
  const activity = options.activity || createRequestActivity({ now });
  const pkceStates = new Map();
  const accountGenerations = new Map();
  const profiles = createConnectionProfiles({ registry, config, logger, cliAuth: options.cliAuth,
    providers: options.providers, cliAuthFactory: options.cliAuthFactory, providerFactory: options.providerFactory });
  function getAccount(connection) {
    if (connection.provider !== 'claude') return null;
    return accounts[connection.id] ||= {
      id: connection.id, label: connection.label,
      authBase: connection.id === 'claude1' ? '/auth' : `/auth/${connection.id}`,
      manager: new OAuthManager.OAuthManager({
        accountId: connection.id, label: connection.label,
        ...(connection.legacy ? { tokenFilename: connection.id === 'claude1' ? 'tokens.json' : 'tokens-claude2.json' }
          : { tokenPath: path.join(registry.profileDir(connection.id), 'oauth', 'tokens.json') }),
        timeoutMs: timeoutMilliseconds(config.oauth_timeout_ms, 30000)
      })
    };
  }

  const cleanupStates = () => {
    for (const [state, data] of pkceStates) {
      if (now() - data.created_at >= PKCE_EXPIRY_MS) pkceStates.delete(state);
    }
  };

  const startLogin = account => {
    cleanupStates();
    if (pkceStates.size >= 1000) throw requestError('Too many pending login attempts', 429);
    const pkce = account.manager.generatePKCE();
    pkceStates.set(pkce.state, { accountId: account.id, code_verifier: pkce.code_verifier, created_at: now() });
    return { url: account.manager.buildAuthorizationURL(pkce), state: pkce.state, account: account.id, authGeneration: accountGenerations.get(account.id) || 0 };
  };

  const logout = account => {
    accountGenerations.set(account.id, (accountGenerations.get(account.id) || 0) + 1);
    for (const [state, data] of pkceStates) if (data.accountId === account.id) pkceStates.delete(state);
    Request.clearAccountCache?.(account.id);
    account.manager.logout();
  };

  const dashboard = createDashboard({
    accounts, config, authenticate, sendJson, startLogin, logout, activity, registry, getAccount, profiles,
    removeConnection(id) {
      if (!registry.get(id)) throw requestError('Unknown connection', 404);
      registry.remove(id);
      accountGenerations.set(id, (accountGenerations.get(id) || 0) + 1);
      for (const [state, data] of pkceStates) if (data.accountId === id) pkceStates.delete(state);
      if (accounts[id]?.manager) accounts[id].manager.generation += 1;
      Request.clearAccountCache?.(id);
      profiles.closeConnection(id);
      delete accounts[id];
    },
    mimoModels: createMimoModels({ config, configFile: options.configFile }),
    getAuthGeneration: account => accountGenerations.get(account.id) || 0,
    async refresh(account) {
      await account.manager.refreshAccessToken();
      Request.clearAccountCache?.(account.id);
    }
  });

  async function handleAuth(req, res, route, parsedUrl) {
    const connection = registry.get(route[1] || 'claude1');
    if (!connection || connection.provider !== 'claude') throw requestError('Unknown Claude account', 404);
    const account = getAccount(connection);
    const action = route[2];
    const manager = account.manager;
    if (action === 'login' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(loginPage(account, Boolean(config.proxy_api_key)));
      return;
    }
    if (action !== 'callback') {
      authenticate(req, config.proxy_api_key);
      requireSameOrigin(req);
    }
    res.setHeader('Cache-Control', 'no-store');
    if (action === 'get-url' && req.method === 'GET') {
      sendJson(res, 200, startLogin(account));
      return;
    }
    if (action === 'callback' && ['GET', 'POST'].includes(req.method)) {
      cleanupStates();
      const input = req.method === 'POST' ? await parseBody(req, config) : Object.fromEntries(parsedUrl.searchParams);
      let { code, state } = input;
      if (input.manual_code !== undefined) {
        if (typeof input.manual_code !== 'string') throw requestError('Invalid authorization code');
        const separator = input.manual_code.lastIndexOf('#');
        if (separator <= 0 || separator === input.manual_code.length - 1) throw requestError('Expected code#state');
        code = input.manual_code.slice(0, separator);
        state = input.manual_code.slice(separator + 1);
      }
      if (typeof code !== 'string' || !code || typeof state !== 'string' || !state) throw requestError('Missing authorization code or state');
      const pkceData = pkceStates.get(state);
      if (!pkceData || now() - pkceData.created_at >= PKCE_EXPIRY_MS) {
        pkceStates.delete(state);
        throw requestError('Invalid or expired state parameter. Start login again.');
      }
      if (pkceData.accountId !== account.id) throw requestError('This authorization code belongs to the other Claude account');
      pkceStates.delete(state);
      const generation = accountGenerations.get(account.id) || 0;
      const tokens = await manager.exchangeCodeForTokens(code, pkceData.code_verifier, state);
      if ((accountGenerations.get(account.id) || 0) !== generation) throw requestError('Authentication changed during login. Start login again.', 409);
      const lifetime = Number(tokens.expires_in);
      if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(lifetime) || lifetime <= 0) throw requestError('OAuth provider returned invalid tokens', 502);
      manager.saveTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: now() + lifetime * 1000 });
      accountGenerations.set(account.id, generation + 1);
      Request.clearAccountCache?.(account.id);
      const message = `${account.label} authenticated. You can close this page and use the proxy.`;
      if (req.method === 'POST') sendJson(res, 200, { success: true, account: account.id, message });
      else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(resultPage('Authentication successful', message));
      }
      return;
    }
    if (action === 'status' && req.method === 'GET') {
      const expiration = manager.getTokenExpiration();
      sendJson(res, 200, { account: account.id, label: account.label, authenticated: manager.isAuthenticated(), expires_at: expiration ? expiration.toISOString() : null });
      return;
    }
    if (action === 'logout' && ['GET', 'POST'].includes(req.method)) {
      logout(account);
      sendJson(res, 200, { success: true, account: account.id, message: `${account.label} logged out successfully` });
      return;
    }
    throw requestError('Method not allowed', 405);
  }

  const handleRequest = async function handleRequest(req, res) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const pathname = parsedUrl.pathname;
      logger.info(`${req.method} ${pathname}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      validateRequestSource(req, pathname, config);
      if (pathname.startsWith('/dashboard/api/')) requireSameOrigin(req);
      applyCors(req, res, config);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (await dashboard(req, res, pathname)) return;
      if (pathname === '/health' && req.method === 'GET') {
        sendJson(res, 200, {
          status: 'ok', server: 'claude-code-proxy', timestamp: now(),
          dashboard: true, activity: true, activeRequests: activity.activeCount(),
          instanceId: /^[a-f0-9-]{16,64}$/i.test(options.instanceId || '') ? options.instanceId : null
        });
        return;
      }
      const authRoute = pathname.match(/^\/auth(?:\/([a-z0-9-]+))?\/(login|get-url|callback|status|logout)$/);
      if (authRoute) {
        await handleAuth(req, res, authRoute, parsedUrl);
        return;
      }
      authenticate(req, config.proxy_api_key);
      const presetMatch = pathname.match(/^\/v1\/(\w+)\/messages$/);
      const connectionMatch = pathname.match(/^\/v1\/connections\/([a-z0-9-]+)(?:\/(kimi-256k|kimi-1m))?\/messages$/);
      const kimiModel = KIMI_ROUTE_MODELS[pathname];
      if (req.method !== 'POST' || !(pathname === '/v1/messages' || presetMatch || kimiModel || connectionMatch)) throw requestError('Not found', 404);
      const legacyId = kimiModel ? 'kimi' : presetMatch && (providerDefinition(presetMatch[1])?.kind === 'cli' || presetMatch[1] === 'claude2') ? presetMatch[1] : 'claude1';
      const connection = registry.get(connectionMatch ? connectionMatch[1] : legacyId);
      if (!connection || (connectionMatch?.[2] && connection.provider !== 'kimi')) throw requestError('Unknown connection', 404);
      const requestActivity = activity.track(req, res, { providerId: connection.id });
      const body = await parseBody(req, config);
      validateMessageBody(body);
      requestActivity.setStreaming(body.stream === true);
      const providerMethod = providerDefinition(connection.provider).handler;
      if (providerMethod) {
        const model = kimiModel || (connectionMatch?.[2] === 'kimi-1m' ? 'kimi-code/k3' : connection.provider === 'kimi' ? 'kimi-code/k3-256k' : undefined);
        await profiles.handlers(connection)[providerMethod](req, res, body, model);
        return;
      }
      const account = getAccount(connection);
      const preset = account.id === 'claude1' ? presetMatch?.[1] || null : null;
      await new Request(req, {
        config,
        oauthManager: account.manager,
        accountId: account.id,
        fallbackToClaudeCode: account.id === 'claude1' && config.fallback_to_claude_code !== false && config.fallback_to_claude_code !== 'false' && account.manager.allowsClaudeCodeFallback?.() !== false
      }).handleResponse(res, body, preset);
    } catch (error) {
      const status = error.statusCode || error.httpStatus || 500;
      markActivityFailure(res, status === 499 ? 'cancelled' : [408, 504].includes(status) || error.code === 'ETIMEDOUT' ? 'timeout'
        : [401, 403].includes(status) ? 'authentication' : status < 500 ? 'invalid_request' : 'upstream_error');
      logger.error('Request failed:', error.message);
      sendError(res, error);
    }
  };
  handleRequest.close = () => profiles.close();
  return handleRequest;
}

function createServer(options = {}) {
  const app = createApp(options);
  const server = http.createServer(app);
  server.once('close', () => app.close());
  server.headersTimeout = timeoutMilliseconds(options.config?.headers_timeout_ms, 30000);
  server.requestTimeout = timeoutMilliseconds(options.config?.body_timeout_ms, 30000);
  return server;
}

function openBrowser(address) {
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', address] : [address];
  const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
  child.on('error', error => Logger.debug('Could not open browser:', error.message));
  child.unref();
}

function startServer(options = {}) {
  const config = options.config ? { ...DEFAULT_CONFIG, ...options.config } : loadConfig(options.configFile);
  const host = config.host || '127.0.0.1';
  if (!isLoopback(host) && !config.proxy_api_key) throw new Error('Set CLAUDE_PROXY_KEY or proxy_api_key before binding outside localhost');
  const port = positiveInteger(config.port, 42069);
  if (port > 65535) throw new Error('port must be between 1 and 65535');
  const logger = options.logger || Logger;
  logger.init?.(config);
  const registry = options.registry || createConnectionRegistry({ config,
    filename: options.connectionsFile || path.join(__dirname, 'data', 'connections.json'), profilesDir: options.profilesDir });
  const server = createServer({ ...options, config, registry, logger });
  server.listen(port, host, () => {
    logger.info(`claude-code-proxy listening on ${host}:${port}`);
    const localHost = ['::1', '[::1]', '::'].includes(host) ? '[::1]' : host === 'localhost' ? 'localhost' : '127.0.0.1';
    const dashboardUrl = `http://${localHost}:${port}/dashboard/`;
    logger.info(`Account dashboard: ${dashboardUrl}`);
    logger.info(`${registry.list().length} saved connections`);
    if (config.auto_open_browser !== 'false' && config.auto_open_browser !== false) (options.openBrowser || openBrowser)(dashboardUrl);
  });
  server.on('error', error => logger.error('Server error:', error.message));
  return server;
}

if (require.main === module) {
  try {
    const server = startServer();
    const shutdown = () => {
      server.close();
      server.closeAllConnections();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    Logger.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createApp, createServer, startServer, ClaudeRequest };
