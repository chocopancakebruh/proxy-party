const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { stripVTControlCharacters } = require('node:util');
const { JsonLineClient } = require('./providers/JsonLineClient');
const { spawnProvider, stopProcess, resolveCommand } = require('./providers/process');
const { parseConfiguredArgs } = require('./providers/common');
const { MUSE_ARGS, commandId, validateInitialization } = require('./providers/muse');

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

async function codexModels(client) {
  await client.request('initialize', { clientInfo: { name: 'proxy_party', version: '1.0.0' }, capabilities: null });
  client.notify('initialized');
  const options = [];
  const cursors = new Set();
  let cursor = null;
  do {
    const page = await client.request('model/list', { cursor, limit: 100, includeHidden: false });
    for (const row of page.data) {
      if (row.hidden || typeof row.model !== 'string' || !MODEL_ID.test(row.model)) continue;
      const efforts = EFFORTS.filter(e => row.supportedReasoningEfforts?.some(option => option.reasoningEffort === e));
      if (efforts.length) options.push({ id: row.model, label: row.displayName || row.model, efforts, defaultEffort: efforts.includes(row.defaultReasoningEffort) ? row.defaultReasoningEffort : efforts[0] });
    }
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 20)) throw new Error('Invalid model list cursor');
    cursors.add(cursor);
  } while (cursor);
  return options;
}

async function museModels(client, cwd) {
  validateInitialization(await client.request('initialize', {
    clientInfo: { name: 'proxy_party', version: '1.0.0' },
    capabilities: { experimentalApi: false, requestedCapabilities: [], userInputDialogs: false }
  }));
  client.notify('initialized');
  const sessionId = commandId(randomUUID);
  const { session } = await client.request('session/start', { sessionId, commandId: commandId(randomUUID),
    workspaceRoot: cwd, providerId: 'meta', approvalMode: 'denyUnmatched' });
  if (session?.sessionId !== sessionId || session.providerId !== 'meta' || session.path !== '') throw new Error('Invalid Muse session');
  const result = await client.request('model/list', { sessionId });
  return result.models.filter(row => row.providerId === 'meta' && typeof row.modelId === 'string' && MODEL_ID.test(row.modelId) &&
    !/contributor/i.test(row.modelId)).map(row => ({ id: row.modelId, label: row.displayLabel || row.modelId }));
}

function agyModels(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (output.length + chunk.length <= 1024 * 1024) output += chunk;
      else reject(new Error('Model list too large'));
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(new Error('agy models failed'));
      const rows = stripVTControlCharacters(output).split(/\r?\n/);
      const options = [];
      for (const row of rows) {
        const match = /^\s*([a-z0-9]+[-.][a-z0-9.:-]+)\s+(.+?)\s*$/.exec(row);
        if (match && MODEL_ID.test(match[1])) options.push({ id: match[1], label: match[2] });
      }
      resolve(options);
    });
    child.stdin.on('error', reject);
    child.stdin.end();
  });
}

async function discoverModels(provider, { config, env }, dependencies = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-party-models-'));
  let child, client, timer;
  try {
    const muse = provider === 'muse';
    const agy = provider === 'argon';
    const command = config[provider + '_command'] || (agy ? (process.platform === 'win32' ? 'agy.exe' : 'agy') : provider);
    if (agy && process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolveCommand(command, { env }))) throw new Error('Use native agy.exe');
    const args = agy ? ['models'] : muse ? [...MUSE_ARGS] : parseConfiguredArgs(config.codex_args, 'app-server');
    const cliEnv = { ...env };
    if (muse) { cliEnv.MUSE_NO_AUTO_UPDATE = '1'; cliEnv.MUSE_LOGIN = '0'; delete cliEnv.MUSE_TRANSPORT_TRACE; }
    child = spawnProvider(command, args, { cwd, env: cliEnv }, dependencies);
    child.stderr.resume();
    if (!agy) client = new JsonLineClient(child, { name: provider, protocol: muse ? 'acp' : 'codex', maxOutputLength: 2 * 1024 * 1024 });
    const query = agy ? agyModels(child) : muse ? museModels(client, cwd) : codexModels(client);
    const options = await Promise.race([query, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Model list timed out')), 12000);
    })]);
    if (!options.length) throw new Error('Empty model catalog');
    return [...new Map(options.map(o => [o.id, o])).values()];
  } finally {
    clearTimeout(timer);
    client?.close();
    await stopProcess(child, dependencies);
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

module.exports = { discoverModels, codexModels, museModels };
