const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { TextDecoder } = require('util');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_THINKING_BYTES = 256 * 1024;
const TOOL_FIELDS = ['tools', 'tool', 'tool_calls', 'toolCalls', 'tool_call', 'toolCall', 'function_call', 'functionCall'];

function hasTools(row) {
  return TOOL_FIELDS.some(key => {
    const value = row[key];
    return value != null && value !== false && value !== '' &&
      (!Array.isArray(value) || value.length > 0);
  });
}

function fieldWasTruncated(row, field) {
  const fields = row.truncated_fields;
  return Array.isArray(fields) ? fields.includes(field) :
    typeof fields === 'string' ? fields.split(/[,\s]+/).includes(field) : Boolean(fields && fields[field]);
}

async function readBoundedLog(filename) {
  const file = await fs.open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_LOG_BYTES) return null;
    // The extra byte also detects growth beyond the limit after stat().
    const buffer = Buffer.alloc(MAX_LOG_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_LOG_BYTES) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    await file.close();
  }
}

function extractThinking(log, expectedText) {
  const steps = new Map();
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    if (hasTools(row)) return { thinking: '' };
    if (row.type !== 'PLANNER_RESPONSE') continue;
    if (!Number.isSafeInteger(row.step_index) || row.step_index < 0) return null;
    // Records can be rewritten as a step progresses; only its latest state counts.
    steps.set(row.step_index, row);
  }

  const ordered = [...steps.values()].sort((a, b) => a.step_index - b.step_index);
  if (!ordered.length || ordered.some(row => row.status !== 'DONE' || row.source !== 'MODEL')) return null;
  if (ordered.some(row => (row.content != null && typeof row.content !== 'string') ||
    (row.thinking != null && typeof row.thinking !== 'string'))) return null;
  // The caller creates a unique one-shot CLI conversation for this response.
  // Its completed log may explicitly truncate long answer text, preventing an
  // exact comparison; untruncated responses must still match stdout exactly.
  const contentWasTruncated = ordered.some(row => fieldWasTruncated(row, 'content'));
  if (!contentWasTruncated && ordered.map(row => row.content || '').join('') !== expectedText) return null;

  let thinking = ordered.map(row => row.thinking || '').filter(Boolean).join('\n\n');
  if (thinking && ordered.some(row => fieldWasTruncated(row, 'thinking'))) {
    thinking += '\n\n[Antigravity truncated the saved reasoning.]';
  }
  return { thinking: Buffer.byteLength(thinking, 'utf8') <= MAX_THINKING_BYTES ? thinking : '' };
}

/** Recover only this completed CLI response's reasoning; never expose transcript text. */
async function readArgonThinking(conversationId, expectedText, options = {}) {
  if (typeof conversationId !== 'string' || conversationId.length !== 36 || !UUID.test(conversationId) ||
    typeof expectedText !== 'string' || !expectedText || Buffer.byteLength(expectedText, 'utf8') > MAX_LOG_BYTES) return '';

  try {
    const brainDir = options.brainDir || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
    const filename = path.join(brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
    const retries = Number.isInteger(options.retries) ? Math.max(0, Math.min(options.retries, 4)) : 4;
    const retryDelayMs = Number.isFinite(options.retryDelayMs) ? Math.max(0, Math.min(options.retryDelayMs, 100)) : 100;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const log = await readBoundedLog(filename);
        if (log === null) return '';
        const result = extractThinking(log, expectedText);
        if (result) return result.thinking;
      } catch {
        // Missing files and partial JSONL writes are normal while the CLI flushes.
      }
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  } catch {
    // Failure to recover optional reasoning must not fail an otherwise good reply.
  }
  return '';
}

module.exports = { readArgonThinking };
