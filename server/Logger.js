class Logger {
  static init(config) {
    this.config = config;
  }

  static getLogLevel() {
    const levels = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };
    return levels[this.config?.log_level] ?? 2;
  }

  static redact(value, seen = new WeakSet()) {
    if (typeof value === 'string') {
      return value
        .replace(/("(?:authorization|proxy-authorization|x-api-key|x-proxy-key|proxy_api_key|access_token|refresh_token)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]');
    }
    if (value instanceof Error) return this.redact(value.stack || value.message);
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      if (Array.isArray(value)) return value.map(item => this.redact(item, seen));
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key, /^(authorization|proxy-authorization|x-api-key|x-proxy-key|proxy_api_key|access_token|refresh_token)$/i.test(key)
          ? '[REDACTED]' : this.redact(item, seen)
      ]));
    }
    return value;
  }

  static debug(...args) {
    if (this.getLogLevel() >= 3) {
      console.log('DEBUG:', ...args.map(value => this.redact(value)));
    }
  }

  static trace(...args) {
    if (this.getLogLevel() >= 4) {
      console.log('TRACE:', ...args.map(value => this.redact(value)));
    }
  }

  static info(...args) {
    if (this.getLogLevel() >= 2) console.log('INFO:', ...args.map(value => this.redact(value)));
  }

  static warn(...args) {
    if (this.getLogLevel() >= 1) console.warn('WARN:', ...args.map(value => this.redact(value)));
  }

  static error(...args) {
    console.error('ERROR:', ...args.map(value => this.redact(value)));
  }

}

module.exports = Logger;
