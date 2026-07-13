import sharp from 'sharp';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const svgPath = path.join(projectRoot, 'public', 'favicon.svg');
const outDir = path.join(projectRoot, 'build');
const pngPath = path.join(outDir, 'icon.png');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

await sharp(svgPath)
  .resize(512, 512)
  .png()
  .toFile(pngPath);

const stat = fs.statSync(pngPath);
console.log(`Generated icon: ${pngPath} (${(stat.size / 1024).toFixed(1)} KB)`);
