const { createAcpHandler } = require('./acp');
const { createCodexHandler } = require('./codex');
const { createArgonHandler } = require('./argon');
const { createMimoHandler } = require('./mimo');
const { createMuseHandler } = require('./muse');

function createProviderHandlers(options = {}) {
  const dependencies = {
    config: {}, Logger: require('../Logger'),
    spawn: require('node:child_process').spawn,
    fs: require('node:fs'), os: require('node:os'), path: require('node:path'),
    randomUUID: require('node:crypto').randomUUID,
    readArgonThinking: require('../ArgonThinking').readArgonThinking,
    process,
    ...options
  };
  return {
    handleKimiRequest: createAcpHandler('Kimi', dependencies),
    handleGrokRequest: createAcpHandler('Grok', dependencies),
    handleCodexRequest: createCodexHandler(dependencies),
    handleArgonRequest: createArgonHandler(dependencies),
    handleMimoRequest: createMimoHandler(dependencies),
    handleMuseRequest: createMuseHandler(dependencies)
  };
}

module.exports = { createProviderHandlers };
