const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ownedProcesses = new WeakMap();
const stopping = new WeakMap();

function resolveCommand(command, { platform = process.platform, env = process.env, filesystem = fs } = {}) {
  if (platform !== 'win32') return command;
  const windowsPath = path.win32;
  const directories = windowsPath.isAbsolute(command) || /[\\/]/.test(command)
    ? [''] : String(env.PATH || env.Path || '').split(';');
  const extensions = windowsPath.extname(command) ? [''] : ['.exe', '.com', '.cmd', '.bat', ''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = directory ? windowsPath.join(directory, command + extension) : command + extension;
      if (filesystem.existsSync(candidate)) return candidate;
    }
  }
  return command;
}

function resolveNpmLauncher(command, filesystem = fs, nodePath = process.execPath) {
  if (!/\.cmd$/i.test(command)) return null;
  let contents;
  try { contents = filesystem.readFileSync(command, 'utf8'); } catch { return null; }
  // Recognize npm's generated Node shim, not arbitrary batch commands. Invoke
  // its JS entry point with an argument array so cmd.exe never interprets args.
  if (!/^[ \t]*SET "_prog=node"\s*$/im.test(contents) || !/^CALL :find_dp0\s*$/im.test(contents)) return null;
  const entry = contents.match(/^endLocal & goto #_undefined_# 2>NUL \|\| (?:title %COMSPEC% & )?"%_prog%"\s+"%dp0%\\([^"\r\n]+)" %\*\s*$/im);
  if (!entry) return null;
  const directory = path.win32.dirname(command);
  const script = path.win32.resolve(directory, entry[1]);
  const localNode = path.win32.join(directory, 'node.exe');
  if (!filesystem.existsSync(script)) return null;
  return { command: filesystem.existsSync(localNode) ? localNode : nodePath, script };
}

function spawnProvider(command, args, options = {}, dependencies = {}) {
  const spawn = dependencies.spawn || childProcess.spawn;
  const platform = dependencies.platform || process.platform;
  const resolved = resolveCommand(command, {
    platform, env: options.env, filesystem: dependencies.fs || fs
  });
  const launcher = platform === 'win32'
    ? resolveNpmLauncher(resolved, dependencies.fs || fs, dependencies.nodePath || process.execPath) : null;
  const shell = !launcher && platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
  const executable = launcher ? launcher.command : shell ? `"${resolved}"` : resolved;
  const child = spawn(executable, launcher ? [launcher.script, ...args] : args, {
    ...options, windowsHide: true, shell, detached: platform !== 'win32'
  });
  ownedProcesses.set(child, { platform, grouped: platform !== 'win32' });
  return child;
}

function hasExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function waitForExit(child, milliseconds) {
  return new Promise(resolve => {
    if (hasExited(child)) return resolve();
    const finish = () => {
      clearTimeout(timer);
      child.off('exit', finish);
      child.off('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    child.once('exit', finish);
    child.once('close', finish);
  });
}

async function terminateWindowsTree(child, spawn, env) {
  if (hasExited(child)) return;
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  const killer = spawn(path.win32.join(systemRoot, 'System32', 'taskkill.exe'),
    ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
  await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { try { killer.kill(); } catch {} finish(); }, 1500);
    killer.once('error', finish);
    killer.once('close', finish);
  });
}

function stopProcess(child, options = {}) {
  if (!child) return Promise.resolve();
  if (stopping.has(child)) return stopping.get(child);
  const cleanup = (async () => {
    const spawn = options.spawn || childProcess.spawn;
    const platform = options.platform || ownedProcesses.get(child)?.platform || process.platform;
    const endInput = () => { try { if (!child.stdin?.destroyed) child.stdin?.end(); } catch {} };
    if (!child.pid) { endInput(); return; }
    if (platform !== 'win32') endInput();
    await waitForExit(child, options.graceMs ?? 250);
    if (hasExited(child)) { endInput(); return; }
    if (platform === 'win32') {
      try { await terminateWindowsTree(child, spawn, options.env || process.env); } catch {}
      endInput();
    } else if (ownedProcesses.get(child)?.grouped) {
      try { (options.kill || process.kill)(-child.pid, 'SIGTERM'); } catch {}
    }
    if (!hasExited(child)) {
      try { child.kill('SIGTERM'); } catch {}
      await waitForExit(child, options.killWaitMs ?? 500);
    }
    if (!hasExited(child)) {
      if (platform !== 'win32' && ownedProcesses.get(child)?.grouped) {
        try { (options.kill || process.kill)(-child.pid, 'SIGKILL'); } catch {}
      }
      try { child.kill('SIGKILL'); } catch {}
      await waitForExit(child, options.killWaitMs ?? 500);
    }
    endInput();
  })();
  stopping.set(child, cleanup);
  return cleanup;
}

module.exports = { resolveCommand, resolveNpmLauncher, spawnProvider, stopProcess };
