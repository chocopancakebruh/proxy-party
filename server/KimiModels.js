const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseConfig } = require('./Config');
const { requestError } = require('./HttpRequest');

// Managed Kimi Code aliases: https://www.kimi.com/code/docs/en/kimi-code/models
const DEFAULT_MODEL = 'kimi-code/k3-256k';
const MODELS = Object.freeze([
  { id: 'kimi-code/k3.1-pro', label: 'Kimi K3.1 Pro' },
  { id: 'kimi-code/k3.1-pro-highspeed', label: 'Kimi K3.1 Pro Highspeed (2× quota)' },
  { id: DEFAULT_MODEL, label: 'Kimi K3 256K' },
  { id: 'kimi-code/k3', label: 'Kimi K3 1M' },
  { id: 'kimi-code/kimi-for-coding', label: 'Kimi K2.8 Preview' },
  { id: 'kimi-code/kimi-for-coding-highspeed', label: 'Kimi K2.7 Code Highspeed' }
].map(Object.freeze));

function getKimiSelection(config) {
  const model = config.kimi_model || DEFAULT_MODEL;
  return { selected: MODELS.some(option => option.id === model) ? model : null,
    custom: !MODELS.some(option => option.id === model), options: MODELS };
}

function replaceModel(contents, model) {
  parseConfig(contents);
  let found = false;
  const updated = contents.replace(/^(\s*kimi_model\s*=)[^\r\n]*/gm, (line, prefix) => {
    found = true;
    const comment = line.match(/\s+#.*$/)?.[0] || '';
    return `${prefix}${model}${comment}`;
  });
  if (found) return updated;
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  return `${contents}${contents && !contents.endsWith('\n') ? newline : ''}kimi_model=${model}${newline}`;
}

function createKimiModels({ config, configFile = path.join(__dirname, 'config.txt'), io = fs }) {
  const getSelection = () => getKimiSelection(config);

  function select(model) {
    if (!MODELS.some(option => option.id === model)) {
      throw requestError('Choose a Kimi model from the list.', 400);
    }
    const temporary = `${configFile}.${randomUUID()}.tmp`;
    try {
      // Read the latest file so unrelated edits survive. Commit to disk before
      // changing the shared config used by new Kimi requests.
      const contents = io.readFileSync(configFile, 'utf8');
      const updated = replaceModel(contents, model);
      io.writeFileSync(temporary, updated, { flag: 'wx', mode: io.statSync(configFile).mode });
      io.renameSync(temporary, configFile);
    } catch {
      throw requestError('Could not save the Kimi model. Check that server/config.txt is writable, then try again. The active model was not changed.', 500);
    } finally {
      try { io.unlinkSync(temporary); } catch {}
    }
    config.kimi_model = model;
    return getSelection();
  }

  return { getSelection, select };
}

module.exports = { createKimiModels, getKimiSelection, DEFAULT_MODEL, MODELS };
