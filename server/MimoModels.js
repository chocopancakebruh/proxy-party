const { createModelPicker } = require('./ModelPicker');

const MODELS = Object.freeze([
  Object.freeze({ id: 'xiaomi/mimo-v2.6-pro', label: 'MiMo v2.6 Pro' }),
  Object.freeze({ id: 'xiaomi/mimo-v2.6-flash', label: 'MiMo v2.6 Flash' })
]);

function createMimoModels(settings) {
  return createModelPicker(settings, {
    key: 'mimo_model', label: 'MiMo', options: MODELS, invalidMessage: 'Choose MiMo v2.6 Pro or MiMo v2.6 Flash.'
  });
}

module.exports = { createMimoModels, MODELS };
