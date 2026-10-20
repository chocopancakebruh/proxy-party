const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const Logger = require('./Logger');

const OAUTH_CONFIG = {
  client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorize_url: 'https://claude.ai/oauth/authorize',
  token_url: 'https://console.anthropic.com/v1/oauth/token',
  redirect_uri: 'https://console.anthropic.com/oauth/code/callback', // Anthropic's callback page (shows code to user)
  scope: 'org:create_api_key user:profile user:inference'
};

function hasTokenString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function tokenExpiration(value) {
  if (!Number.isFinite(value)) return null;
  const expiration = new Date(value);
  return Number.isFinite(expiration.getTime()) ? expiration : null;
}

class OAuthManager {
  constructor(options = {}) {
    const homeDir = options.homeDir || process.env.HOME || process.env.USERPROFILE;
    this.accountId = options.accountId || 'claude1';
    this.label = options.label || 'Claude 1';
    this.tokenPath = options.tokenPath || path.join(
      homeDir,
      '.claude-code-proxy',
      options.tokenFilename || 'tokens.json'
    );
    this.cachedToken = null;
    this.refreshPromise = null;
    this.request = options.request || https.request;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs : 15000;
    this.generation = 0;
  }

  get signedOutPath() {
    return `${this.tokenPath}.signed-out`;
  }

  /**
   * Generate PKCE code verifier, challenge, and state for OAuth flow
   * @returns {{code_verifier: string, code_challenge: string, state: string}}
   */
  generatePKCE() {
    // Generate random code verifier (43-128 chars)
    const code_verifier = crypto.randomBytes(32).toString('base64url');

    // Generate code challenge using S256 method
    const code_challenge = crypto
      .createHash('sha256')
      .update(code_verifier)
      .digest('base64url');

    // Generate random state for CSRF protection (32 bytes to match OpenCode)
    const state = crypto.randomBytes(32).toString('base64url');

    return { code_verifier, code_challenge, state };
  }

  /**
   * Build authorization URL for user to visit
   * @param {{code_challenge: string, state: string}} pkce
   * @returns {string} Authorization URL
   */
  buildAuthorizationURL(pkce) {
    const params = new URLSearchParams({
      code: 'true', // Required: tells Anthropic to display the authorization code
      client_id: OAUTH_CONFIG.client_id,
      response_type: 'code',
      redirect_uri: OAUTH_CONFIG.redirect_uri,
      scope: OAUTH_CONFIG.scope,
      code_challenge: pkce.code_challenge,
      code_challenge_method: 'S256',
      state: pkce.state
    });

    return `${OAUTH_CONFIG.authorize_url}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access and refresh tokens
   * @param {string} code - Authorization code from callback
   * @param {string} code_verifier - PKCE code verifier
   * @param {string} state - State parameter from callback
   * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>}
   */
  async exchangeCodeForTokens(code, code_verifier, state) {
    const payload = JSON.stringify({
      grant_type: 'authorization_code',
      code: code,
      state: state,
      client_id: OAUTH_CONFIG.client_id,
      code_verifier: code_verifier,
      redirect_uri: OAUTH_CONFIG.redirect_uri
    });

    try {
      const response = await this._makeTokenRequest(payload);
      Logger.info('Successfully exchanged authorization code for tokens');
      return response;
    } catch (error) {
      Logger.error('Failed to exchange code for tokens', error);
      throw error;
    }
  }

  /**
   * Refresh the access token using the refresh token
   * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>}
   */
  async refreshAccessToken() {
    // Prevent race conditions with concurrent refresh attempts
    if (this.refreshPromise) {
      Logger.debug('Token refresh already in progress, waiting...');
      return this.refreshPromise;
    }

    const generation = this.generation;
    const refreshPromise = Promise.resolve().then(async () => {
      const tokens = this.loadTokens();
      if (!tokens || !hasTokenString(tokens.refresh_token)) {
        throw new Error('No refresh token available');
      }
      if (this.generation !== generation) {
        throw new Error('Authentication changed while refreshing. Please retry the request.');
      }

      const payload = JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: OAUTH_CONFIG.client_id
      });

      const response = await this._makeTokenRequest(payload);
      const currentTokens = this.loadTokens();
      if (this.generation !== generation ||
          currentTokens?.refresh_token !== tokens.refresh_token ||
          currentTokens?.access_token !== tokens.access_token) {
        throw new Error('Authentication changed while refreshing. Please retry the request.');
      }
      Logger.info('Successfully refreshed access token');

      const newTokens = {
        access_token: response.access_token,
        refresh_token: response.refresh_token || tokens.refresh_token,
        expires_at: Date.now() + (response.expires_in * 1000)
      };
      this.saveTokens(newTokens);

      return response;
    });
    this.refreshPromise = refreshPromise;
    try {
      return await refreshPromise;
    } finally {
      if (this.refreshPromise === refreshPromise) this.refreshPromise = null;
    }
  }

  /**
   * Make an HTTPS request to the token endpoint
   * @param {string} payload - JSON payload to send
   * @returns {Promise<Object>} Token response
   * @private
   */
  _makeTokenRequest(payload) {
    return new Promise((resolve, reject) => {
      const url = new URL(OAUTH_CONFIG.token_url);

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      let response;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        const error = new Error('OAuth request timeout');
        error.code = 'ETIMEDOUT';
        finish(error);
        response?.destroy();
        req.destroy();
      }, this.timeoutMs);
      let req;
      try {
        req = this.request(options, (res) => {
          response = res;
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
            if (data.length > 1024 * 1024) {
              finish(new Error('OAuth response exceeded the size limit'));
              res.destroy();
              req.destroy();
            }
          });
          res.on('error', finish);
          res.on('aborted', () => finish(new Error('OAuth response was interrupted')));
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const result = JSON.parse(data);
                if (!hasTokenString(result.access_token) ||
                    !Number.isFinite(result.expires_in) || result.expires_in <= 0 ||
                    !tokenExpiration(Date.now() + result.expires_in * 1000)) {
                  throw new Error('Missing access token or token expiration');
                }
                finish(null, result);
              } catch (_) {
                finish(new Error('Invalid token response: missing or malformed authentication data'));
              }
            } else {
              let errorCode = '';
              try {
                const parsed = JSON.parse(data);
                const candidate = typeof parsed.error === 'string' ? parsed.error : parsed.error?.type;
                if (/^[a-z_]{1,64}$/.test(candidate)) errorCode = ` (${candidate})`;
              } catch (_) {}
              finish(new Error(`Token request failed with status ${res.statusCode}${errorCode}`));
            }
          });
        });
        req.on('error', finish);
        req.end(payload);
      } catch (error) {
        finish(error);
        req?.destroy();
      }
    });
  }

  /**
   * Load tokens from local file
   * @returns {Object|null} Tokens object or null if not found
   */
  loadTokens() {
    if (!this.allowsClaudeCodeFallback()) return null;
    const stored = this._readTokenFile();
    if (stored.state === 'unknown') Logger.error('Saved authentication could not be read. Reset it and sign in again.');
    return stored.tokens;
  }

  _readTokenFile() {
    try {
      const tokens = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
      if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
        return { state: 'unknown', tokens: null };
      }
      return { state: 'present', tokens };
    } catch (error) {
      return { state: error.code === 'ENOENT' ? 'missing' : 'unknown', tokens: null };
    }
  }

  _signOutState() {
    try {
      fs.statSync(this.signedOutPath);
      return 'present';
    } catch (error) {
      return error.code === 'ENOENT' ? 'missing' : 'unknown';
    }
  }

  allowsClaudeCodeFallback() {
    return this._signOutState() === 'missing';
  }

  getStatus() {
    const status = {
      state: 'unknown',
      message: 'Saved authentication could not be read. Reset it and sign in again.',
      expiresAt: null,
      canLogin: true,
      canReset: true,
      canRefresh: false
    };
    const signedOut = this._signOutState();
    if (signedOut === 'unknown') return status;
    const stored = this._readTokenFile();
    if (signedOut === 'present') {
      return {
        ...status, state: 'missing', message: 'Signed out in this proxy. Sign in to reconnect.',
        canReset: stored.state !== 'missing'
      };
    }
    if (stored.state === 'missing') {
      return { ...status, state: 'missing', message: 'No saved proxy sign-in. Sign in to connect this account.', canReset: false };
    }
    if (stored.state === 'unknown') return status;
    const tokens = stored.tokens;
    const expiration = tokenExpiration(tokens.expires_at);
    status.canRefresh = hasTokenString(tokens.refresh_token);
    status.expiresAt = expiration?.toISOString() || null;
    if (!hasTokenString(tokens.access_token) || !status.canRefresh || !expiration) {
      status.message = 'Saved authentication is incomplete or has an invalid expiration. Refresh it or sign in again.';
      return status;
    }
    if (expiration.getTime() <= Date.now()) {
      return { ...status, state: 'expired', message: 'The saved access token has expired. Refresh it or sign in again.' };
    }
    return {
      ...status, state: 'authenticated',
      message: 'Saved authentication is locally valid and unexpired; the account has not been verified online.'
    };
  }

  /**
   * Save tokens to local file
   * @param {{access_token: string, refresh_token: string, expires_at: number}} tokens
   */
  saveTokens(tokens) {
    if (!tokens || !hasTokenString(tokens.access_token) || !hasTokenString(tokens.refresh_token) ||
        !tokenExpiration(tokens.expires_at)) {
      throw new Error('Cannot save incomplete or malformed authentication tokens.');
    }
    const temporaryPath = `${this.tokenPath}.${crypto.randomUUID()}.tmp`;
    try {
      // Ensure directory exists
      const dir = path.dirname(this.tokenPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      fs.writeFileSync(temporaryPath, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, this.tokenPath);
      this.cachedToken = tokens.access_token;
      this.generation += 1;
      try { fs.unlinkSync(this.signedOutPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      Logger.info('Tokens saved successfully');
    } catch (error) {
      Logger.error('Failed to save tokens to file', error);
      throw error;
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }

  /**
   * Get a valid access token, refreshing if necessary
   * @returns {Promise<string>} Valid access token
   */
  async getValidAccessToken(options = {}) {
    const tokens = this.loadTokens();
    if (!tokens || !hasTokenString(tokens.access_token)) {
      throw new Error('No authentication tokens found. Please authenticate first.');
    }

    // Check if token is expired or expiring soon (1 minute buffer)
    if (!tokenExpiration(tokens.expires_at) || tokens.expires_at <= Date.now() + 60000 ||
        options.rejectedToken === tokens.access_token) {
      Logger.info('Access token expired or expiring soon, refreshing...');
      await this.refreshAccessToken();
      const newTokens = this.loadTokens();
      if (!newTokens?.access_token) {
        throw new Error('Authentication changed while refreshing. Please authenticate again.');
      }
      this.cachedToken = newTokens.access_token;
      return this.cachedToken;
    }

    this.cachedToken = tokens.access_token;
    return tokens.access_token;
  }

  /**
   * Check if user is authenticated (has valid tokens)
   * @returns {boolean} True if authenticated
   */
  isAuthenticated() {
    const tokens = this.loadTokens();
    return !!(tokens && hasTokenString(tokens.access_token) && hasTokenString(tokens.refresh_token));
  }

  /**
   * Get token expiration time
   * @returns {Date|null} Expiration date or null if not authenticated
   */
  getTokenExpiration() {
    const tokens = this.loadTokens();
    return tokenExpiration(tokens?.expires_at);
  }

  /**
   * Delete stored tokens (logout)
   */
  logout() {
    this.cachedToken = null;
    this.generation += 1;
    try {
      fs.mkdirSync(path.dirname(this.signedOutPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.signedOutPath, 'Signed out in this proxy.\n', { encoding: 'utf8', mode: 0o600 });
      if (fs.existsSync(this.tokenPath)) {
        fs.unlinkSync(this.tokenPath);
        Logger.info('Tokens deleted successfully');
      }
    } catch (error) {
      Logger.error('Failed to delete tokens', error);
      throw error;
    }
  }

}

// Preserve the original singleton export while allowing the server to create
// additional, fully isolated Claude subscription stores.
const defaultOAuthManager = new OAuthManager();
module.exports = defaultOAuthManager;
module.exports.OAuthManager = OAuthManager;
