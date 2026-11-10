const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseConfig } = require('./Config');
const { requestError } = require('./HttpRequest');

function modelSelection(options, model) {
  const selected = options.find(option => option.id === model)?.id ?? null;
  return { selected, custom: Boolean(model) && !selected, options };
}

function replaceModel(contents, key, model) {
  parseConfig(contents);
  // Keys come from the built-in provider definitions.
  const entry = new RegExp(`^([ \\t]*${key}[ \\t]*=)[^\\r\\n]*`, 'gm');
  let found = false;
  const updated = contents.replace(entry, (line, prefix) => {
    found = true;
    return prefix + model + (line.match(/\s+#.*$/)?.[0] || '');
  });
  if (found) return updated;
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  return contents + (contents && !contents.endsWith('\n') ? newline : '') + key + '=' + model + newline;
}

function createModelPicker({ config, configFile = path.join(__dirname, 'config.txt'), io = fs },
  { key, label, options, defaultModel, invalidMessage = `Choose a ${label} model from the list.` }) {
  function getSelection(settings = config) {
    return modelSelection(options, settings[key] || defaultModel);
  }
  function validate(model) {
    if (!options.some(option => option.id === model)) throw requestError(invalidMessage, 400);
  }
  function select(model) {
    validate(model);
    const temporary = `${configFile}.${randomUUID()}.tmp`;
    try {
      const updated = replaceModel(io.readFileSync(configFile, 'utf8'), key, model);
      io.writeFileSync(temporary, updated, { flag: 'wx', mode: io.statSync(configFile).mode });
      io.renameSync(temporary, configFile);
    } catch {
      throw requestError(`Could not save the ${label} model. Check that server/config.txt is writable, then try again. The active model was not changed.`, 500);
    } finally {
      try { io.unlinkSync(temporary); } catch {}
    }
    config[key] = model;
    return getSelection();
  }
  return { label, getSelection, validate, select };
}

module.exports = { createModelPicker, modelSelection };
