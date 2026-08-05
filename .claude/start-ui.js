const path = require('path');
const { spawn } = require('child_process');

const uiDir = path.join(__dirname, '..', 'ui');
const viteJs = path.join(__dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js');

const child = spawn(process.execPath, [viteJs, '--host'], {
  cwd: uiDir,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code || 0));
process.on('SIGTERM', () => child.kill());
process.on('SIGINT', () => child.kill());
