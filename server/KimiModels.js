const { createModelPicker, modelSelection } = require('./ModelPicker');

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
  return modelSelection(MODELS, config.kimi_model || DEFAULT_MODEL);
}

function createKimiModels(settings) {
  return createModelPicker(settings, { key: 'kimi_model', label: 'Kimi', options: MODELS, defaultModel: DEFAULT_MODEL });
}

module.exports = { createKimiModels, getKimiSelection, DEFAULT_MODEL, MODELS };
