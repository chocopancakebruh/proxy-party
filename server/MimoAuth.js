const filesystem = require('node:fs');
const https = require('node:https');
const { createHash } = require('node:crypto');

const MAX_BYTES = 256 * 1024;

function credentialPath({ environment, home, path }) {
  const override = environment('MIMOCODE_HOME');
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('Invalid MiMo home');
    return path.join(override, 'data', 'auth.json');
  }
  const xdg = environment('XDG_DATA_HOME');
  const data = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share');
  return path.join(data, 'mimocode', 'auth.json');
}

function verificationUrl(base = 'https://api.xiaomimimo.com/v1') {
  const url = new URL(base);
  // Never forward a saved key to a custom host, redirect, or non-TLS endpoint.
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.xiaomimimo.com') ||
      url.port || url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) {
    throw new Error('Unsupported MiMo endpoint');
  }
  url.pathname = '/v1/models';
  return url.href;
}

function createMimoAuth({ fs = filesystem, environment, home, path, request = https.request, now = Date.now,
  timeoutMs = 5000, cacheMs = 15000 }) {
  let cached;
  let closed = false;
  const controllers = new Set();
  const unknown = message => ({ state: 'unknown', message });

  function readCredential() {
    let data;
    const supplied = environment('MIMOCODE_AUTH_CONTENT');
    if (supplied) {
      try { data = JSON.parse(supplied); } catch { /* The CLI also falls back to its file for invalid JSON. */ }
    }
    if (data === undefined) {
      let filename;
      try { filename = credentialPath({ environment, home, path }); }
      catch { return { status: unknown('MiMo home configuration is invalid. Use an absolute MIMOCODE_HOME path.') }; }
      try {
        if (fs.statSync(filename).size > MAX_BYTES) throw new Error('Too large');
        const content = fs.readFileSync(filename, 'utf8');
        if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Too large');
        data = JSON.parse(content);
      } catch (error) {
        return { status: error.code === 'ENOENT'
          ? { state: 'missing', message: 'No Xiaomi MiMo sign-in is saved. Run mimo auth login or use Sign in.' }
          : unknown('MiMo credentials could not be read. Check the CLI sign-in and file permissions.') };
      }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { status: unknown('MiMo credential data is invalid. Check the CLI sign-in.') };
    }
    const credential = data.xiaomi;
    if (!credential) return { status: { state: 'missing', message: 'No Xiaomi MiMo sign-in is saved. Run mimo auth login or use Sign in.' } };
    if (credential.type !== 'api' || typeof credential.key !== 'string' || !credential.key.trim() || /[\r\n]/.test(credential.key)) {
      return { status: unknown('The saved MiMo credential cannot be verified. Sign in using the Xiaomi MiMo provider.') };
    }
    let url;
    try { url = verificationUrl(credential.metadata?.base_url); }
    catch { return { status: unknown('MiMo uses a custom or unsupported endpoint; automatic sign-in verification is unavailable.') }; }
    const key = credential.key;
    return { key, url, fingerprint: createHash('sha256').update(JSON.stringify([key, url])).digest('hex') };
  }

  function verify({ key, url }) {
    return new Promise(resolve => {
      let req;
      let response;
      let settled = false;
      const finish = status => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controllers.delete(cancel);
        resolve(status);
      };
      const stop = message => {
        finish(unknown(message));
        response?.destroy();
        req?.destroy();
      };
      const cancel = () => stop('MiMo verification stopped because the proxy is shutting down.');
      controllers.add(cancel);
      const timer = setTimeout(() => stop('MiMo sign-in could not be verified: the check timed out. Try Refresh status.'), timeoutMs);
      try {
        req = request(url, { method: 'GET', headers: { Accept: 'application/json', 'api-key': key } }, res => {
          response = res;
          if (settled) { res.destroy(); return; }
          if (res.statusCode !== 200) {
            finish(res.statusCode === 401
              ? { state: 'missing', message: 'MiMo rejected the saved credential. Sign in again with the Xiaomi MiMo provider.' }
              : unknown('MiMo sign-in could not be verified right now. Try Refresh status; your saved credentials were kept.'));
            res.destroy();
            return;
          }
          let size = 0;
          const chunks = [];
          res.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BYTES) { stop('MiMo returned an unexpected verification response. Try Refresh status.'); return; }
            chunks.push(Buffer.from(chunk));
          });
          res.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!Array.isArray(data?.data) || data.error) throw new Error('Invalid models response');
              finish({ state: 'authenticated', message: 'MiMo verified your saved sign-in. Account and model access remain subject to your plan.' });
            } catch { finish(unknown('MiMo returned an unexpected verification response. Try Refresh status.')); }
          });
          res.on('error', () => stop('MiMo sign-in could not be verified: the connection was interrupted. Try Refresh status.'));
          res.on('aborted', () => stop('MiMo sign-in could not be verified: the connection was interrupted. Try Refresh status.'));
        });
        req.on('error', () => stop('MiMo sign-in could not be verified: the service could not be reached. Try Refresh status.'));
        req.end();
      } catch { stop('MiMo sign-in could not be verified: the service could not be reached. Try Refresh status.'); }
    });
  }

  async function getStatus({ force = false } = {}) {
    if (closed) return unknown('MiMo verification is unavailable while the proxy is shutting down.');
    const credential = readCredential();
    if (credential.status) { cached = undefined; return credential.status; }
    if (!cached || cached.fingerprint !== credential.fingerprint || (!cached.pending && (force || now() >= cached.expiresAt))) {
      const entry = { fingerprint: credential.fingerprint, pending: true };
      entry.promise = verify(credential).then(status => {
        entry.pending = false;
        entry.expiresAt = now() + cacheMs;
        return status;
      });
      cached = entry;
    }
    const status = await cached.promise;
    const current = readCredential();
    if (current.status) return current.status;
    if (current.fingerprint !== credential.fingerprint) {
      return unknown('MiMo sign-in changed during verification. Refresh status to check the new sign-in.');
    }
    return { ...status };
  }

  return { getStatus, close() { closed = true; cached = undefined; for (const cancel of controllers) cancel(); } };
}

module.exports = { createMimoAuth, credentialPath, verificationUrl };
