'use strict';

// Test the same Messages route a client uses. A non-streaming request lets the
// dashboard distinguish a complete assistant reply from an HTTP 200 alone.
async function probeConnection({ proxyUrl, origin, proxyKey, claudeModel, signal, fetchImpl = fetch }) {
  const endpoint = new URL(proxyUrl);
  if (endpoint.origin !== origin || !/^\/v1(?:\/[a-z0-9/-]+)?$/.test(endpoint.pathname) ||
      endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error('Invalid connection URL.');
  endpoint.pathname += '/messages';
  const headers = { 'Content-Type': 'application/json' };
  if (proxyKey) headers['X-Proxy-Key'] = proxyKey;
  const response = await fetchImpl(endpoint, {
    method: 'POST', headers, signal, redirect: 'error', credentials: 'same-origin', mode: 'same-origin',
    body: JSON.stringify({ ...(claudeModel ? { model: claudeModel } : {}), stream: false, max_tokens: claudeModel === 'claude-fable-5-2' ? 1024 : 128,
      ...(claudeModel === 'claude-fable-5-2' ? { output_config: { effort: 'low' } } : {}),
      messages: [{ role: 'user', content: 'Reply with exactly OK.' }] })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) {
    const detail = data?.error?.message || data?.message || (typeof data?.error === 'string' && data.error);
    throw new Error('HTTP ' + response.status + (detail ? ' · ' + String(detail).split(/[\r\n]/)[0].slice(0, 240) : ' · Request failed.'));
  }
  if (data?.type !== 'message' || data.role !== 'assistant' || !['end_turn', 'stop_sequence'].includes(data.stop_reason) ||
      !Array.isArray(data.content) || !data.content.some(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())) {
    throw new Error('The endpoint did not return a completed text reply.');
  }
  return typeof data.model === 'string' ? data.model.slice(0, 128) : '';
}

if (typeof module !== 'undefined' && module.exports) module.exports = { probeConnection };
