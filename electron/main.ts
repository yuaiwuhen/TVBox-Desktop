import { app, BrowserWindow, Menu, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { registerJarLoaderIPC, jarLoader } from './JarLoader';
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

// Enable HEVC/H.265 hardware decoding in Chromium.
// On Windows, this uses Media Foundation's HEVC decoder (requires HEVC Video
// Extension from Microsoft Store, or a GPU with native HEVC decode support).
// Without this flag, Chromium falls back to software decoding which may not
// be available, causing video playback to stall on the first frame.
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

// Enable remote debugging for CDP (Chrome DevTools Protocol) access.
// Used by test scripts to inspect renderer state (HEVC support, playback).
app.commandLine.appendSwitch('remote-debugging-port', '9222');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.DIST = path.join(__dirname, '../dist');
process.env.VITE_PUBLIC = app.isPackaged
  ? process.env.DIST
  : path.join(process.env.DIST, '../public');

let win: BrowserWindow;

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];

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

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(process.env.DIST, 'index.html'));
  }

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

app.on('window-all-closed', () => {
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
