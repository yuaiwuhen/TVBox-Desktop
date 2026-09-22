import { spawn } from 'child_process';
import fs from 'fs';

const entry = process.argv[2] || 'dist-electron\\main.js';
const child = spawn(
  'D:\\Code\\TVBox-Pc-Docker\\node_modules\\electron\\dist\\electron.exe',
  [entry],
  { cwd: 'D:\\Code\\TVBox-Pc-Docker', env: { ...process.env } },
);

let out = '';
let err = '';
child.stdout.on('data', (d) => {
  out += d.toString();
});
child.stderr.on('data', (d) => {
  err += d.toString();
});
child.on('exit', (code, signal) => {
  fs.writeFileSync(
    'D:\\Code\\TVBox-Pc-Docker\\diag.txt',
    `entry=${entry}\nexit code=${code} signal=${signal}\n===== STDOUT =====\n${out}\n===== STDERR =====\n${err}\n`,
    'utf8',
  );
});

setTimeout(() => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}, 15000);
