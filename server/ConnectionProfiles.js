const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCliAuth } = require('./CliAuth');
const { createProviderHandlers } = require('./providers');
const { readArgonThinking } = require('./ArgonThinking');
const { providerDefinition } = require('./ConnectionRegistry');
const { parseConfiguredArgs } = require('./providers/common');

// Remove inherited provider credentials and directory overrides before installing
// an account's profile. Windows environment keys are case-insensitive.
function profileEnvironment(home, inherited = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (/^(CODEX|OPENAI|KIMI|GROK|XAI|MIMOCODE|MIMO|MUSE|META|ANTHROPIC|CLAUDE|AGY|ANTIGRAVITY|GEMINI|GOOGLE|CLOUDSDK|XDG)_/i.test(key) ||
        /^(HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA)$/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env,
    HOME: home, USERPROFILE: home, HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(path.parse(home).root.length - 1),
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    CODEX_HOME: path.join(home, '.codex'), KIMI_CODE_HOME: path.join(home, '.kimi-code'), KIMI_SHARE_DIR: path.join(home, '.kimi'),
    GROK_HOME: path.join(home, '.grok'), MIMOCODE_HOME: path.join(home, '.mimocode')
  };
}

function createConnectionProfiles({ registry, config, logger, cliAuth, providers, cliAuthFactory = createCliAuth, providerFactory = createProviderHandlers }) {
  const runtimes = new Map();
  function get(connection) {
    let runtime = runtimes.get(connection.id);
    if (runtime) return runtime;
    const isolated = !connection.legacy && providerDefinition(connection.provider).independentAccounts;
    const home = isolated ? registry.profileDir(connection.id) : os.homedir();
    const env = isolated ? profileEnvironment(home) : process.env;
    const settings = connection.legacy ? config : { ...config };
    if (!connection.legacy) {
      // Models/effort are snapshots; later changes to the legacy connection must
      // not change another account's model selection.
      for (const key of ['model', 'effort', 'reasoning_mode', 'reasoning_summary']) {
        delete settings[`${connection.provider}_${key}`];
      }
      for (const [key, value] of Object.entries(connection.settings)) settings[`${connection.provider}_${key}`] = value;
      if (connection.provider === 'codex') settings.codex_args = [...parseConfiguredArgs(config.codex_args, 'app-server'), '-c', 'cli_auth_credentials_store="file"'];
    }
    runtime = { home, env, config: settings, isolated };
    runtimes.set(connection.id, runtime);
    return runtime;
  }
  function prepare(connection) {
    const runtime = get(connection);
    if (runtime.isolated) {
      for (const directory of [runtime.home, ...Object.entries(runtime.env).filter(([key]) =>
        ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
          'CODEX_HOME', 'KIMI_CODE_HOME', 'KIMI_SHARE_DIR', 'GROK_HOME', 'MIMOCODE_HOME'].includes(key)).map(([, value]) => value)]) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      }
    }
    return runtime;
  }
  function auth(connection) {
    const runtime = get(connection);
    return runtime.auth ||= connection.legacy && cliAuth ? cliAuth : cliAuthFactory({
      config: runtime.config, env: runtime.env, homeDir: runtime.home,
      isolated: runtime.isolated, connectionLabel: connection.label
    });
  }
  return {
    get, prepare, auth,
    handlers(connection) {
      const runtime = prepare(connection);
      return runtime.handlers ||= connection.legacy && providers ? providers : providerFactory({
        config: runtime.config, Logger: logger,
        process: { platform: process.platform, env: runtime.env },
        os: { ...os, homedir: () => runtime.home },
        readArgonThinking: (id, text) => readArgonThinking(id, text, { brainDir: path.join(runtime.home, '.gemini', 'antigravity-cli', 'brain') })
      });
    },
    closeConnection(id) { runtimes.get(id)?.auth?.close(); runtimes.delete(id); },
    close() { for (const service of new Set([...runtimes.values()].map(runtime => runtime.auth))) service?.close(); }
  };
}

module.exports = { profileEnvironment, createConnectionProfiles };
