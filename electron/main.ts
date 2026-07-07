import { app, BrowserWindow, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerJarLoaderIPC } from './JarLoader';
import { QuarkPanService } from './QuarkPanService';
import { UCPanService } from './UCPanService';
import { AliyunPanService } from './AliyunPanService';
import { BaiduPanService } from './BaiduPanService';
import { PanLoginService } from './PanLoginService';
import { proxyServer } from './ProxyServer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.DIST = path.join(__dirname, '../dist');
process.env.VITE_PUBLIC = app.isPackaged
  ? process.env.DIST
  : path.join(process.env.DIST, '../public');

let win: BrowserWindow | null;

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];

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

  // Anti-leech header interceptor
  const filter = { urls: ['*://*/*'] };
  win.webContents.session.webRequest.onBeforeSendHeaders(
    filter,
    (details, callback) => {
      const { requestHeaders } = details;
      if (details.url.includes('.m3u8') || details.url.includes('.ts')) {
        // Referer stripping for anti-leech bypass
        delete requestHeaders['Referer'];
      }
      callback({ requestHeaders });
    },
  );

  // hevc.js不需要SharedArrayBuffer和COOP/COEP headers（单线程解码）
  // 移除headers拦截器配置，简化部署

  // Open external links in default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
    win = null;
  }
});

app.whenReady().then(async () => {
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
