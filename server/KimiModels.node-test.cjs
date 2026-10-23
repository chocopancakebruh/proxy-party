const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createKimiModels } = require('./KimiModels');
const { loadConfig } = require('./Config');

const pro = 'kimi-code/k3.1-pro';
const flash = 'kimi-code/k3.1-pro-highspeed';

function setup(context, contents, io = fs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-kimi-models-'));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configFile = path.join(home, 'config.txt');
  fs.writeFileSync(configFile, contents);
  const config = loadConfig(configFile, {});
  const models = createKimiModels({ config, configFile, io });
  return { home, configFile, config, models };
}

test('model switches persist across reloads and preserve unrelated settings, comments and CRLF', context => {
  const original = `# model\r\nport=42069\r\nkimi_model = ${pro} # preferred model\r\nproxy_api_key=synthetic-secret\r\n`;
  const { config, configFile, home, models } = setup(context, original);
  assert.equal(models.getSelection().selected, pro);
  assert.ok(models.getSelection().options.some(model => model.id === pro));
  assert.ok(models.getSelection().options.some(model => model.id === flash));
  assert.equal(models.select(flash).selected, flash);
  assert.equal(config.kimi_model, flash);
  assert.equal(loadConfig(configFile, {}).kimi_model, flash);
  assert.equal(fs.readFileSync(configFile, 'utf8'), original.replace(` ${pro}`, flash));
  assert.deepEqual(fs.readdirSync(home), ['config.txt']);
  // Changes made outside the dashboard since the previous save are retained.
  fs.appendFileSync(configFile, 'log_level=DEBUG\r\n');
  models.select(pro);
  assert.equal(loadConfig(configFile, {}).log_level, 'DEBUG');
});

test('missing and duplicate entries save an unambiguous choice without replacing commented examples', context => {
  for (const contents of ['port=42069', '', `# kimi_model=example\nkimi_model=${pro}\nkimi_model=custom\n`]) {
    const { configFile, models } = setup(context, contents);
    models.select(flash);
    assert.equal(loadConfig(configFile, {}).kimi_model, flash);
    if (contents.includes('example')) assert.match(fs.readFileSync(configFile, 'utf8'), /^# kimi_model=example\n/);
  }
});

test('custom and default models are not silently changed or exposed in selection status', context => {
  const { models, config } = setup(context, 'kimi_model=custom/private-model\n');
  assert.equal(models.getSelection().selected, null);
  assert.equal(models.getSelection().custom, true);
  assert.doesNotMatch(JSON.stringify(models.getSelection()), /private-model/);
  delete config.kimi_model;
  assert.equal(models.getSelection().selected, 'kimi-code/k3-256k');
  assert.equal(models.getSelection().custom, false);
});

test('unlisted, malformed and implicit model choices cannot change file or runtime', context => {
  const original = `kimi_model=${pro}\n`;
  const { models, config, configFile } = setup(context, original);
  for (const model of [null, undefined, '', pro + '\nport=1', 'xiaomi/kimi-v2.6-pro-ultraspeed', 'kimi-v2.6-flash', {}, [flash]]) {
    assert.throws(() => models.select(model), { statusCode: 400 });
  }
  assert.equal(config.kimi_model, pro);
  assert.equal(fs.readFileSync(configFile, 'utf8'), original);
});

test('failed atomic commit leaves active model and original file unchanged and cleans temporary file', context => {
  const original = `kimi_model=${pro}\n`;
  const io = { ...fs, renameSync() { throw new Error('private path and details'); } };
  const { models, config, configFile, home } = setup(context, original, io);
  assert.throws(() => models.select(flash), error => {
    assert.equal(error.statusCode, 500);
    assert.doesNotMatch(error.message, /private path/);
    return true;
  });
  assert.equal(config.kimi_model, pro);
  assert.equal(fs.readFileSync(configFile, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(home), ['config.txt']);
});
