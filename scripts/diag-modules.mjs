// 逐个 import 主进程实际用到的模块，定位哪个在 Electron(Node 20.18.3) 的
// ESM loader 里触发 cjsPreparseModuleExports 崩溃。
const targets = [
  'electron',
  'path',
  'https',
  'http',
  'child_process',
  'url',
  'util',
  'fs',
  'stream',
  'crypto',
  'net',
  'tls',
  'assert',
  'tty',
  'os',
  'events',
  'http2',
  'zlib',
];

const lines = [];
for (const t of targets) {
  lines.push(`try-import ${t}`);
  try {
    await import(t);
    lines.push(`  OK ${t}`);
  } catch (e) {
    lines.push(`  FAIL ${t}: ${e && e.message}`);
  }
}
lines.push('--- named resolve from path ---');
try {
  const p = await import('path');
  lines.push('  path.resolve = ' + typeof p.resolve);
} catch (e) {
  lines.push('  path named FAIL: ' + e.message);
}
console.log(lines.join('\n'));
