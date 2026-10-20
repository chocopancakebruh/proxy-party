const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { requestError } = require('./HttpRequest');

// Provider capabilities live here; accounts are data, never extra routes or cards.
const CATALOG = Object.freeze([
  { id: 'claude', label: 'Claude', kind: 'oauth', mark: 'C', short: 'ANTHROPIC' },
  { id: 'kimi', label: 'Kimi', kind: 'cli', mark: 'K', short: 'MOONSHOT AI', handler: 'handleKimiRequest' },
  { id: 'codex', label: 'Codex', kind: 'cli', mark: '>_', short: 'OPENAI', handler: 'handleCodexRequest' },
  { id: 'grok', label: 'Grok', kind: 'cli', mark: 'G', short: 'XAI', handler: 'handleGrokRequest' },
  { id: 'argon', label: 'Argon', kind: 'cli', mark: 'Ar', short: 'ARGON', handler: 'handleArgonRequest' },
  { id: 'mimo', label: 'MiMo', kind: 'cli', mark: 'Mi', short: 'XIAOMI', handler: 'handleMimoRequest' },
  { id: 'muse', label: 'Meta Muse', kind: 'cli', mark: 'M', short: 'META', handler: 'handleMuseRequest' }
].map(provider => Object.freeze({ ...provider, independentAccounts: provider.id !== 'argon' })));
const providerDefinition = id => CATALOG.find(provider => provider.id === id);
const LEGACY = Object.freeze([
  { id: 'claude1', provider: 'claude', label: 'Claude 1' },
  { id: 'claude2', provider: 'claude', label: 'Claude 2' },
  ...CATALOG.filter(provider => provider.kind === 'cli').map(({ id, label }) => ({ id, provider: id, label }))
].map(connection => Object.freeze({ ...connection, legacy: true, settings: {} })));
const SETTINGS = ['model', 'effort', 'reasoning_mode', 'reasoning_summary'];
const GENERATED_ID = /^([a-z][a-z0-9]*)-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const isConnectionId = id => typeof id === 'string' && (LEGACY.some(connection => connection.id === id) ||
  Boolean(providerDefinition(GENERATED_ID.exec(id)?.[1])));

function createConnectionRegistry({ filename, profilesDir = path.join(__dirname, 'data', 'profiles'), config = {}, io = fs } = {}) {
  let connections = LEGACY.map(connection => ({ ...connection, settings: {} }));
  function validate(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.connections)) throw new Error('Invalid connections registry');
    const ids = new Set();
    const singletons = new Set();
    for (const connection of value.connections) {
      const definition = providerDefinition(connection?.provider);
      const legacy = LEGACY.find(item => item.id === connection?.id);
      if (!definition || !isConnectionId(connection.id) || ids.has(connection.id) ||
          typeof connection.label !== 'string' || !connection.label.trim() || connection.label.length > 80 ||
          /[\x00-\x1f\x7f]/.test(connection.label) || typeof connection.legacy !== 'boolean' ||
          (connection.legacy ? !legacy || legacy.provider !== connection.provider : Boolean(legacy) || !connection.id.startsWith(`${connection.provider}-`)) ||
          !connection.settings || typeof connection.settings !== 'object' || Array.isArray(connection.settings) ||
          Object.entries(connection.settings).some(([key, value]) => !SETTINGS.includes(key) || typeof value !== 'string' || value.length > 256)) {
        throw new Error('Invalid connection record');
      }
      ids.add(connection.id);
      if (!definition.independentAccounts) {
        if (singletons.has(connection.provider)) throw new Error('Duplicate shared-account provider');
        singletons.add(connection.provider);
      }
    }
    return value.connections.map(({ id, provider, label, legacy, settings }) => ({ id, provider, label, legacy, settings: { ...settings } }));
  }
  function commit(next) {
    next = validate({ version: 1, connections: next });
    if (filename) {
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        io.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        io.writeFileSync(temporary, JSON.stringify({ version: 1, connections: next }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        io.renameSync(temporary, filename);
      } catch {
        throw requestError('Could not save connections. Check the proxy data directory permissions. No connection was changed.', 500);
      } finally { try { io.unlinkSync(temporary); } catch {} }
    }
    connections = next;
  }
  if (filename) {
    try { connections = validate(JSON.parse(io.readFileSync(filename, 'utf8'))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot read connections registry. Restore server/data/connections.json; it has not been replaced.');
      commit(connections);
    }
  }
  const copy = connection => connection && { ...connection, settings: { ...connection.settings } };
  const get = id => copy(connections.find(connection => connection.id === id));
  return {
    list: () => connections.map(copy), get,
    catalog: () => CATALOG.map(({ handler, ...provider }) => ({ ...provider,
      canAdd: provider.independentAccounts || !connections.some(connection => connection.provider === provider.id),
      ...(provider.independentAccounts ? {} : { accountNote: 'Uses the system Argon sign-in. Only one connection is supported.' }) })),
    profileDir(id) {
      if (!isConnectionId(id)) throw requestError('Unknown connection', 404);
      return path.join(profilesDir, id);
    },
    add(provider, label) {
      const definition = providerDefinition(provider);
      if (!definition) throw requestError('Choose a supported provider');
      if (!definition.independentAccounts && connections.some(connection => connection.provider === provider)) {
        throw requestError('Argon uses a shared system sign-in. Independent Argon subscriptions are not supported by this adapter.', 409);
      }
      if (label !== undefined && (typeof label !== 'string' || label.length > 80 || /[\x00-\x1f\x7f]/.test(label))) throw requestError('Use a name of at most 80 characters');
      let number = 1;
      while (connections.some(connection => connection.label === `${definition.label} ${number}`)) number++;
      const connection = { id: `${provider}-${randomUUID()}`, provider, label: label?.trim() || `${definition.label} ${number}`, legacy: false,
        settings: Object.fromEntries(SETTINGS.filter(key => config[`${provider}_${key}`] != null).map(key => [key, String(config[`${provider}_${key}`])])) };
      commit([...connections, connection]);
      return copy(connection);
    },
    remove(id) {
      if (!get(id)) throw requestError('Unknown connection', 404);
      commit(connections.filter(connection => connection.id !== id));
    },
    setModel(id, model) {
      if (!get(id)) throw requestError('Unknown connection', 404);
      commit(connections.map(connection => connection.id === id ? { ...connection, settings: { ...connection.settings, model } } : connection));
    }
  };
}

function connectionPath(connection) {
  return connection.legacy ? connection.id === 'claude1' ? '/v1' : `/v1/${connection.id}` : `/v1/connections/${connection.id}`;
}

module.exports = { createConnectionRegistry, CATALOG, LEGACY, providerDefinition, isConnectionId, connectionPath };
