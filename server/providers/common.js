const { startAnthropicStream, writeAnthropicEvent } = require('./AnthropicStream');
const { stopProcess } = require('./process');
const { markActivityFailure } = require('../RequestActivity');

function invalidRequest(message) {
  const error = new Error(message);
  error.httpStatus = 400;
  return error;
}

function extractTextContent(content, field, allowThinking = false) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw invalidRequest(`${field} must be text or an array of text blocks.`);
  return content.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    if (allowThinking && ['thinking', 'redacted_thinking'].includes(block?.type)) return '';
    throw invalidRequest(`CLI chat routes accept text only; unsupported content in ${field}.`);
  }).filter(Boolean).join('\n');
}

function validateConversation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !Array.isArray(body.messages) || !body.messages.length) {
    throw invalidRequest('A nonempty messages array is required.');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw invalidRequest('stream must be a boolean.');
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length)) {
    throw invalidRequest('CLI chat routes do not accept tool declarations.');
  }
  if (body.tool_choice && body.tool_choice.type !== 'none') {
    throw invalidRequest('CLI chat routes do not support tool_choice.');
  }
  return {
    system: body.system == null ? '' : extractTextContent(body.system, 'system'),
    messages: body.messages.map((message, index) => {
      if (!message || !['user', 'assistant'].includes(message.role)) {
        throw invalidRequest(`Invalid role in messages[${index}]; use user or assistant.`);
      }
      return {
        role: message.role,
        content: extractTextContent(message.content, `messages[${index}].content`, message.role === 'assistant')
      };
    })
  };
}

function parseConfiguredArgs(value, fallback) {
  if (Array.isArray(value)) return value.map(String);
  const input = (value || fallback).trim();
  const parts = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return parts.map(part => /^(["']).*\1$/.test(part) ? part.slice(1, -1) : part);
}

function timeoutMilliseconds(value) {
  const timeout = Number(value || 300000);
  return Number.isFinite(timeout) ? Math.min(2147483647, Math.max(1000, Math.floor(timeout))) : 300000;
}

function sendError(res, provider, error, Logger) {
  if (res.destroyed || res.writableEnded) return;
  const status = error.httpStatus || 502;
  const category = status === 401 || status === 403 ? 'authentication'
    : status === 408 || status === 504 ? 'timeout'
      : status >= 400 && status < 500 ? 'invalid_request' : 'upstream_error';
  markActivityFailure(res, category);
  const event = { type: 'error', error: {
    type: status === 400 ? 'invalid_request_error' : 'api_error', message: error.message
  } };
  Logger.error(`${provider} request error:`, error.message);
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(event));
  } else {
    try { writeAnthropicEvent(res, event); } catch {}
    res.end();
  }
}

function createLifecycle({ req, res, body, provider, model, messageId, timeoutMs, dependencies }) {
  let child;
  let client;
  let cancel = () => {};
  let stopping;
  let failure;
  let clientGone = false;
  let stream;
  let text = '';
  let thinking = '';
  let stderr = '';
  let completionResult;
  let resolveCompletion;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  const finish = result => {
    if (completionResult !== undefined) return;
    completionResult = result;
    resolveCompletion(result);
  };
  const stop = error => {
    if (error) {
      failure ||= error;
      finish({ error });
    }
    if (!stopping && child) {
      try { cancel(); } catch {}
      client?.close(failure);
      stopping = stopProcess(child, {
        spawn: dependencies.spawn, platform: dependencies.process.platform, env: dependencies.process.env
      });
    }
    return stopping;
  };
  const disconnect = () => {
    if (res.writableEnded) return;
    clientGone = true;
    stop(new Error(`${provider} client disconnected`));
  };
  req.once('aborted', disconnect);
  res.once('close', disconnect);
  const timeout = setTimeout(() => {
    const error = new Error(`${provider} request timed out after ${timeoutMs}ms`);
    error.httpStatus = 504;
    stop(error);
  }, timeoutMs);
  timeout.unref?.();
  const check = () => {
    if (failure) throw failure;
    if (req.aborted || res.destroyed || clientGone) throw new Error(`${provider} client disconnected`);
  };
  const append = (type, value) => {
    if (value == null || value === '') return;
    if (typeof value !== 'string') throw new Error(`${provider} sent invalid ${type}`);
    if (text.length + thinking.length + value.length > 64 * 1024 * 1024) {
      throw new Error(`${provider} response exceeded the proxy output limit`);
    }
    if (type === 'text') { text += value; stream?.writeText(value); }
    else { thinking += value; stream?.writeThinking(value); }
  };
  return {
    completion, finish, stop, check,
    get clientGone() { return clientGone || req.aborted || res.destroyed; },
    get failure() { return failure; },
    get stderr() { return stderr; },
    setChild(value) {
      child = value;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    },
    setClient(value, onCancel) { client = value; cancel = onCancel; },
    setModel(value) {
      if (stream || typeof value !== 'string' || !value.trim()) throw new Error(`${provider} returned an invalid model`);
      model = value;
    },
    startStream() { if (body.stream === true) stream = startAnthropicStream(res, messageId, model); },
    writeText: value => append('text', value),
    writeThinking: value => append('thinking', value),
    respond(stopReason = 'end_turn', usage = { input_tokens: 0, output_tokens: 0 }) {
      check();
      clearTimeout(timeout);
      if (stream) stream.finish(stopReason, usage);
      else {
        const content = [
          ...(thinking ? [{ type: 'thinking', thinking, signature: '' }] : []),
          { type: 'text', text }
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: messageId, type: 'message', role: 'assistant', model, content,
          stop_reason: stopReason, stop_sequence: null, usage
        }));
      }
    },
    async cleanup() {
      clearTimeout(timeout);
      req.off('aborted', disconnect);
      res.off('close', disconnect);
      await stop();
    }
  };
}

module.exports = {
  validateConversation, parseConfiguredArgs, timeoutMilliseconds, sendError, createLifecycle
};
