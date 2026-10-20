const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const Logger = require('./Logger');
const OAuthManager = require('./OAuthManager');
const { loadConfig } = require('./Config');
const { markActivityFailure } = require('./RequestActivity');

const STRIP_TTL = true;
const TOKEN_REFRESH_METHOD = 'OAUTH'; // 'OAUTH' or 'CLAUDE_CODE_CLI'

class ClaudeRequest {
  static presetCache = new Map();
  static accountStates = new Map();

  static getAccountState(accountId) {
    if (!ClaudeRequest.accountStates.has(accountId)) {
      ClaudeRequest.accountStates.set(accountId, {
        refreshPromise: null
      });
    }
    return ClaudeRequest.accountStates.get(accountId);
  }

  static clearAccountCache(accountId = 'claude1') {
    const state = ClaudeRequest.accountStates.get(accountId);
    if (state && !state.refreshPromise) ClaudeRequest.accountStates.delete(accountId);
  }

  constructor(req = null, options = {}) {
    this.req = req;
    this.config = options.config ?? loadConfig();
    this.request = options.request || https.request;
    this.API_URL = 'https://api.anthropic.com/v1/messages';
    this.VERSION = '2023-06-01';
    this.BETA_HEADER = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,prompt-caching-2024-07-31';
    this.oauthManager = options.oauthManager || OAuthManager;
    this.accountId = options.accountId || this.oauthManager.accountId || 'claude1';
    const fallbackSetting = options.fallbackToClaudeCode ?? this.config.fallback_to_claude_code;
    this.fallbackToClaudeCode = fallbackSetting !== false && fallbackSetting !== 'false';
    this.authState = ClaudeRequest.getAccountState(this.accountId);
    const configuredTimeout = Number(this.config.claude_timeout_ms ?? 300000);
    this.timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(2147483647, configuredTimeout) : 300000;

    const apiKey = req?.headers?.['x-api-key'];
    if (typeof apiKey === 'string' && apiKey !== this.config.proxy_api_key && apiKey.includes('sk-ant')) {
      this.requestToken = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
    }

    this.refreshToken = TOKEN_REFRESH_METHOD === 'OAUTH' ? this.refreshTokenWithOauth : this.refreshTokenWithClaudeCodeCli;
  }

  stripTtlFromCacheControl(body) {
    if (!STRIP_TTL) return body;
    if (!body || typeof body !== 'object') return body;

    const processContentArray = (contentArray) => {
      if (!Array.isArray(contentArray)) return;

      contentArray.forEach(item => {
        if (item && typeof item === 'object' && item.cache_control) {
          if (item.cache_control.ttl) {
            delete item.cache_control.ttl;
            Logger.debug('Removed ttl from cache_control');
          }
        }
      });
    };

    if (Array.isArray(body.system)) {
      processContentArray(body.system);
    }

    if (Array.isArray(body.messages)) {
      body.messages.forEach(message => {
        if (message && Array.isArray(message.content)) {
          processContentArray(message.content);
        }
      });
    }

    return body;
  }

  filterSamplingParams(body) {
    if (this.config.filter_sampling_params !== true && this.config.filter_sampling_params !== 'true') return body;
    if (!body || typeof body !== 'object') return body;

    const hasTemperature = body.temperature !== undefined;
    const hasTopP = body.top_p !== undefined;

    // If both are present, we need to keep only one
    if (hasTemperature && hasTopP) {
      const tempIsDefault = body.temperature === 1.0;
      const topPIsDefault = body.top_p === 1.0;

      // If both are default, remove top_p (arbitrary choice)
      if (tempIsDefault && topPIsDefault) {
        delete body.top_p;
        Logger.debug('Removed top_p=1.0 from request (both at default, keeping temperature)');
      }
      // If only top_p is default, remove it
      else if (topPIsDefault) {
        delete body.top_p;
        Logger.debug(`Removed top_p=1.0 from request (keeping temperature=${body.temperature})`);
      }
      // If only temperature is default, remove it and keep top_p
      else if (tempIsDefault) {
        delete body.temperature;
        Logger.debug(`Removed temperature=1.0 from request (keeping top_p=${body.top_p})`);
      }
      // If both are non-default, prefer temperature over top_p
      else {
        const topPValue = body.top_p;
        delete body.top_p;
        Logger.debug(`Removed top_p=${topPValue} from request (preferring temperature=${body.temperature})`);
      }
    }
    // If only top_p is present and it's default, remove it
    else if (hasTopP && body.top_p === 1.0) {
      delete body.top_p;
      Logger.debug('Removed top_p=1.0 from request (default value, no temperature specified)');
    }
    // If only temperature is present and it's default, remove it
    else if (hasTemperature && body.temperature === 1.0) {
      delete body.temperature;
      Logger.debug('Removed temperature=1.0 from request (default value, no top_p specified)');
    }

    return body;
  }

  async getAuthToken(rejectedToken = null) {
    if (this.requestToken) return this.requestToken;
    return this.loadOrRefreshToken(rejectedToken);
  }

  async loadOrRefreshToken(rejectedToken = null) {
    try {
      // Try this route's isolated OAuth token store first.
      if (this.oauthManager.isAuthenticated()) {
        Logger.debug(`Using OAuth tokens for ${this.accountId}`);
        const token = await this.oauthManager.getValidAccessToken({
          rejectedToken: rejectedToken?.replace(/^Bearer /, '')
        });
        return `Bearer ${token}`;
      }

      // Only the primary route may fall back to Claude Code's own credentials.
      // The second subscription must never silently borrow the first account.
      if (this.fallbackToClaudeCode) {
        Logger.debug('Falling back to Claude Code credentials');
        return await this.loadFromClaudeCodeCredentials(rejectedToken);
      }

      throw new Error('No authentication tokens found. Please authenticate first.');
    } catch (error) {
      throw new Error(`Failed to get auth token: ${error.message}`);
    }
  }

  async loadFromClaudeCodeCredentials(rejectedToken = null) {
    try {
      const credentialsData = this.loadCredentialsFromFile();
      const credentials = JSON.parse(credentialsData);
      const oauth = credentials.claudeAiOauth;
      if (!oauth?.accessToken) throw new Error('Claude Code access token is missing');

      if (!Number.isFinite(oauth.expiresAt) || Date.now() >= (oauth.expiresAt - 60000) ||
          rejectedToken === `Bearer ${oauth.accessToken}`) {
        Logger.info('Claude Code token expired/expiring, refreshing...');
        return await this.refreshToken();
      }

      return `Bearer ${oauth.accessToken}`;
    } catch (error) {
      throw new Error(`Failed to load Claude Code credentials: ${error.message}`);
    }
  }

  loadCredentialsFromFile() {
    if (process.platform === 'win32') {
      // Try native Windows location first
      const nativePath = path.join(os.homedir(), '.claude', '.credentials.json');
      if (fs.existsSync(nativePath)) {
        return fs.readFileSync(nativePath, 'utf8');
      }
      // Fallback to WSL for users who still have the old setup
      return execSync('wsl cat ~/.claude/.credentials.json', { encoding: 'utf8', timeout: 10000 });
    } else {
      // macOS/Linux use the same path convention
      const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      return fs.readFileSync(credentialsPath, 'utf8');
    }
  }

  writeCredentialsToFile(credentialsJson) {
    if (process.platform === 'win32') {
      // Write to native Windows location if it exists, otherwise use WSL
      const nativePath = path.join(os.homedir(), '.claude', '.credentials.json');
      if (fs.existsSync(nativePath)) {
        fs.writeFileSync(nativePath, credentialsJson, 'utf8');
      } else {
        execSync(`wsl tee ~/.claude/.credentials.json`, { input: credentialsJson, encoding: 'utf8', timeout: 10000 });
      }
    } else {
      const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      fs.writeFileSync(credentialsPath, credentialsJson, 'utf8');
    }
  }


  async refreshTokenWithOauth() {
    // Race condition protection
    if (this.authState.refreshPromise) {
      return await this.authState.refreshPromise;
    }
    
    this.authState.refreshPromise = this._doRefresh();
    try {
      const result = await this.authState.refreshPromise;
      return result;
    } finally {
      this.authState.refreshPromise = null;
    }
  }

  async _doRefresh() {
    try {
      const credentialsData = this.loadCredentialsFromFile();
      const credentials = JSON.parse(credentialsData);
      const refreshToken = credentials.claudeAiOauth?.refreshToken;
      if (!refreshToken) throw new Error('Claude Code refresh token is missing');

      const refreshData = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
      };

      const response = await this.oauthManager._makeTokenRequest(JSON.stringify(refreshData));
      
      credentials.claudeAiOauth.accessToken = response.access_token;
      credentials.claudeAiOauth.refreshToken = response.refresh_token || refreshToken;
      credentials.claudeAiOauth.expiresAt = Date.now() + (response.expires_in * 1000);
      
      const credentialsJson = JSON.stringify(credentials);
      this.writeCredentialsToFile(credentialsJson);
      
      Logger.info('Token refreshed successfully');
      return `Bearer ${response.access_token}`;
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        const errorMsg = process.platform === 'win32' 
          ? 'Failed to load credentials: Claude credentials file not found in WSL. Check your default WSL distro with "wsl -l -v" and set the correct one with "wsl --set-default <distro-name>". As a backup, you can get the token from ~/.claude/.credentials.json and pass it as x-api-key (proxy password in SillyTavern)'
          : 'Claude credentials not found. Please ensure Claude Code is installed and you have logged in. As a backup, you can get the token from ~/.claude/.credentials.json and pass it as x-api-key (proxy password in SillyTavern)';
        Logger.error('ENOENT error during token refresh:', errorMsg);
        throw new Error(errorMsg);
      }
      if (error.message.includes('invalid_grant')) {
        throw new Error('Refresh token expired. Please log in again through Claude Code');
      }
      if (error.message.includes('timeout')) {
        throw new Error('Token refresh timeout. Please check your internet connection');
      }
      throw new Error(`Token refresh failed: ${error.message}`);
    }
  }

  getHeaders(token) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': token,
      'anthropic-version': this.VERSION,
      'User-Agent': 'claude-code-proxy/1.0.0'
    };

    const betaSet = new Set();
    if (this.BETA_HEADER) {
      this.BETA_HEADER.split(',').map(s => s.trim()).filter(Boolean).forEach(b => betaSet.add(b));
    }
    betaSet.add('prompt-caching-2024-07-31');

    const incomingBeta = this.req?.headers?.['anthropic-beta'];
    if (incomingBeta && typeof incomingBeta === 'string') {
      incomingBeta.split(',').map(s => s.trim()).filter(Boolean).forEach(b => betaSet.add(b));
    }

    if (betaSet.size > 0) {
      headers['anthropic-beta'] = Array.from(betaSet).join(',');
    }

    return headers;
  }

  processRequestBody(body, presetName = null) {
    if (!body) return body;
    body = JSON.parse(JSON.stringify(body));

    const systemPrompt = {
      type: 'text',
      text: 'You are Claude Code, Anthropic\'s official CLI for Claude.'
    };

    if (body.system) {
      if (Array.isArray(body.system)) {
        body.system.unshift(systemPrompt);
      } else {
        body.system = [systemPrompt, typeof body.system === 'string'
          ? { type: 'text', text: body.system } : body.system];
      }
    } else {
      body.system = [systemPrompt];
    }

    if (presetName) {
      this.applyPreset(body, presetName);
    }

    body = this.stripTtlFromCacheControl(body);
    body = this.filterSamplingParams(body);

    return body;
  }

  loadPreset(presetName) {
    if (ClaudeRequest.presetCache.has(presetName)) {
      return ClaudeRequest.presetCache.get(presetName);
    }

    try {
      const presetPath = path.join(__dirname, 'presets', `${presetName}.json`);
      const presetData = fs.readFileSync(presetPath, 'utf8');
      const preset = JSON.parse(presetData);
      ClaudeRequest.presetCache.set(presetName, preset);
      return preset;
    } catch (error) {
      Logger.info(`Failed to load preset ${presetName}: ${error.message}`);
      ClaudeRequest.presetCache.set(presetName, null);
      return null;
    }
  }

  applyPreset(body, presetName) {
    const preset = this.loadPreset(presetName);
    if (!preset) {
      Logger.warn(`Unknown preset: ${presetName}`);
      return;
    }

    if (preset.system) {
      const presetSystemPrompt = {
        type: 'text',
        text: preset.system
      };
      body.system.push(presetSystemPrompt);
    }

    // Use suffixEt only when thinking is enabled, otherwise use regular suffix
    const hasThinking = body.thinking && body.thinking.type === 'enabled';
    const suffix = hasThinking ? preset.suffixEt : preset.suffix;
    
    if (suffix && body.messages && body.messages.length > 0) {
      const lastUserIndex = body.messages.map(m => m.role).lastIndexOf('user');
      if (lastUserIndex !== -1) {
        const suffixMsg = {
          role: 'user',
          content: [{ type: 'text', text: suffix }]
        };
        body.messages.splice(lastUserIndex + 1, 0, suffixMsg);
      }
    }

    Logger.debug(`Applied preset: ${presetName}`);
  }

  waitForSignal(operation, signal) {
    if (signal.aborted) {
      Promise.resolve(operation).catch(() => {});
      return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(operation).then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }

  async makeRequest(body, presetName = null, options = {}) {
    const signal = options.signal || AbortSignal.timeout(this.timeoutMs);
    if (signal.aborted) throw signal.reason;
    const token = options.token || await this.waitForSignal(this.getAuthToken(), signal);
    if (signal.aborted) throw signal.reason;
    this.lastToken = token;
    const headers = this.getHeaders(token);
    const payload = options.payload ?? JSON.stringify(this.processRequestBody(body, presetName));
    headers['Content-Length'] = Buffer.byteLength(payload);
    Logger.debug('Outgoing headers to Claude:', { ...headers, Authorization: '[REDACTED]' });
    Logger.debug(`Final request to Claude (${Buffer.byteLength(payload)} bytes)`);

    const urlParts = new URL(this.API_URL);
    const requestOptions = {
      hostname: urlParts.hostname,
      port: urlParts.port || 443,
      path: urlParts.pathname,
      method: 'POST',
      headers
    };

    return new Promise((resolve, reject) => {
      let upstream;
      let request;
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        request?.destroy(signal.reason);
        upstream?.destroy(signal.reason);
        cleanup();
        reject(signal.reason);
      };
      try {
        request = this.request(requestOptions, response => {
          upstream = response;
          response.once('end', cleanup);
          response.once('close', cleanup);
          response.on('error', reject);
          if (signal.aborted) onAbort();
          else resolve(response);
        });
        request.on('error', error => {
          cleanup();
          reject(error);
        });
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        else request.end(payload);
      } catch (error) {
        cleanup();
        request?.destroy();
        reject(error);
      }
    });
  }

  async handleResponse(res, body, presetName = null) {
    const initialHeaders = res.getHeaders();
    const forwardedHeaders = new Set();
    const controller = new AbortController();
    const onDisconnect = () => {
      if (!res.writableFinished) controller.abort(new Error('Client disconnected'));
    };
    this.req?.once?.('aborted', onDisconnect);
    res.once('close', onDisconnect);
    const timeout = setTimeout(() => {
      const error = new Error('Claude request timed out');
      error.code = 'ETIMEDOUT';
      controller.abort(error);
    }, this.timeoutMs);
    let claudeResponse;
    try {
      if (this.req?.aborted || res.destroyed) return;
      const payload = JSON.stringify(this.processRequestBody(body, presetName));
      claudeResponse = await this.makeRequest(body, presetName, { payload, signal: controller.signal });
      if (claudeResponse.statusCode === 401 && !this.requestToken) {
        let refreshedToken;
        try {
          refreshedToken = await this.waitForSignal(this.getAuthToken(this.lastToken), controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          Logger.info('Token refresh failed, passing 401 to client');
        }
        if (refreshedToken) {
          claudeResponse.destroy();
          claudeResponse = await this.makeRequest(body, presetName, {
            payload, signal: controller.signal, token: refreshedToken
          });
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      res.statusCode = claudeResponse.statusCode;
      const hopByHop = new Set([
        'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
        'te', 'trailer', 'transfer-encoding', 'upgrade'
      ]);
      String(claudeResponse.headers.connection || '').split(',').forEach(header => {
        if (header.trim()) hopByHop.add(header.trim().toLowerCase());
      });
      for (const [header, value] of Object.entries(claudeResponse.headers)) {
        if (!hopByHop.has(header.toLowerCase()) && value !== undefined) {
          res.setHeader(header, value);
          forwardedHeaders.add(header.toLowerCase());
        }
      }
      await this.streamResponse(res, claudeResponse);
    } catch (error) {
      claudeResponse?.destroy();
      if (res.destroyed || res.writableEnded) return;
      markActivityFailure(res, error.code === 'ETIMEDOUT' ? 'timeout' : 'upstream_error');
      Logger.error('Claude request error:', error.message);
      if (res.headersSent) {
        res.destroy();
      } else {
        for (const header of forwardedHeaders) {
          if (Object.hasOwn(initialHeaders, header)) res.setHeader(header, initialHeaders[header]);
          else res.removeHeader(header);
        }
        res.writeHead(error.code === 'ETIMEDOUT' ? 504 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.code === 'ETIMEDOUT' ? 'Claude request timed out' : 'Claude upstream request failed' }));
      }
    } finally {
      clearTimeout(timeout);
      this.req?.off?.('aborted', onDisconnect);
      res.off('close', onDisconnect);
    }
  }

  streamResponse(res, claudeResponse) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        claudeResponse.off('error', onError);
        claudeResponse.off('aborted', onAborted);
        claudeResponse.off('close', onUpstreamClose);
        res.off('error', onError);
        res.off('close', onClientClose);
        res.off('finish', onFinish);
      };
      const onError = error => {
        cleanup();
        claudeResponse.unpipe(res);
        claudeResponse.destroy();
        reject(error);
      };
      const onAborted = () => onError(new Error('Claude response was interrupted'));
      const onUpstreamClose = () => {
        if (!claudeResponse.readableEnded) onAborted();
      };
      const onClientClose = () => {
        if (!res.writableFinished) onError(new Error('Client disconnected'));
      };
      const onFinish = () => {
        cleanup();
        resolve();
      };
      claudeResponse.once('error', onError);
      claudeResponse.once('aborted', onAborted);
      claudeResponse.once('close', onUpstreamClose);
      res.once('error', onError);
      res.once('close', onClientClose);
      res.once('finish', onFinish);
      claudeResponse.pipe(res);
    });
  }

  async refreshTokenWithClaudeCodeCli() {
    throw new Error('CLI token refresh not implemented');
  }
}

module.exports = ClaudeRequest;
