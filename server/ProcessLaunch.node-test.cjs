const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveNpmLauncher, spawnProvider, stopProcess } = require('./providers/process');

function npmShim(script) {
  return ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`, ''].join('\r\n');
}

test('npm Windows shims launch their Node entry point directly with literal arguments', () => {
  const command = 'C:\\Users\\A & B\\npm\\mimo.cmd';
  const script = 'C:\\Users\\A & B\\npm\\node_modules\\@mimo-ai\\cli\\bin\\mimo';
  const args = ['acp', 'spaces and "quotes"', '%PATH%', '& echo injected', 'end\\', '🌟'];
  const calls = [];
  const filesystem = { readFileSync: () => npmShim('node_modules\\@mimo-ai\\cli\\bin\\mimo'),
    existsSync: filename => [command, script].includes(filename) };
  spawnProvider(command, args, { cwd: 'C:\\work' }, { platform: 'win32', fs: filesystem,
    nodePath: 'C:\\node\\node.exe', spawn(...call) { calls.push(call); return new EventEmitter(); } });
  assert.equal(calls[0][0], 'C:\\node\\node.exe');
  assert.deepEqual(calls[0][1], [script, ...args]);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].cwd, 'C:\\work');
  assert.equal(args[0], 'acp');
});

test('npm shims preserve an adjacent node.exe and relative package entry points', () => {
  const result = resolveNpmLauncher('C:\\project\\node_modules\\.bin\\mimo.cmd', {
    readFileSync: () => npmShim('..\\@mimo-ai\\cli\\bin\\mimo'), existsSync: () => true
  }, 'C:\\fallback\\node.exe');
  assert.deepEqual(result, { command: 'C:\\project\\node_modules\\.bin\\node.exe',
    script: 'C:\\project\\node_modules\\@mimo-ai\\cli\\bin\\mimo' });
});

test('native binaries and custom or missing batch wrappers are not mistaken for npm launchers', () => {
  const filesystem = { readFileSync: () => '@echo off\r\necho custom %*', existsSync: () => true };
  for (const name of ['mimo.exe', 'mimo.bat', 'mimo.cmd']) assert.equal(resolveNpmLauncher(name, filesystem), null);
  assert.equal(resolveNpmLauncher('mimo.cmd', { readFileSync() { throw new Error('absent'); } }), null);
  assert.equal(resolveNpmLauncher('C:\\bin\\mimo.cmd', { readFileSync: () => npmShim('absent.js'), existsSync: () => false }), null);
  const calls = [];
  spawnProvider('C:\\bin\\mimo.exe', ['acp'], {}, { platform: 'win32', fs: filesystem,
    spawn(...call) { calls.push(call); return new EventEmitter(); } });
  assert.equal(calls[0][0], 'C:\\bin\\mimo.exe');
  assert.deepEqual(calls[0][1], ['acp']);
  assert.equal(calls[0][2].shell, false);
});

test('real Windows npm launcher preserves metacharacters and emits no DEP0190 warning', { skip: process.platform !== 'win32', timeout: 5000 }, async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy npm & launch-'));
  const command = path.join(root, 'example.cmd');
  const entry = path.join(root, 'entry.cjs');
  fs.writeFileSync(command, npmShim('entry.cjs'));
  fs.writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const warnings = [];
  const onWarning = warning => warnings.push(warning.code);
  process.on('warning', onWarning);
  context.after(() => { process.off('warning', onWarning); fs.rmSync(root, { recursive: true, force: true }); });
  const args = ['hello world', '"quotes"', 'a&b|c>d<e', '%PATH%', '!bang!', '(parens)', '^caret', 'trailing\\', 'line\nbreak', '🌟'];
  const child = spawnProvider(command, args);
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    });
    assert.deepEqual(JSON.parse(output), args);
    assert.equal(warnings.includes('DEP0190'), false);
  } finally { await stopProcess(child); }
});
