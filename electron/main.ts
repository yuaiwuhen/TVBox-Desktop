import {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  shell,
  clipboard,
  globalShortcut,
} from 'electron';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { registerJarLoaderIPC, jarLoader } from './JarLoader';
import { registerDockerIPC, dockerManager } from './DockerIPC';
import { QuarkPanService } from './QuarkPanService';
import { UCPanService } from './UCPanService';
import { AliyunPanService } from './AliyunPanService';
import { BaiduPanService } from './BaiduPanService';
import { Pan123Service } from './Pan123Service';
import { Pan139Service } from './Pan139Service';
import { Pan189Service } from './Pan189Service';
import { Pan115Service } from './Pan115Service';
import { PanLoginService } from './PanLoginService';
import { proxyServer } from './ProxyServer';
import { loadConfigFromFile, saveConfigToFile } from './ConfigPersistence';

// Enable HEVC/H.265 hardware decoding in Chromium.
// On Windows, this uses Media Foundation's HEVC decoder (requires HEVC Video
// Extension from Microsoft Store, or a GPU with native HEVC decode support).
// Without this flag, Chromium falls back to software decoding which may not
// be available, causing video playback to stall on the first frame.
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

// Enable remote debugging for CDP (Chrome DevTools Protocol) access.
// Used by test scripts to inspect renderer state (HEVC support, playback).
// Port can be overridden via command line: --remote-debugging-port=XXXX
if (!process.argv.some((arg) => arg.startsWith('--remote-debugging-port'))) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.DIST = path.join(__dirname, '../dist');
process.env.VITE_PUBLIC = app.isPackaged
  ? process.env.DIST
  : path.join(process.env.DIST, '../public');

let win: BrowserWindow;

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];

// Diagnostic: ring buffer for main-process console output so the renderer
// (and E2E tests) can inspect what JarLoader logs during spider calls.
// Used to diagnose why detailContent returns empty {} for some spiders.
const LOG_BUFFER_SIZE = 2000;
const logBuffer: string[] = [];
let logCaptureEnabled = false;
const origConsoleLog = console.log;
const origConsoleError = console.error;
function pushLog(level: string, args: any[]) {
  if (!logCaptureEnabled) return;
  const ts = new Date().toISOString().substr(11, 12);
  // Be defensive: Java objects returned by java-bridge can throw on
  // JSON.stringify (cyclic refs, missing toJSON). Don't let a single bad
  // arg silence the rest of the log line — fall back to String().
  const parts = args.map((a) => {
    if (typeof a === 'string') return a;
    if (a === null) return 'null';
    if (a === undefined) return 'undefined';
    try {
      return JSON.stringify(a);
    } catch {
      try {
        return String(a);
      } catch {
        return '<unprintable>';
      }
    }
  });
  logBuffer.push(`[${ts}] [${level}] ${parts.join(' ')}`);
  while (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}
console.log = (...args: any[]) => {
  origConsoleLog(...args);
  pushLog('log', args);
};
console.warn = (...args: any[]) => {
  (console as any).origConsoleWarn
    ? (console as any).origConsoleWarn(...args)
    : origConsoleLog(...args);
  pushLog('warn', args);
};
console.error = (...args: any[]) => {
  origConsoleError(...args);
  pushLog('error', args);
};
ipcMain.handle('debug:startLogCapture', () => {
  logBuffer.length = 0;
  logCaptureEnabled = true;
  return true;
});
ipcMain.handle('debug:getLogs', () => {
  return logBuffer.join('\n');
});
ipcMain.handle('debug:stopLogCapture', () => {
  logCaptureEnabled = false;
  const logs = logBuffer.join('\n');
  logBuffer.length = 0;
  return logs;
});

// Check whether the Visual C++ Redistributable 2015+ runtime is installed.
// java-bridge's native nodejar.node links against vcruntime140.dll. Without
// it, requiring java-bridge throws "The specified module could not be found"
// which is hard to debug from the user's perspective. Show a friendly error
// instead and link to the official Microsoft download.
function isVcredistInstalled(): boolean {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  // vcruntime140.dll lives in System32 on 64-bit Windows. We check both
  // System32 (x64) and SysWOW64 (x86) to be safe.
  const targets = [
    path.join(sysRoot, 'System32', 'vcruntime140.dll'),
    path.join(sysRoot, 'SysWOW64', 'vcruntime140.dll'),
  ];
  return targets.some((p) => fs.existsSync(p));
}

// Check Docker environment on startup - Enhanced version with auto-deploy
async function checkDockerEnvironment(): Promise<void> {
  try {
    console.log('[Main] Checking Docker environment...');

    // Import DockerManager
    const DockerIPC = await import('./DockerIPC');
    const dockerManager = DockerIPC.dockerManager;

    // Check if Docker is installed and running
    const status = await dockerManager.checkDockerRunning();

    if (!status.installed) {
      console.log('[Main] Docker not installed');
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('docker:status', {
          installed: false,
          running: false,
          message: 'Docker未安装，请先安装Docker Desktop',
        });
      }
      return;
    }

    if (!status.running) {
      console.log('[Main] Docker installed but not running');
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('docker:status', {
          installed: true,
          running: false,
          message: 'Docker已安装但未运行，正在尝试启动...',
        });
      }

      // Try to start Docker service
      try {
        await dockerManager.startDockerService();
        console.log('[Main] Docker service started successfully');
      } catch (error: any) {
        console.error('[Main] Failed to start Docker service:', error);
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.webContents.send('docker:status', {
            installed: true,
            running: false,
            error: error.message,
            message: 'Docker服务启动失败，请手动启动Docker Desktop',
          });
        }
        return;
      }
    }

    console.log('[Main] Docker is running, version:', status.version);

    // Notify renderer that Docker is ready
    let win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send('docker:status', {
        installed: true,
        running: true,
        message: 'Docker运行正常，正在准备Spider服务...',
      });
    }

    // Check and pull/build Docker image
    try {
      const imageExists = await dockerManager.imageExists();
      if (!imageExists) {
        console.log('[Main] Spider image not found, pulling/building...');

        win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.webContents.send('docker:status', {
            installed: true,
            running: true,
            pullingImage: true,
            message: '正在下载Spider服务镜像，首次运行需要几分钟...',
          });
        }

        // Try to build image using docker-compose
        const { promisify } = await import('util');
        const { exec: execCallback } = await import('child_process');
        const exec = promisify(execCallback);

        try {
          const projectRoot = path.resolve(__dirname, '..');
          await exec('pnpm docker:build', {
            cwd: projectRoot,
            timeout: 600000, // 10分钟超时
          });
          console.log('[Main] Spider image built successfully');
        } catch (buildError: any) {
          console.error('[Main] Failed to build image:', buildError);
          throw new Error(`镜像构建失败: ${buildError.message}`);
        }
      } else {
        console.log('[Main] Spider image already exists');
      }
    } catch (error: any) {
      console.error('[Main] Failed to prepare Docker image:', error);
      win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('docker:status', {
          installed: true,
          running: true,
          error: error.message,
          message: 'Spider镜像准备失败: ' + error.message,
        });
      }
      return;
    }

    // Check if Spider container is running
    const containerStatus = await dockerManager.getContainerStatus();
    if (!containerStatus.running) {
      console.log('[Main] Spider container not running, starting...');

      win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('docker:status', {
          installed: true,
          running: true,
          startingContainer: true,
          message: '正在启动Spider服务容器...',
        });
      }

      // Try to start the container
      try {
        await dockerManager.startContainer();
        console.log('[Main] Spider container started successfully');
      } catch (error: any) {
        console.error('[Main] Failed to start Spider container:', error);
        win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.webContents.send('docker:status', {
            installed: true,
            running: true,
            containerRunning: false,
            error: error.message,
            message: 'Spider容器启动失败: ' + error.message,
          });
        }
        return;
      }
    } else {
      console.log('[Main] Spider container is running');
    }

    // Wait for Spider service to be ready
    console.log('[Main] Waiting for Spider service to be ready...');
    win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send('docker:status', {
        installed: true,
        running: true,
        containerRunning: true,
        initializing: true,
        message: 'Spider容器已启动，等待服务就绪...',
      });
    }

    // Check service health
    try {
      const axios = (await import('axios')).default;
      let retries = 0;
      const maxRetries = 30; // 30次，每次2秒，总共60秒

      while (retries < maxRetries) {
        try {
          const response = await axios.get('http://localhost:9978/health', {
            timeout: 3000,
          });

          if (response.data && response.data.success) {
            console.log('[Main] Spider service is ready');

            win = BrowserWindow.getAllWindows()[0];
            if (win) {
              win.webContents.send('docker:status', {
                installed: true,
                running: true,
                containerRunning: true,
                serviceReady: true,
                message: 'Spider服务已就绪，可以正常使用',
              });
            }
            return;
          }
        } catch {
          // Service not ready yet, retry
          retries++;
          if (retries < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      }

      // If we get here, service didn't become ready
      throw new Error('服务启动超时。可能需要手动安装Spider APK');
    } catch (error: any) {
      console.error('[Main] Spider service not ready:', error);
      win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('docker:status', {
          installed: true,
          running: true,
          containerRunning: true,
          serviceReady: false,
          error: error.message,
          message: 'Spider服务未就绪: ' + error.message,
        });
      }
    }
  } catch (error: any) {
    console.error('[Main] Docker check failed:', error);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send('docker:status', {
        error: error.message,
        message: 'Docker环境检查失败: ' + error.message,
      });
    }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
    },
    show: false,
    menu: null,
  });

  win.once('ready-to-show', () => {
    win?.show();
  });

  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString());
  });

  // Register DevTools shortcut (F12)
  const registered = globalShortcut.register('F12', () => {
    if (win) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });
  if (!registered) {
    console.error('[Main] Failed to register F12 shortcut');
  } else {
    console.log('[Main] F12 shortcut registered successfully');
  }

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(process.env.DIST, 'index.html'));
  }

  // Auto-open DevTools on startup (both dev and production)
  win.webContents.openDevTools({ mode: 'detach' });

  // Video header injection + anti-leech interceptor.
  // Some Guard spiders (WexGuaZi) return direct video URLs (https://...) with
  // custom headers (User-Agent, Referer) that the browser cannot set:
  //   - User-Agent is a forbidden header in fetch/XHR
  //   - Referer is controlled by the browser
  // jarLoader registers these headers by URL origin; we inject them here so
  // the CDN receives the headers it expects. This covers both the m3u8
  // manifest and the TS segments inside it (same origin).
  //
  // We also strip browser-specific headers (Sec-Fetch-*, Sec-Ch-Ua, etc.)
  // because CDNs use them to detect third-party access ("请勿使用第三方程序"
  // error). A real Lavf/57.83.100 client doesn't send these.
  const filter = { urls: ['*://*/*'] };
  // Headers that reveal the request originates from a browser. CDNs check
  // these to block third-party access even when User-Agent is spoofed.
  const BROWSER_LEAK_HEADERS = [
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-fetch-user',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'sec-ch-ua-arch',
    'sec-ch-ua-bitness',
    'sec-ch-ua-full-version',
    'sec-ch-ua-full-version-list',
    'accept-language',
    'origin',
    'cache-control',
    'pragma',
    'dnt',
    'upgrade-insecure-requests',
  ];
  win.webContents.session.webRequest.onBeforeSendHeaders(
    filter,
    (details, callback) => {
      const { requestHeaders } = details;
      const videoHeaders = jarLoader.getVideoHeadersForUrl(details.url);
      if (videoHeaders) {
        // Inject spider-provided headers (User-Agent, Referer, etc.)
        for (const [hk, hv] of Object.entries(videoHeaders)) {
          requestHeaders[hk] = hv;
        }
        // Strip browser-specific headers that betray a browser origin.
        // CDN anti-leech checks look for Sec-Fetch-* and Sec-Ch-Ua headers
        // — a real native client (Lavf/57.83.100) never sends them.
        for (const h of BROWSER_LEAK_HEADERS) {
          delete requestHeaders[h];
          // Also handle case-sensitive variants
          delete requestHeaders[h.charAt(0).toUpperCase() + h.slice(1)];
        }
        console.log(
          '[webRequest] Injected video headers for',
          details.url.substring(0, 80),
          '— keys:',
          Object.keys(requestHeaders).join(','),
        );
      } else if (details.url.includes('.m3u8') || details.url.includes('.ts')) {
        // No custom headers registered — apply default anti-leech bypass
        delete requestHeaders['Referer'];
      }
      callback({ requestHeaders });
    },
  );

  // CORS bypass for direct video URLs. CDNs often don't send
  // Access-Control-Allow-Origin, which makes hls.js fail to fetch the
  // m3u8/TS segments. Add permissive CORS headers to the response.
  win.webContents.session.webRequest.onHeadersReceived(
    filter,
    (details, callback) => {
      const videoHeaders = jarLoader.getVideoHeadersForUrl(details.url);
      if (videoHeaders) {
        const responseHeaders = { ...details.responseHeaders };
        responseHeaders['access-control-allow-origin'] = ['*'];
        responseHeaders['access-control-allow-headers'] = ['*'];
        responseHeaders['access-control-allow-methods'] = [
          'GET, HEAD, OPTIONS',
        ];
        callback({ responseHeaders });
        return;
      }
      callback({});
    },
  );

  // Open external links in default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Window control IPC handlers
ipcMain.handle('window-toggle-maximize', () => {
  if (win) {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  }
});

ipcMain.handle('window-is-maximized', () => {
  return win ? win.isMaximized() : false;
});

// Config persistence IPC handlers
ipcMain.handle('config:load', () => {
  return loadConfigFromFile();
});

ipcMain.handle('config:save', (_event, data: Record<string, string>) => {
  return saveConfigToFile(data);
});

// Fetch remote TVBox config with okhttp User-Agent.
// Many config endpoints (菜妮丝, 欧歌, etc.) only return JSON when the request
// looks like it comes from the Android TVBox app (okhttp/4.9.3). Browsers
// silently strip User-Agent from fetch/XHR, so this must run in the main
// process. Returns { ok, status, contentType, bodyBase64, error? }.
ipcMain.handle(
  'config:fetchRemote',
  async (
    _event,
    url: string,
  ): Promise<{
    ok: boolean;
    status: number;
    contentType: string;
    bodyBase64: string;
    error?: string;
  }> => {
    return new Promise((resolve) => {
      const fetchWithRedirect = (u: string, depth = 0) => {
        if (depth > 5) {
          resolve({
            ok: false,
            status: 0,
            contentType: '',
            bodyBase64: '',
            error: 'too many redirects',
          });
          return;
        }
        let urlObj: URL;
        try {
          urlObj = new URL(u);
        } catch (e: any) {
          resolve({
            ok: false,
            status: 0,
            contentType: '',
            bodyBase64: '',
            error: `invalid URL: ${e.message}`,
          });
          return;
        }
        const lib = urlObj.protocol === 'https:' ? https : http;
        const req = lib.request(
          {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
              'User-Agent': 'okhttp/4.9.3',
              Accept: '*/*',
            },
          },
          (res: any) => {
            const status = res.statusCode || 0;
            // Follow 3xx redirects
            if (status >= 300 && status < 400 && res.headers.location) {
              const next = new URL(res.headers.location, u).toString();
              res.resume();
              fetchWithRedirect(next, depth + 1);
              return;
            }
            const contentType = res.headers['content-type'] || '';
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const buf = Buffer.concat(chunks);
              resolve({
                ok: status === 200,
                status,
                contentType,
                bodyBase64: buf.toString('base64'),
              });
            });
            res.on('error', (e: Error) => {
              resolve({
                ok: false,
                status: 0,
                contentType: '',
                bodyBase64: '',
                error: e.message,
              });
            });
          },
        );
        req.on('error', (e: Error) => {
          resolve({
            ok: false,
            status: 0,
            contentType: '',
            bodyBase64: '',
            error: e.message,
          });
        });
        req.setTimeout(30000, () => {
          req.destroy();
          resolve({
            ok: false,
            status: 0,
            contentType: '',
            bodyBase64: '',
            error: 'timeout',
          });
        });
        req.end();
      };
      fetchWithRedirect(url);
    });
  },
);

// Check video format before opening player.
// Sends a GET (Range bytes=0-65535) so we can sniff magic + Content-Type.
// Returns: { status, contentType, unsupported, format?, directUrl?, invalid?, error? }
ipcMain.handle(
  'check-video-format',
  async (_event, videoUrl: string, headerObj?: Record<string, string>) => {
    return new Promise((resolve) => {
      const urlObj = new URL(videoUrl);
      const lib = urlObj.protocol === 'https:' ? https : http;

      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Range: 'bytes=0-65535',
        ...headerObj,
      };

      const req = lib.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          headers,
        },
        (res: any) => {
          const status = res.statusCode || 0;
          const contentType = res.headers['content-type'] || '';

          // For 415, ProxyServer returns JSON with directUrl
          if (status === 415) {
            let body = '';
            res.on('data', (chunk: Buffer) => (body += chunk.toString()));
            res.on('end', () => {
              try {
                const json = JSON.parse(body);
                resolve({
                  status,
                  contentType: json.format || contentType,
                  unsupported: true,
                  format: json.format,
                  directUrl: json.directUrl || videoUrl,
                  message: json.message,
                });
              } catch {
                resolve({
                  status,
                  contentType,
                  unsupported: true,
                  directUrl: videoUrl,
                });
              }
            });
            return;
          }

          // For 4xx/5xx errors, resource may be invalid
          if (status >= 400) {
            res.resume();
            resolve({
              status,
              contentType,
              invalid: true,
            });
            return;
          }

          // Peek body for magic-byte sniff (MKV EBML, FLV, AVI, ftyp/qt)
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            if (total < 65536) {
              chunks.push(chunk);
              total += chunk.length;
            }
          });
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const ct = contentType.toLowerCase();
            let format: string | null = null;

            if (
              /matroska|x-matroska|\bmkv\b/.test(ct) ||
              (buf.length >= 4 &&
                buf[0] === 0x1a &&
                buf[1] === 0x45 &&
                buf[2] === 0xdf &&
                buf[3] === 0xa3 &&
                !buf.toString('ascii').includes('webm'))
            ) {
              format = 'mkv';
            } else if (
              /x-msvideo|\bavi\b/.test(ct) ||
              (buf.length >= 11 &&
                buf.toString('ascii', 0, 4) === 'RIFF' &&
                buf.toString('ascii', 8, 11) === 'AVI')
            ) {
              format = 'avi';
            } else if (
              /x-flv|\bflv\b/.test(ct) ||
              (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'FLV')
            ) {
              format = 'flv';
            } else if (/x-ms-wmv|\bwmv\b/.test(ct)) {
              format = 'wmv';
            } else if (
              /quicktime/.test(ct) ||
              (buf.length >= 12 &&
                buf.toString('ascii', 4, 8) === 'ftyp' &&
                buf.toString('ascii', 8, 12).startsWith('qt'))
            ) {
              format = 'mov';
            }

            resolve({
              status,
              contentType,
              unsupported: !!format,
              format: format || undefined,
              directUrl: videoUrl,
            });
          });
        },
      );

      req.on('error', (e: Error) => {
        resolve({ status: 0, contentType: '', error: e.message });
      });

      req.setTimeout(15000, () => {
        req.destroy();
        resolve({ status: 0, contentType: '', error: 'timeout' });
      });

      req.end();
    });
  },
);

// Open video with external player (VLC, etc.)
ipcMain.handle(
  'open-external-player',
  async (_event, playerPath: string, videoUrl: string) => {
    try {
      const player = spawn(playerPath, [videoUrl], {
        detached: true,
        stdio: 'ignore',
      });
      player.unref();
      console.log('[Main] External player launched:', playerPath, videoUrl);
      return { success: true };
    } catch (e: any) {
      console.error('[Main] Failed to launch external player:', e);
      return { success: false, error: e.message };
    }
  },
);

// Show unsupported format dialog — sends event to renderer for modern UI
ipcMain.handle(
  'show-unsupported-format-dialog',
  async (
    _event,
    data: {
      format: string;
      directUrl: string;
      hasVlcPath: boolean;
      vlcPath?: string;
    },
  ) => {
    try {
      const vlcPath = data.vlcPath || '';
      win?.webContents?.send('show-format-dialog', {
        format: data.format,
        directUrl: data.directUrl,
        hasVlc: !!vlcPath,
        vlcPath,
      });
      return { handled: true };
    } catch (e: any) {
      console.error('[Main] Failed to send format dialog event:', e);
      return { handled: false, error: e.message };
    }
  },
);

// File picker dialog
ipcMain.handle('dialog:openFile', async (_event, options: any) => {
  return dialog.showOpenDialog({
    title: options?.title || '选择文件',
    filters: options?.filters || [],
    properties: ['openFile'],
  });
});

// Fetch HTML content for XBPQ spiders
ipcMain.handle(
  'http:fetchHtml',
  async (
    _event,
    {
      url,
      headers,
      timeout,
    }: { url: string; headers: Record<string, string>; timeout?: number },
  ) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout || 30000);

      const response = await fetch(url, {
        headers,
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const html = await response.text();
      return { success: true, data: html };
    } catch (e: any) {
      return { success: false, error: e.message || 'Unknown error' };
    }
  },
);

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') {
    app.quit();
    win = null;
  }
});

app.whenReady().then(async () => {
  // VC++ Redistributable check — only on Windows. java-bridge's native
  // nodejar.node links against vcruntime140.dll on Windows. Linux/Mac
  // don't need this (they use system libc/libobjc instead).
  if (process.platform === 'win32' && !isVcredistInstalled()) {
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: '缺少 Visual C++ Redistributable',
      message: 'TVBox-PC 缺少运行时依赖',
      detail:
        'TVBox-PC 需要 Visual C++ Redistributable 2015+ 才能运行 Java spider。\n\n' +
        '请前往微软官网下载安装：\n' +
        'https://aka.ms/vs/17/release/vc_redist.x64.exe\n\n' +
        '安装完成后重新启动 TVBox-PC。',
      buttons: ['打开下载页面', '退出'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) {
      shell.openExternal('https://aka.ms/vs/17/release/vc_redist.x64.exe');
    }
    app.quit();
    return;
  }

  Menu.setApplicationMenu(null);

  // DoH (DNS over HTTPS) - prevents ISP DNS hijacking
  app.configureHostResolver({
    enableBuiltInResolver: true,
    secureDnsMode: 'secure',
    secureDnsServers: [
      'https://doh.pub/dns-query',
      'https://dns.alidns.com/dns-query',
    ],
  });

  // Register JarLoader IPC handlers
  registerJarLoaderIPC();

  // Register Docker IPC handlers
  registerDockerIPC();

  // Check Docker environment on startup
  checkDockerEnvironment();

  QuarkPanService.init();
  UCPanService.init();
  AliyunPanService.init();
  BaiduPanService.init();
  Pan123Service.init();
  Pan139Service.init();
  Pan189Service.init();
  Pan115Service.init();
  PanLoginService.init();

  // Start local proxy server BEFORE any spider calls.
  // The spider's Proxy.a() probes ports 9978-9999 with `GET /proxy?do=ck`
  // expecting "ok"; if the server is not up, playerContent returns URLs with
  // port -1 and the video stream cannot be played.
  try {
    const port = await proxyServer.start();
    console.log(`[Main] ProxyServer started on port ${port}`);
  } catch (e: any) {
    console.error('[Main] ProxyServer failed to start:', e.message);
  }

  createWindow();
});
