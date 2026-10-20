const { positiveInteger, timeoutMilliseconds } = require('./Config');

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseBody(req, config = {}) {
  const limit = positiveInteger(config.max_body_bytes, 16 * 1024 * 1024);
  const timeoutMs = timeoutMilliseconds(config.body_timeout_ms, 30000);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let finished = false;
    const cleanup = () => {
      clearTimeout(timeout);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = error => {
      if (finished) return;
      finished = true;
      cleanup();
      req.resume?.();
      reject(error);
    };
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) {
        fail(requestError(`Request body exceeds ${limit} bytes`, 413));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        const body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error('Request body must be a JSON object');
        }
        resolve(body);
      } catch (error) {
        reject(requestError(error instanceof SyntaxError ? 'Request body is not valid JSON' : error.message));
      }
    };
    const onError = error => fail(error);
    const onAborted = () => fail(requestError('Client disconnected', 499));
    const timeout = setTimeout(() => fail(requestError('Request body timed out', 408)), timeoutMs);
    timeout.unref?.();
    const declaredSize = Number(req.headers?.['content-length']);
    if (Number.isFinite(declaredSize) && declaredSize > limit) {
      fail(requestError(`Request body exceeds ${limit} bytes`, 413));
      return;
    }
    if (req.aborted || req.destroyed) {
      onAborted();
      return;
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function validateMessageBody(body) {
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw requestError('messages must be a nonempty array');
  }
  for (const message of body.messages) {
    if (!message || !['user', 'assistant'].includes(message.role)) {
      throw requestError('Each message must have a user or assistant role');
    }
    if (typeof message.content !== 'string' && !Array.isArray(message.content)) {
      throw requestError('Message content must be a string or an array of content blocks');
    }
  }
  if (body.system !== undefined && typeof body.system !== 'string' && !Array.isArray(body.system)) {
    throw requestError('system must be a string or an array of content blocks');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw requestError('stream must be a boolean');
  }
}

module.exports = { parseBody, requestError, validateMessageBody };
