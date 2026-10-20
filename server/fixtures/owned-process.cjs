const { spawn } = require('node:child_process');

if (process.argv.includes('--child')) {
  setInterval(() => {}, 1000);
} else {
  const descendant = spawn(process.execPath, [__filename, '--child'], {
    windowsHide: true, stdio: 'ignore'
  });
  descendant.once('spawn', () => process.stdout.write(`${JSON.stringify({ descendantPid: descendant.pid })}\n`));
  process.stdin.resume();
  process.stdin.once('end', () => process.exit(0));
  setInterval(() => {}, 1000);
}
