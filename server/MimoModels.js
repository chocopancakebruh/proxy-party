const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseConfig } = require('./Config');
const { requestError } = require('./HttpRequest');

const MODELS = Object.freeze([
  Object.freeze({ id: 'xiaomi/mimo-v2.6-pro', label: 'MiMo v2.6 Pro' }),
  Object.freeze({ id: 'xiaomi/mimo-v2.6-flash', label: 'MiMo v2.6 Flash' })
]);

function replaceModel(contents, model) {
  parseConfig(contents);
  let found = false;
  const updated = contents.replace(/^(\s*mimo_model\s*=)[^\r\n]*/gm, (line, prefix) => {
    found = true;
    const comment = line.match(/\s+#.*$/)?.[0] || '';
    return `${prefix}${model}${comment}`;
  });
  if (found) return updated;
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  return `${contents}${contents && !contents.endsWith('\n') ? newline : ''}mimo_model=${model}${newline}`;
}

function createMimoModels({ config, configFile = path.join(__dirname, 'config.txt'), io = fs }) {
  function getSelection() {
    return {
      selected: MODELS.some(model => model.id === config.mimo_model) ? config.mimo_model : null,
      custom: Boolean(config.mimo_model) && !MODELS.some(model => model.id === config.mimo_model),
      options: MODELS
    };
  }

  function select(model) {
    if (!MODELS.some(option => option.id === model)) {
      throw requestError('Choose MiMo v2.6 Pro or MiMo v2.6 Flash.', 400);
    }
    const temporary = `${configFile}.${randomUUID()}.tmp`;
    try {
      // Read the latest file so unrelated edits survive. Commit to disk before
      // changing the shared config used by new MiMo requests.
      const contents = io.readFileSync(configFile, 'utf8');
      const updated = replaceModel(contents, model);
      io.writeFileSync(temporary, updated, { flag: 'wx', mode: io.statSync(configFile).mode });
      io.renameSync(temporary, configFile);
    } catch {
      throw requestError('Could not save the MiMo model. Check that server/config.txt is writable, then try again. The active model was not changed.', 500);
    } finally {
      try { io.unlinkSync(temporary); } catch {}
    }
    config.mimo_model = model;
    return getSelection();
  }

  return { getSelection, select };
}

module.exports = { createMimoModels, MODELS };
