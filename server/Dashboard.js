const fs = require('node:fs');
const path = require('node:path');
const { isLoopback } = require('./Config');
const { parseBody, requestError } = require('./HttpRequest');
const { providerDefinition, connectionPath } = require('./ConnectionRegistry');

const ASSETS = Object.freeze({
  '/dashboard/': ['index.html', 'text/html; charset=utf-8'],
  '/dashboard/connection-test.js': ['connection-test.js', 'application/javascript; charset=utf-8'],
  '/dashboard/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/dashboard/style.css': ['style.css', 'text/css; charset=utf-8']
});

function requireLocalRequest(req) {
  const address = req.socket?.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
    throw requestError('The dashboard is only available on this computer', 403);
  }
  let host;
  try { host = new URL(`http://${req.headers.host}`).hostname; } catch {}
  if (!isLoopback(host)) throw requestError('Open the dashboard using a localhost address', 403);
}

function requireSameOrigin(req) {
  const expectedOrigin = `${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  if (req.headers.origin && req.headers.origin !== expectedOrigin) {
    throw requestError('Account controls require the same origin', 403);
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    throw requestError('Account controls require the same origin', 403);
  }
}

function createDashboard({ config, authenticate, sendJson, startLogin, logout, refresh, getAuthGeneration, activity, mimoModels, kimiModels, accountModels,
  registry, getAccount, profiles, removeConnection }) {
  const assets = new Map();
  const modelPickers = { mimo: mimoModels, kimi: kimiModels };
  function description(connection, baseUrl) {
    const { handler, ...definition } = providerDefinition(connection.provider);
    return { ...definition, id: connection.id, provider: connection.provider, label: connection.label,
      legacy: connection.legacy, canRemove: true, proxyUrl: `${baseUrl}${connectionPath(connection)}`,
      detail: !definition.independentAccounts ? 'Uses the system Antigravity sign-in · one connection'
        : connection.legacy && definition.kind === 'cli' ? 'Uses your existing local CLI account' : 'An independent account for this connection' };
  }

  return async function handleDashboard(req, res, pathname) {
    if (!['/', '/dashboard'].includes(pathname) && !pathname.startsWith('/dashboard/')) return false;
    requireLocalRequest(req);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (['/', '/dashboard'].includes(pathname) && req.method === 'GET') {
      res.writeHead(302, { Location: '/dashboard/' });
      res.end();
      return true;
    }
    if (Object.hasOwn(ASSETS, pathname) && req.method === 'GET') {
      const [filename, contentType] = ASSETS[pathname];
      if (!assets.has(filename)) assets.set(filename, fs.readFileSync(path.join(__dirname, 'dashboard', filename)));
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(assets.get(filename));
      return true;
    }
    if (!pathname.startsWith('/dashboard/api/')) throw requestError('Not found', 404);
    requireSameOrigin(req);
    if (req.headers['x-dashboard-request'] !== '1') throw requestError('Use the dashboard to manage accounts', 403);
    authenticate(req, config.proxy_api_key);
    if (pathname === '/dashboard/api/connections') {
      if (req.method !== 'POST') throw requestError('Method not allowed', 405);
      const body = await parseBody(req, { ...config, max_body_bytes: 2048 });
      const connection = registry.add(body.provider, body.label);
      const baseUrl = `${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}`;
      sendJson(res, 201, { connection: description(connection, baseUrl), message: `${connection.label} added. Use Sign in to connect this account.` });
      return true;
    }
    if (pathname === '/dashboard/api/activity' && req.method === 'GET') {
      sendJson(res, 200, { ...activity.list(), activeRequests: activity.activeCount() });
      return true;
    }
    if (pathname === '/dashboard/api/activity/clear') {
      if (req.method !== 'POST') throw requestError('Method not allowed', 405);
      activity.clear();
      sendJson(res, 200, { message: 'Activity cleared. Running requests are not stopped.' });
      return true;
    }
    if (pathname === '/dashboard/api/status' && req.method === 'GET') {
      const baseUrl = `${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}`;
      const force = new URL(req.url, baseUrl).searchParams.get('verify') === '1';
      const providers = await Promise.all(registry.list().map(async connection => {
        const account = getAccount(connection);
        const status = account ? { ...account.manager.getStatus(), authGeneration: getAuthGeneration(account), loginRunning: false }
          : (await profiles.auth(connection).getStatuses({ force, providerId: connection.provider })).find(item => item.id === connection.provider);
        const picker = modelPickers[connection.provider];
        const modelSelection = accountModels?.supports(connection.provider) ? accountModels.selection(connection)
          : picker?.getSelection(connection.legacy ? config : profiles.get(connection).config);
        return { ...status, ...description(connection, baseUrl), ...(modelSelection ? { modelSelection } : {}) };
      }));
      sendJson(res, 200, { providers: providers.filter(provider => registry.get(provider.id)), catalog: registry.catalog(), server: { baseUrl } });
      return true;
    }
    const actionRoute = pathname.match(/^\/dashboard\/api\/providers\/([a-z0-9-]+)\/(login|reset|logout|refresh|remove|model|catalog)$/);
    if (!actionRoute) throw requestError('Not found', 404);
    if (req.method !== 'POST') throw requestError('Method not allowed', 405);
    const [, providerId, action] = actionRoute;
    const connection = registry.get(providerId);
    if (!connection) throw requestError('Unknown connection', 404);
    if (action === 'remove') {
      removeConnection(providerId);
      sendJson(res, 200, { message: 'Connection removed. Its URL is disabled. Saved credentials are retained; running requests can finish.' });
      return true;
    }
    if (action === 'catalog') {
      if (!accountModels?.supports(connection.provider)) throw requestError('This CLI does not expose a model catalog here.');
      sendJson(res, 200, { modelSelection: await accountModels.refresh(connection) });
      return true;
    }
    if (action === 'model' && accountModels?.supports(connection.provider)) {
      const body = await parseBody(req, { ...config, max_body_bytes: 1024 });
      if (!registry.get(providerId)) throw requestError('Connection removed', 404);
      sendJson(res, 200, { modelSelection: accountModels.save(connection, body), message: 'Settings saved for new requests.' });
      return true;
    }
    if (action === 'model') {
      const picker = modelPickers[connection.provider];
      if (!picker) throw requestError('Model selection is unavailable for this provider');
      const body = await parseBody(req, { ...config, max_body_bytes: 1024 });
      let selection;
      if (connection.legacy) selection = picker.select(body.model);
      else {
        picker.validate(body.model);
        registry.setModel(providerId, body.model);
        const settings = profiles.get(connection).config;
        settings[`${connection.provider}_model`] = body.model;
        selection = picker.getSelection(settings);
      }
      sendJson(res, 200, { modelSelection: selection, message: `${picker.label} model saved. New requests use this model; no restart needed.` });
      return true;
    }
    const account = getAccount(connection);
    if (!account) {
      if (action !== 'login') throw requestError('Manage this provider with its own CLI', 400);
      profiles.prepare(connection);
      sendJson(res, 200, await profiles.auth(connection).login(connection.provider));
      return true;
    }
    if (action === 'logout' || action === 'reset') logout(account);
    if (action === 'login' || action === 'reset') {
      sendJson(res, 200, { ...startLogin(account), callbackPath: `${account.authBase}/callback`, message: 'Complete sign-in in the authorization window, then paste the code here.' });
    } else if (action === 'refresh') {
      await refresh(account);
      sendJson(res, 200, { message: `${account.label} credentials refreshed. No restart needed.` });
    } else {
      sendJson(res, 200, { message: `${account.label} signed out. Other accounts are unchanged.` });
    }
    return true;
  };
}

module.exports = { createDashboard, requireSameOrigin };
