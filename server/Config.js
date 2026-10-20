const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG = Object.freeze({
  port: '42069',
  host: '127.0.0.1',
  log_level: 'INFO',
  max_body_bytes: '16777216',
  body_timeout_ms: '30000',
  claude_timeout_ms: '300000',
  oauth_timeout_ms: '30000'
});

function parseConfig(contents) {
  const config = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) throw new Error(`Invalid configuration entry: ${trimmed.split('=')[0]}`);
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/\s+#.*$/, '').trim();
    config[key] = value;
  }
  return config;
}

function loadConfig(filename = path.join(__dirname, 'config.txt'), env = process.env) {
  const config = { ...DEFAULT_CONFIG, ...parseConfig(fs.readFileSync(filename, 'utf8')) };
  config.host = env.CLAUDE_PROXY_HOST || config.host || '127.0.0.1';
  config.proxy_api_key = env.CLAUDE_PROXY_KEY || config.proxy_api_key || '';
  return config;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function isLoopback(host) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
}

function timeoutMilliseconds(value, fallback) {
  return Math.min(2147483647, positiveInteger(value, fallback));
}

module.exports = { DEFAULT_CONFIG, parseConfig, loadConfig, positiveInteger, timeoutMilliseconds, isLoopback };
