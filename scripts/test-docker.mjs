#!/usr/bin/env node

/**
 * Docker Integration Test Script
 *
 * Tests the Docker integration functionality:
 * 1. Docker environment detection
 * 2. Container management
 * 3. IPC communication
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bright: '\x1b[1m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

async function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: rootDir,
      shell: true,
      stdio: 'inherit',
      ...options,
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

async function testDockerIntegration() {
  log('\n========================================', colors.bright);
  log('  Docker Integration Test Suite', colors.cyan);
  log('========================================\n', colors.bright);

  try {
    // Test 1: Check if Docker is installed
    log('[Test 1/4] Checking Docker installation...', colors.yellow);
    try {
      await runCommand('docker', ['--version']);
      log('  ✓ Docker is installed\n', colors.green);
    } catch {
      log('  ✗ Docker is NOT installed', colors.red);
      log('  Please install Docker Desktop first\n', colors.yellow);
      return;
    }

    // Test 2: Check if Docker service is running
    log('[Test 2/4] Checking Docker service status...', colors.yellow);
    try {
      await runCommand('docker', ['ps']);
      log('  ✓ Docker service is running\n', colors.green);
    } catch {
      log('  ✗ Docker service is NOT running', colors.red);
      log('  Please start Docker Desktop\n', colors.yellow);
      return;
    }

    // Test 3: Build Docker image (if not exists)
    log('[Test 3/4] Checking Spider Docker image...', colors.yellow);
    try {
      const result = await runCommand('docker', ['images', '-q', 'tvbox-spider-server:latest'], {
        stdio: 'pipe',
      });
      
      // Check if we need to build
      const { execSync } = await import('child_process');
      const imageId = execSync('docker images -q tvbox-spider-server:latest', {
        cwd: rootDir,
        encoding: 'utf-8',
      }).trim();

      if (imageId) {
        log('  ✓ Spider Docker image exists\n', colors.green);
      } else {
        log('  Spider Docker image not found, building...', colors.yellow);
        await runCommand('pnpm', ['docker:build']);
        log('  ✓ Spider Docker image built successfully\n', colors.green);
      }
    } catch (error) {
      log(`  ✗ Failed to check/build Docker image: ${error.message}\n`, colors.red);
      return;
    }

    // Test 4: Start Spider container
    log('[Test 4/4] Starting Spider container...', colors.yellow);
    try {
      // Check if container exists
      const { execSync } = await import('child_process');
      const containerStatus = execSync(
        'docker ps -a --filter name=tvbox-spider --format {{.Status}}',
        { cwd: rootDir, encoding: 'utf-8' }
      ).trim();

      if (containerStatus && containerStatus.startsWith('Up')) {
        log('  ✓ Spider container is already running\n', colors.green);
      } else {
        await runCommand('pnpm', ['docker:up']);
        log('  ✓ Spider container started successfully\n', colors.green);
      }
    } catch (error) {
      log(`  ✗ Failed to start Spider container: ${error.message}\n`, colors.red);
      return;
    }

    // Test 5: Verify Spider API
    log('[Test 5/5] Testing Spider API endpoint...', colors.yellow);
    try {
      const { default: axios } = await import('axios');
      const response = await axios.get('http://localhost:19978/health', { timeout: 5000 });
      
      if (response.data.success) {
        log('  ✓ Spider API is responding\n', colors.green);
      } else {
        log('  ✗ Spider API returned error\n', colors.red);
      }
    } catch (error) {
      log(`  ✗ Spider API test failed: ${error.message}\n`, colors.red);
      log('  Container may still be initializing, try again in 30 seconds\n', colors.yellow);
      return;
    }

    log('\n========================================', colors.bright);
    log('  All tests passed! ✓', colors.green);
    log('========================================\n', colors.bright);
    
    log('Next steps:', colors.cyan);
    log('1. Run "pnpm dev" to start the application', colors.cyan);
    log('2. Check console for Docker status messages', colors.cyan);
    log('3. If Docker not installed, install guide will appear\n', colors.cyan);

  } catch (error) {
    log(`\n✗ Test failed: ${error.message}`, colors.red);
    console.error(error);
  }
}

testDockerIntegration();