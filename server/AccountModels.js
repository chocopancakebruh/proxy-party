const { requestError } = require('./HttpRequest');
const { modelSelection, saveSettings } = require('./ModelPicker');
const { MODELS: argon, DEFAULT_MODEL: defaultArgon } = require('./AntigravityModels');
const { discoverModels } = require('./ModelCatalog');

const muse = [
  { id: 'muse-spark-1.3', label: 'Muse Spark 1.3' }, { id: 'muse-ember-1.0', label: 'Muse Ember 1.0' },
  { id: 'muse-wonder-1.0', label: 'Muse Wonder 1.0' }
];
const codex = [
  ['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-6-astra', 'GPT-6 Astra'], ['gpt-6.1-terra', 'GPT-6.1 Terra'],
  ['gpt-6-luna', 'GPT-6 Luna'], ['gpt-5.6-sol', 'GPT-5.6 Sol']
].map(([id, label]) => ({ id, label, efforts: ['low', 'medium', 'high', 'xhigh', 'max', ...(id.endsWith('luna') ? [] : ['ultra'])] }));
const defaults = { codex: 'gpt-5.6-sol', argon: defaultArgon, muse: 'cli-default' };
const builtins = { codex, argon, muse };

function createAccountModels({ profiles, registry, configFile, discover = discoverModels }) {
  const supports = provider => Object.hasOwn(builtins, provider);
  function selection(connection) {
    const provider = connection.provider;
    const runtime = profiles.get(connection);
    let options = runtime.modelCatalog || builtins[provider];
    if (provider === 'muse') options = [{ id: 'cli-default', label: 'Muse Code default' }, ...options];
    const state = modelSelection(options, runtime.config[provider + '_model'] || defaults[provider]);
    state.catalogSource = runtime.modelCatalog ? 'cli' : 'built-in';
    if (provider === 'codex') state.effort = runtime.config.codex_effort || 'high';
    return state;
  }

  async function refresh(connection) {
    const runtime = profiles.prepare(connection);
    // Concurrent dashboards share one lookup for this account.
    if (!runtime.catalogRequest) runtime.catalogRequest = discover(connection.provider, runtime)
      .then(options => { runtime.modelCatalog = options; })
      .catch(() => { delete runtime.modelCatalog; throw requestError('Could not read the model list. Check the CLI installation and sign-in for this connection, then retry.', 502); })
      .finally(() => { delete runtime.catalogRequest; });
    await runtime.catalogRequest;
    if (!registry.get(connection.id)) throw requestError('Connection removed', 404);
    return selection(connection);
  }

  function save(connection, body) {
    const { provider } = connection;
    const state = selection(connection);
    const option = state.options.find(o => o.id === body.model);
    if (!option) throw requestError('Choose a model listed for this connection.');
    const fields = { model: provider === 'muse' && option.id === 'cli-default' ? '' : option.id };
    if (provider === 'codex') {
      const effort = body.effort === undefined ? (option.efforts.includes(state.effort) ? state.effort : option.defaultEffort || option.efforts[0]) : body.effort;
      if (!option.efforts.includes(effort)) throw requestError('Choose a supported reasoning effort for this model.');
      fields.effort = effort;
    }
    const config = profiles.get(connection).config;
    const values = Object.fromEntries(Object.entries(fields).map(([k,v]) => [provider + '_' + k, v]));
    if (connection.legacy) saveSettings({ config, configFile }, values, provider);
    else { registry.setSettings(connection.id, fields); Object.assign(config, values); }
    return selection(connection);
  }
  return { supports, selection, refresh, save };
}

module.exports = { createAccountModels };
