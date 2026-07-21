#!/usr/bin/env node

/**
 * Development server starter script
 *
 * Starts Vite + vite-plugin-electron, waits for dist-electron/main.js to be built,
 * then launches Electron.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const mainEntry = path.join(rootDir, 'dist-electron', 'main.js');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function waitForFile(filePath, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      if (fs.existsSync(filePath)) {
        return resolve();
      }
      if (Date.now() - startTime > timeoutMs) {
        return reject(new Error(`Timeout waiting for ${filePath}`));
      }
      setTimeout(check, 500);
    };
    check();
  });
}

async function startDev() {
  log('\n========================================', colors.bright);
  log('  Starting TVBox-PC Development Server', colors.cyan);
  log('========================================\n', colors.bright);

  // Clean previous build to ensure fresh build
  const distElectronDir = path.join(rootDir, 'dist-electron');
  if (fs.existsSync(distElectronDir)) {
    log('Cleaning previous build...', colors.yellow);
    try {
      fs.rmSync(distElectronDir, { recursive: true, force: true });
    } catch (e) {
      // ignore
    }
  }

  // Start Vite (which will build electron main/preload via vite-plugin-electron)
  log('[1/2] Starting Vite + Electron build...', colors.yellow);
  const viteProcess = spawn('pnpm', ['exec', 'vite'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true,
  });

  // Wait for dist-electron/main.js to be built
  try {
    await waitForFile(mainEntry, 120000);
    log('  ✓ Electron main.js built successfully', colors.green);
  } catch (err) {
    log(`\n✗ Build failed: ${err.message}`, colors.red);
    viteProcess.kill();
    process.exit(1);
  }

  log('\n✓ Development server is running!', colors.green);
  log('  - Vite: http://localhost:5173', colors.cyan);
  log('  - Electron app will open automatically via vite-plugin-electron\n', colors.cyan);
  
  // vite-plugin-electron will automatically start Electron when Vite is ready
  // No need to spawn it manually
}

process.on('SIGINT', () => {
  log('\n\nShutting down...', colors.yellow);
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('\n\nShutting down...', colors.yellow);
  process.exit(0);
});

startDev().catch((error) => {
  log(`\n✗ Failed: ${error.message}`, colors.red);
  console.error(error);
  process.exit(1);
});
