const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readArgonThinking } = require('./ArgonThinking');

const ID = '12345678-1234-4234-8234-123456789abc';
const OTHER_ID = '87654321-4321-4321-8321-cba987654321';
const reply = (overrides = {}) => ({
  step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', source: 'MODEL',
  content: 'Synthetic answer.', thinking: 'Synthetic reasoning.', ...overrides
});
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

async function fixture(t) {
  const brainDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argon-thinking-test-'));
  t.after(() => fs.rm(brainDir, { recursive: true, force: true }));
  const filename = id => path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
  const write = async (text, id = ID) => {
    await fs.mkdir(path.dirname(filename(id)), { recursive: true });
    await fs.writeFile(filename(id), text);
  };
  const read = (expectedText = 'Synthetic answer.', overrides = {}, id = ID) =>
    readArgonThinking(id, expectedText, { brainDir, retries: 0, ...overrides });
  return { write, read };
}

test('returns only reasoning from the matching completed response', async t => {
  const { write, read } = await fixture(t);
  await write(jsonl([
    { step_index: 0, type: 'USER_INPUT', content: 'Synthetic user text.' },
    reply()
  ]));
  assert.equal(await read(), 'Synthetic reasoning.');
  assert.equal(await read('Different answer.'), '');
});

test('reads only the exact UUID and rejects traversal or invalid IDs', async t => {
  const { write, read } = await fixture(t);
  await write(jsonl([reply()]), OTHER_ID);
  assert.equal(await read(), '');
  for (const id of [null, '', '../' + OTHER_ID, ID + '/../' + OTHER_ID, 'C:\\' + OTHER_ID, ID + '\n']) {
    assert.equal(await read(undefined, {}, id), '');
  }
  assert.equal(await read(undefined, {}, OTHER_ID), 'Synthetic reasoning.');
});

test('missing and malformed logs fail softly', async t => {
  const { write, read } = await fixture(t);
  assert.equal(await read(), '');
  for (const text of ['{unfinished', 'null\n', '[]\n', jsonl([reply({ step_index: '1' })])]) {
    await write(text);
    assert.equal(await read(), '');
  }
});

test('waits briefly for a missing transcript to be flushed', async t => {
  const { write, read } = await fixture(t);
  const pendingRead = read(undefined, { retries: 4, retryDelayMs: 30 });
  await new Promise(resolve => setTimeout(resolve, 15));
  await write(jsonl([reply()]));
  assert.equal(await pendingRead, 'Synthetic reasoning.');
});

test('retries a partial JSONL write until the whole answer matches', async t => {
  const { write, read } = await fixture(t);
  await write(jsonl([reply({ content: 'Synthetic ', thinking: 'First part.' })]) + '{"step_index":2');
  const pendingRead = read(undefined, { retries: 4, retryDelayMs: 30 });
  await new Promise(resolve => setTimeout(resolve, 15));
  await write(jsonl([
    reply({ content: 'Synthetic ', thinking: 'First part.' }),
    reply({ step_index: 2, content: 'answer.', thinking: 'Second part.' })
  ]));
  assert.equal(await pendingRead, 'First part.\n\nSecond part.');
});

test('deduplicates latest step records and orders answer segments by step', async t => {
  const { write, read } = await fixture(t);
  await write(jsonl([
    reply({ step_index: 2, content: 'answer.', thinking: 'Second part.' }),
    reply({ content: 'Synthetic ', thinking: 'Outdated thought.', status: 'IN_PROGRESS' }),
    reply({ content: 'Synthetic ', thinking: 'First part.' }),
    reply({ step_index: 2, content: 'answer.', thinking: 'Second part.' })
  ]));
  assert.equal(await read(), 'First part.\n\nSecond part.');
});

test('does not return stale completed state or a partial answer', async t => {
  const { write, read } = await fixture(t);
  await write(jsonl([reply(), reply({ status: 'IN_PROGRESS' })]));
  assert.equal(await read(), '');
  await write(jsonl([reply({ content: 'Synthetic ' })]));
  assert.equal(await read(), '');
});

test('a complete answer without reasoning produces no reasoning', async t => {
  const { write, read } = await fixture(t);
  await write(jsonl([reply({ thinking: undefined })]));
  assert.equal(await read(), '');
  await write(jsonl([reply({ thinking: '' })]));
  assert.equal(await read(), '');
});

test('tool-bearing records and invalid reasoning are never recovered', async t => {
  const { write, read } = await fixture(t);
  for (const fields of [
    { tools: [{ name: 'synthetic_tool' }] },
    { tool_calls: [{ name: 'synthetic_tool' }] },
    { thinking: ['Unexpected structured reasoning'] }
  ]) {
    await write(jsonl([reply(fields)]));
    assert.equal(await read(), '');
  }
  await write(jsonl([reply({ tools: [] })]));
  assert.equal(await read(), 'Synthetic reasoning.');
});

test('explicitly truncated answers can still return reasoning from this completed session', async t => {
  const { write, read } = await fixture(t);
  await write(jsonl([reply({ content: 'Synthetic...', truncated_fields: ['content'] })]));
  assert.equal(await read(), 'Synthetic reasoning.');
  await write(jsonl([reply({ content: 'Synthetic...', truncated_fields: ['content'], status: 'IN_PROGRESS' })]));
  assert.equal(await read(), '');
});

test('preserves available truncated reasoning with an explicit notice', async t => {
  const { write, read } = await fixture(t);
  for (const truncated_fields of [['thinking'], 'thinking', { thinking: true }]) {
    await write(jsonl([reply({ truncated_fields })]));
    assert.equal(await read(), 'Synthetic reasoning.\n\n[Antigravity truncated the saved reasoning.]');
  }
});

test('rejects oversized reasoning without returning a truncated fragment', async t => {
  const { write, read } = await fixture(t);
  await write(jsonl([reply({ thinking: '\u2665'.repeat(90 * 1024) })]));
  assert.equal(await read(), '');
});

test('rejects oversized transcripts and invalid expected answers', async t => {
  const { write, read } = await fixture(t);
  await write(' '.repeat(4 * 1024 * 1024) + jsonl([reply()]));
  assert.equal(await read(), '');
  for (const expected of ['', null, 123, 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    assert.equal(await read(expected), '');
  }
});
