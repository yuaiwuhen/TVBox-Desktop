import fs from 'fs';

const asar =
  'D:\\Code\\TVBox-Pc-Docker\\node_modules\\electron\\dist\\resources\\electron.asar';
const fd = fs.openSync(asar, 'r');
const sizeBuf = Buffer.alloc(8);
fs.readSync(fd, sizeBuf, 0, 8, 0);
const headerSize = sizeBuf.readUInt32LE(4);
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 8);
fs.closeSync(fd);
const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''));

const names = [];
function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name;
    if (val.files) walk(val, p);
    else names.push(p);
  }
}
walk(header, '');

const out = [];
out.push('total entries: ' + names.length);
out.push('--- entries matching electron/exports ---');
names.filter((n) => /exports|api\/electron|browser\/init/.test(n)).forEach((n) =>
  out.push('  ' + n),
);
out.push('--- top 40 ---');
names.slice(0, 40).forEach((n) => out.push('  ' + n));
fs.writeFileSync('D:\\Code\\TVBox-Pc-Docker\\diag.txt', out.join('\n'), 'utf8');
