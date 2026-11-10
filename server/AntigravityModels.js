const { createModelPicker } = require('./ModelPicker');

// Antigravity CLI model slugs used with agy --model.
const DEFAULT_MODEL = 'gemini-4-argon-high';
const MODELS = Object.freeze([
  { id: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon (High)' },
  { id: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)' },
  { id: 'gemini-4-carbon-low', label: 'Gemini 4 Carbon (Low)' },
  { id: DEFAULT_MODEL, label: 'Gemini 4 Argon (High)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }
].map(Object.freeze));

function createAntigravityModels(settings) {
  return createModelPicker(settings, {
    key: 'argon_model', label: 'Antigravity', options: MODELS, defaultModel: DEFAULT_MODEL,
    invalidMessage: 'Choose an Antigravity model from the list.'
  });
}

module.exports = { createAntigravityModels, DEFAULT_MODEL, MODELS };
