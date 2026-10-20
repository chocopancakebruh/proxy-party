const { markActivityFailure } = require('../RequestActivity');

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

function writeAnthropicEvent(res, event) {
  if (res.destroyed || res.writableEnded) return;
  if (event.type === 'error') markActivityFailure(res, 'upstream_error');
  if (res.writableLength > MAX_BUFFERED_BYTES) {
    throw new Error('Client is not consuming the response stream.');
  }
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function startAnthropicStream(res, messageId, model) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  writeAnthropicEvent(res, {
    type: 'message_start',
    message: {
      id: messageId, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });
  let currentType;
  let currentIndex = -1;
  let nextIndex = 0;
  let finished = false;
  const closeBlock = () => {
    if (currentIndex < 0) return;
    writeAnthropicEvent(res, { type: 'content_block_stop', index: currentIndex });
    currentType = undefined;
    currentIndex = -1;
  };
  const openBlock = type => {
    if (currentType === type) return;
    closeBlock();
    currentType = type;
    currentIndex = nextIndex++;
    writeAnthropicEvent(res, {
      type: 'content_block_start', index: currentIndex,
      content_block: type === 'thinking'
        ? { type: 'thinking', thinking: '', signature: '' }
        : { type: 'text', text: '' }
    });
  };
  const write = (type, text) => {
    if (!text || finished || res.destroyed || res.writableEnded) return;
    openBlock(type);
    writeAnthropicEvent(res, {
      type: 'content_block_delta', index: currentIndex,
      delta: type === 'thinking'
        ? { type: 'thinking_delta', thinking: text }
        : { type: 'text_delta', text }
    });
  };
  return {
    writeThinking: text => write('thinking', text),
    writeText: text => write('text', text),
    finish(stopReason = 'end_turn', usage = { output_tokens: 0 }) {
      if (finished || res.destroyed || res.writableEnded) return;
      finished = true;
      if (nextIndex === 0) openBlock('text');
      closeBlock();
      writeAnthropicEvent(res, {
        type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage
      });
      writeAnthropicEvent(res, { type: 'message_stop' });
      res.end();
    }
  };
}

module.exports = { startAnthropicStream, writeAnthropicEvent };
