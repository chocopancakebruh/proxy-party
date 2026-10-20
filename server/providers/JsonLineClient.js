class JsonLineClient {
  constructor(child, {
    name, protocol = 'codex', onNotification = () => {}, onFatal = () => {},
    maxLineLength = 16 * 1024 * 1024, maxOutputLength = 128 * 1024 * 1024
  }) {
    this.child = child;
    this.name = name;
    this.protocol = protocol;
    this.onNotification = onNotification;
    this.onFatal = onFatal;
    this.maxLineLength = maxLineLength;
    this.maxOutputLength = maxOutputLength;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.outputLength = 0;
    this.closed = false;
    this.failure = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.handleStdout(chunk));
    child.stdout.on('end', () => {
      if (this.buffer.trim()) this.handleLine(this.buffer);
      this.buffer = '';
    });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on('error', error => this.fatal(error));
    }
    child.on('error', error => this.fatal(error));
    child.on('close', (code, signal) => {
      this.fatal(new Error(`${name} exited before completing (code=${code}, signal=${signal || 'none'})`));
    });
  }

  request(method, params) {
    if (this.closed) return Promise.reject(this.failure || new Error(`${this.name} connection closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params });
  }

  write(message) {
    if (this.closed) return;
    try {
      const envelope = this.protocol === 'acp' ? { jsonrpc: '2.0', ...message } : message;
      this.child.stdin.write(`${JSON.stringify(envelope)}\n`, error => {
        if (error) this.fatal(error);
      });
    } catch (error) {
      this.fatal(error);
    }
  }

  handleStdout(chunk) {
    if (this.closed) return;
    this.outputLength += chunk.length;
    if (this.outputLength > this.maxOutputLength) {
      this.fatal(new Error(`${this.name} output exceeded the proxy limit`));
      return;
    }
    this.buffer += chunk;
    let newline;
    while (!this.closed && (newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
    }
    if (!this.closed && this.buffer.length > this.maxLineLength) {
      this.fatal(new Error(`${this.name} JSON event is too large`));
    }
  }

  handleLine(line) {
    if (this.closed || !line.trim()) return;
    try {
      if (line.length > this.maxLineLength) throw new Error(`${this.name} JSON event is too large`);
      const message = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Error(`${this.name} sent an invalid protocol envelope`);
      }
      this.handleMessage(message);
    } catch (error) {
      this.fatal(error instanceof SyntaxError
        ? new Error(`${this.name} sent invalid JSON`) : error);
    }
  }

  handleMessage(message) {
    const hasId = Object.hasOwn(message, 'id');
    if (hasId && (typeof message.id !== 'string' && !Number.isSafeInteger(message.id))) {
      throw new Error(`${this.name} sent an invalid request ID`);
    }
    if (hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || `${this.name} request failed`);
        error.code = message.error.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== 'string') throw new Error(`${this.name} sent an invalid method`);
    const params = message.params ?? {};
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error(`${this.name} sent invalid notification parameters`);
    }
    if (hasId) {
      if (this.protocol === 'acp' && message.method === 'session/request_permission') {
        const options = Array.isArray(params.options) ? params.options : [];
        const rejection = options.find(option => option?.kind === 'reject_once');
        this.write({ id: message.id, result: { outcome: rejection
          ? { outcome: 'selected', optionId: rejection.optionId } : { outcome: 'cancelled' } } });
      } else if (this.protocol === 'codex' && [
        'item/commandExecution/requestApproval', 'item/fileChange/requestApproval'
      ].includes(message.method)) {
        this.write({ id: message.id, result: { decision: 'decline' } });
      } else if (this.protocol === 'codex' && [
        'item/tool/requestUserInput', 'tool/requestUserInput'
      ].includes(message.method)) {
        this.write({ id: message.id, result: { answers: {} } });
      } else {
        this.write({ id: message.id, error: { code: -32601, message: 'Unsupported client method' } });
      }
      return;
    }
    this.onNotification(message.method, params);
  }

  fatal(error) {
    if (this.closed) return;
    this.failure = error;
    this.close(error);
    this.onFatal(error);
  }

  close(error = new Error(`${this.name} connection closed`)) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.buffer = '';
  }
}

module.exports = { JsonLineClient };
