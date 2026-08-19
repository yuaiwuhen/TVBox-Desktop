import axios from 'axios';
import { spiderEngine } from './SpiderEngine';
import { JsSpider } from './JsSpider';
import { M3u8Purifier } from './M3u8Purifier';
import type { IncomingMessage, ServerResponse, Server } from 'http';

// Node.js builtins via require (Vite doesn't bundle these).
// Use dynamic property access on globalThis so Vite's ESM transform doesn't
// statically replace `typeof require` with `false`. In Electron renderer with
// nodeIntegration:true, globalThis.require is available at runtime.
const g = globalThis as any;
const _require: NodeRequire =
  g.__non_webpack_require__ ||
  g.require ||
  (typeof window !== 'undefined' ? (window as any).require : undefined) ||
  ((m: string) => {
    throw new Error(
      `Cannot require ${m} — running in browser without nodeIntegration`,
    );
  });
const http = _require('http');
const { URL } = _require('url');
const fs = _require('fs');
const path = _require('path');
const os = _require('os');

// ─── Cache entry ─────────────────────────────────────────────────────────────

interface CacheEntry {
  value: string;
  expiresAt: number | null; // null = no expiration
}

// ─── Persistent cache ────────────────────────────────────────────────────────

class CacheStore {
  private cache = new Map<string, CacheEntry>();
  private filePath: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'proxy_cache.json');
    this.load();
  }

  get(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.markDirty();
      return null;
    }
    return entry.value;
  }

  set(key: string, value: string, ttlMs?: number): void {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    this.cache.set(key, { value, expiresAt });
    this.markDirty();
  }

  delete(key: string): boolean {
    const result = this.cache.delete(key);
    if (result) this.markDirty();
    return result;
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.save(), 5000);
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
          for (const [key, entry] of Object.entries(obj)) {
            const e = entry as CacheEntry;
            // Skip expired entries on load
            if (e.expiresAt !== null && Date.now() > e.expiresAt) continue;
            this.cache.set(key, e);
          }
        }
      }
    } catch (e) {
      console.warn('[LocalProxyServer] Failed to load cache:', e);
    }
  }

  private save(): void {
    this.saveTimer = null;
    if (!this.dirty) return;
    try {
      const obj: Record<string, CacheEntry> = {};
      for (const [key, entry] of this.cache) {
        obj[key] = entry;
      }
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj), 'utf-8');
      this.dirty = false;
    } catch (e) {
      console.error('[LocalProxyServer] Failed to save cache:', e);
    }
  }

  /** Flush cache to disk immediately. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }
}

// ─── Local proxy server ──────────────────────────────────────────────────────

export class LocalProxyServer {
  private server: Server | null = null;
  private port: number = 19980;
  private cacheStore: CacheStore | null = null;
  private dataDir: string = '';
  private dohIndex: number = 0;

  async start(): Promise<void> {
    if (this.server) return;

    // Determine data directory
    this.dataDir = path.join(os.homedir(), '.tvbox-pc');
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.cacheStore = new CacheStore(this.dataDir);

    this.server = http.createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res).catch((e: any) => {
          console.error('[LocalProxyServer] Unhandled error:', e);
          this.sendError(res, 500, 'Internal Server Error');
        });
      },
    );

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, '0.0.0.0', () => {
        console.log(
          `[LocalProxyServer] Listening on http://0.0.0.0:${this.port}`,
        );
        resolve();
      });
      this.server!.on('error', (e: any) => {
        if (e.code === 'EADDRINUSE') {
          // Try next port
          this.port++;
          this.server!.close();
          this.server!.listen(this.port, '0.0.0.0', () => {
            console.log(
              `[LocalProxyServer] Listening on http://0.0.0.0:${this.port}`,
            );
            resolve();
          });
        } else {
          reject(e);
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.cacheStore?.flush();
    return new Promise((resolve, reject) => {
      this.server!.close((err: any) => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  setDohIndex(index: number): void {
    this.dohIndex = index;
  }

  getAddress(local: boolean): string {
    if (local) return `http://127.0.0.1:${this.port}`;
    return `http://${getLocalIP()}:${this.port}`;
  }

  // ── Request routing ────────────────────────────────────────────────────

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const pathname = reqUrl.pathname;

    try {
      if (pathname === '/proxy') {
        await this.handleProxy(reqUrl, req, res);
      } else if (pathname.startsWith('/file/')) {
        await this.handleFile(pathname, res);
      } else if (pathname === '/doh') {
        await this.handleDoH(reqUrl, res);
      } else if (pathname === '/m3u8') {
        await this.handleM3u8Proxy(reqUrl, req, res);
      } else {
        this.sendError(res, 404, 'Not Found');
      }
    } catch (e) {
      console.error('[LocalProxyServer] Request error:', e);
      this.sendError(res, 500, 'Internal Server Error');
    }
  }

  // ── /proxy route ───────────────────────────────────────────────────────

  private async handleProxy(
    reqUrl: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const doAction = reqUrl.searchParams.get('do');

    switch (doAction) {
      case 'js':
        await this.handleJsProxy(reqUrl, req, res);
        break;
      case 'py':
        await this.handlePyProxy(reqUrl, req, res);
        break;
      case 'live':
        await this.handleLiveProxy(reqUrl, res);
        break;
      case 'cache':
        await this.handleCacheProxy(reqUrl, req, res);
        break;
      case 'go':
        await this.handleGoProxy(reqUrl, req, res);
        break;
      case 'danmu':
        await this.handleDanmuProxy(reqUrl, req, res);
        break;
      case 'stream':
        await this.handleStreamProxy(reqUrl, req, res);
        break;
      default:
        this.sendError(res, 400, `Unknown action: ${doAction}`);
    }
  }

  // ── /proxy?do=js ───────────────────────────────────────────────────────

  private async handleJsProxy(
    reqUrl: URL,
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const siteKey = reqUrl.searchParams.get('siteKey') || '';

    if (!siteKey) {
      this.sendError(res, 400, 'Missing siteKey parameter');
      return;
    }

    // Collect all query params as a Map for the spider
    const params = new Map<string, string>();
    for (const [key, value] of reqUrl.searchParams) {
      params.set(key, value);
    }

    // Get the JS spider from engine
    const spider = spiderEngine.getSpiderByKey(siteKey);
    if (!spider || !(spider instanceof JsSpider)) {
      this.sendError(res, 404, `Spider not found: ${siteKey}`);
      return;
    }

    try {
      // Call proxyLocal on the spider via public API
      const result = await spider.callProxyLocal(params);
      if (!result || result === '{}') {
        this.sendError(res, 404, 'No result from spider proxyLocal');
        return;
      }

      // The result could be a JSON string with content/headers or raw content
      let parsed: any;
      try {
        parsed = typeof result === 'string' ? JSON.parse(result) : result;
      } catch {
        // Not JSON — treat as raw content
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(typeof result === 'string' ? result : JSON.stringify(result));
        return;
      }

      // Spider proxyLocal returns { content, headers?, code?, type? }
      const content = parsed.content ?? parsed.body ?? '';
      const headers: Record<string, string> = parsed.headers || {};
      const statusCode = parsed.code || 200;
      const contentType =
        headers['Content-Type'] ||
        headers['content-type'] ||
        parsed.type ||
        'application/octet-stream';

      res.writeHead(statusCode, {
        'Content-Type': contentType,
        ...headers,
      });
      res.end(typeof content === 'string' ? content : JSON.stringify(content));
    } catch (e) {
      console.error('[LocalProxyServer] JS proxy error:', e);
      this.sendError(res, 500, 'JS proxy error');
    }
  }

  // ── /proxy?do=py ───────────────────────────────────────────────────────

  private async handlePyProxy(
    reqUrl: URL,
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const siteKey = reqUrl.searchParams.get('siteKey') || '';

    if (!siteKey) {
      this.sendError(res, 400, 'Missing siteKey parameter');
      return;
    }

    // Collect all query params for the spider
    const params: Record<string, string> = {};
    for (const [key, value] of reqUrl.searchParams) {
      params[key] = value;
    }

    // Get the Python spider from engine
    const spider = spiderEngine.getSpiderByKey(siteKey);
    if (!spider) {
      this.sendError(res, 404, `Spider not found: ${siteKey}`);
      return;
    }

    try {
      // PySpider has an internal rpc method for localProxy
      const pySpider = spider as any;
      if (typeof pySpider.callLocalProxy === 'function') {
        const result = await pySpider.callLocalProxy(params);
        if (typeof result === 'object' && result !== null) {
          const content = result.content || result.body || '';
          const headers = result.headers || {};
          const statusCode = result.code || 200;
          const contentType =
            headers['Content-Type'] ||
            headers['content-type'] ||
            result.type ||
            'application/octet-stream';
          res.writeHead(statusCode, {
            'Content-Type': contentType,
            ...headers,
          });
          res.end(
            typeof content === 'string' ? content : JSON.stringify(content),
          );
        } else {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(typeof result === 'string' ? result : JSON.stringify(result));
        }
      } else {
        this.sendError(res, 501, 'Python spider localProxy not implemented');
      }
    } catch (e) {
      console.error('[LocalProxyServer] Python proxy error:', e);
      this.sendError(res, 500, 'Python proxy error');
    }
  }

  // ── /proxy?do=live ─────────────────────────────────────────────────────

  private async handleLiveProxy(
    reqUrl: URL,
    res: ServerResponse,
  ): Promise<void> {
    const type = reqUrl.searchParams.get('type') || '';
    const ext = reqUrl.searchParams.get('ext') || '';

    if (!ext) {
      this.sendError(res, 400, 'Missing ext parameter');
      return;
    }

    // Decode the ext parameter from URL-safe base64
    const liveUrl = urlSafeBase64Decode(ext);
    if (!liveUrl) {
      this.sendError(res, 400, 'Invalid ext parameter');
      return;
    }

    try {
      const response = await axios.get(liveUrl, {
        headers: {
          'User-Agent': 'okhttp/4.10.0',
        },
        responseType: 'text',
        timeout: 30000,
      });

      let content =
        typeof response.data === 'string'
          ? response.data
          : String(response.data);

      // Determine content type based on the `type` parameter or URL
      let contentType = 'text/plain; charset=utf-8';
      if (type === 'm3u' || liveUrl.toLowerCase().includes('.m3u')) {
        contentType = 'application/vnd.apple.mpegurl; charset=utf-8';
      } else if (type === 'txt') {
        contentType = 'text/plain; charset=utf-8';
      } else if (liveUrl.toLowerCase().includes('.m3u8')) {
        contentType = 'application/vnd.apple.mpegurl; charset=utf-8';
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
      });
      res.end(content);
    } catch (e) {
      console.error('[LocalProxyServer] Live proxy fetch error:', e);
      this.sendError(res, 502, 'Failed to fetch live source');
    }
  }

  // ── /proxy?do=cache ────────────────────────────────────────────────────

  private async handleCacheProxy(
    reqUrl: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.cacheStore) {
      this.sendError(res, 503, 'Cache not available');
      return;
    }

    const key = reqUrl.searchParams.get('key') || '';

    if (req.method === 'GET') {
      const value = this.cacheStore.get(key);
      if (value === null) {
        this.sendError(res, 404, 'Key not found');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(value);
      }
    } else if (req.method === 'POST') {
      // Read body as the value to store
      const body = await this.readBody(req);
      const ttl = reqUrl.searchParams.get('ttl');
      const ttlMs = ttl ? parseInt(ttl, 10) : undefined;
      this.cacheStore.set(key, body, ttlMs);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OK');
    } else if (req.method === 'DELETE') {
      this.cacheStore.delete(key);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OK');
    } else {
      this.sendError(res, 405, 'Method Not Allowed');
    }
  }

  // ── /file/ route ───────────────────────────────────────────────────────

  private async handleFile(
    pathname: string,
    res: ServerResponse,
  ): Promise<void> {
    // /file/path/to/file → serve from dataDir
    const relativePath = pathname.replace(/^\/file\//, '');
    if (!relativePath) {
      this.sendError(res, 400, 'No file path specified');
      return;
    }

    // Prevent path traversal
    const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(this.dataDir, safePath);

    // Ensure the resolved path is still within dataDir
    if (!filePath.startsWith(this.dataDir)) {
      this.sendError(res, 403, 'Forbidden');
      return;
    }

    if (!fs.existsSync(filePath)) {
      this.sendError(res, 404, 'File not found');
      return;
    }

    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        this.sendError(res, 400, 'Path is a directory');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = getContentType(ext);

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Access-Control-Allow-Origin': '*',
      });

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    } catch (e) {
      console.error('[LocalProxyServer] File serve error:', e);
      this.sendError(res, 500, 'File read error');
    }
  }

  // ── /proxy?do=go (SuperParse redirect) ─────────────────────────────────

  private async handleGoProxy(
    reqUrl: URL,
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = reqUrl.searchParams.get('url') || '';
    if (!url) {
      this.sendError(res, 400, 'Missing url parameter');
      return;
    }

    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: url,
        },
        responseType: 'text',
        timeout: 15000,
      });

      let content =
        typeof response.data === 'string'
          ? response.data
          : String(response.data);
      const contentType =
        typeof response.headers['content-type'] === 'string'
          ? response.headers['content-type']
          : 'text/plain; charset=utf-8';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
      });
      res.end(content);
    } catch (e) {
      console.error('[LocalProxyServer] Go proxy error:', e);
      this.sendError(res, 502, 'Failed to fetch URL');
    }
  }

  // ── /proxy?do=danmu (Barrage/danmaku fetch proxy) ─────────────────────
  //
  // Fetches a barrage/danmaku feed (Bilibili XML, dandanplay JSON, etc.) and
  // returns it to the renderer. Electron runs with webSecurity off, so CORS
  // is not an issue, but this endpoint also acts as a fallback for browser
  // dev mode and lets the renderer pass a custom Referer/User-Agent for
  // anti-hotlink protection (e.g. Bilibili requires a proper Referer).

  private async handleDanmuProxy(
    reqUrl: URL,
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Primary: `url` param (VideoPlayer.loadDanmu wraps external feeds).
    // Fallback: some netdisk JARs emit `do=danmu&vodName=...&vodUrl=<play url>`
    // and expect the danmu provider to be derived from the play URL; when
    // only vodUrl is present, accept it as the target so we don't 400.
    const url =
      reqUrl.searchParams.get('url') ||
      reqUrl.searchParams.get('vodUrl') ||
      '';
    if (!url) {
      this.sendError(res, 400, 'Missing url parameter');
      return;
    }

    try {
      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      };

      // Optional referer override (some providers validate it)
      const referer = reqUrl.searchParams.get('referer');
      if (referer) {
        headers.Referer = referer;
      } else {
        try {
          headers.Referer = new URL(url).origin + '/';
        } catch {
          /* keep empty */
        }
      }

      // Use Node's http/https directly instead of axios: this code runs in the
      // Electron renderer where axios goes through XMLHttpRequest, which
      // REFUSES to set "User-Agent"/"Referer" ("Refused to set unsafe header").
      // Node's http/https lets us set them (Bilibili etc. require Referer).
      const lib = url.startsWith('https:') ? _require('https') : _require('http');
      const target = new URL(url);
      const content = await new Promise<string>((resolve, reject) => {
        const req = lib.get(
          target,
          { headers },
          (resp: any) => {
            const chunks: Buffer[] = [];
            resp.on('data', (c: Buffer) => chunks.push(c));
            resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
          },
        );
        req.on('error', reject);
        req.setTimeout(15000, () => {
          req.destroy(new Error('danmu fetch timeout'));
        });
      });

      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(content);
    } catch (e) {
      console.error('[LocalProxyServer] Danmu proxy error:', e);
      this.sendError(res, 502, 'Failed to fetch danmu URL');
    }
  }

  // ── /doh (DNS-over-HTTPS proxy) ────────────────────────────────────────

  private async handleDoH(reqUrl: URL, res: ServerResponse): Promise<void> {
    const domain = reqUrl.searchParams.get('domain') || '';
    const type = reqUrl.searchParams.get('type') || 'A';

    if (!domain) {
      this.sendError(res, 400, 'Missing domain parameter');
      return;
    }

    // Use configured DoH server from dohIndex, or accept 'server' param
    const serverParam = reqUrl.searchParams.get('server') || '';
    const dohServers = [
      'cloudflare',
      'alidns',
      'alidns',
      '360',
      'google',
      'adguard',
      'quad9',
    ];
    const dohUrls: Record<string, string> = {
      cloudflare: 'https://cloudflare-dns.com/dns-query',
      google: 'https://dns.google/dns-query',
      alidns: 'https://dns.alidns.com/dns-query',
      360: 'https://doh.360.cn/dns-query',
      adguard: 'https://dns.adguard-dns.com/dns-query',
      quad9: 'https://dns.quad9.net/dns-query',
    };
    const defaultServer = dohServers[this.dohIndex] || 'cloudflare';
    const dohUrl =
      dohUrls[serverParam] || dohUrls[defaultServer] || dohUrls.cloudflare;

    try {
      const response = await axios.get(dohUrl, {
        params: { name: domain, type },
        headers: { Accept: 'application/dns-json' },
        timeout: 5000,
      });

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(response.data));
    } catch (e) {
      console.error('[LocalProxyServer] DoH proxy error:', e);
      this.sendError(res, 502, 'DoH query failed');
    }
  }

  // ── /m3u8 (M3U8 content proxy) ────────────────────────────────────────

  private async handleM3u8Proxy(
    reqUrl: URL,
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = reqUrl.searchParams.get('url') || '';
    if (!url) {
      this.sendError(res, 400, 'Missing url parameter');
      return;
    }

    // Check if purification is requested (default: true)
    const purify = reqUrl.searchParams.get('purify') !== 'false';

    try {
      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: new URL(url).origin + '/',
      };

      // Merge custom headers from query
      const customHeaders = reqUrl.searchParams.get('headers');
      if (customHeaders) {
        try {
          Object.assign(headers, JSON.parse(atob(customHeaders)));
        } catch {
          /* ignore */
        }
      }

      if (purify) {
        // Use M3u8Purifier which fetches, purifies, and rewrites URLs
        const content = await M3u8Purifier.fetchAndPurify(url, headers);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
        });
        res.end(content);
      } else {
        // Simple proxy without purification
        const response = await axios.get(url, {
          headers,
          responseType: 'text',
          timeout: 15000,
        });

        let content =
          typeof response.data === 'string'
            ? response.data
            : String(response.data);

        // Rewrite relative URLs in m3u8 to absolute
        if (content.includes('#EXTINF') || content.includes('#EXT-X-')) {
          const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
          content = content.replace(
            /^(?!#)(?!https?:\/\/)(\S+)$/gm,
            (match: string) => baseUrl + match,
          );
        }

        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
        });
        res.end(content);
      }
    } catch (e) {
      console.error('[LocalProxyServer] M3U8 proxy error:', e);
      this.sendError(res, 502, 'Failed to fetch m3u8');
    }
  }

  // ── /proxy?do=stream (带 header 的直链流式转发) ──────────────────────────
  // 解决夸克等 CDN 直链需要 Referer/Cookie 而浏览器 <video>/hls.js 无法附加的问题。
  // 用 Node http/https 带上 jar 返回的 header 请求上游，流式转发给浏览器，
  // 并透传 Range 以支持进度条拖动；自动跟随重定向。
  private async handleStreamProxy(
    reqUrl: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const target = reqUrl.searchParams.get('url') || '';
    if (!target) {
      this.sendError(res, 400, 'Missing url parameter');
      return;
    }
    let headers: Record<string, string> = {};
    const hB64 =
      reqUrl.searchParams.get('headers') ||
      reqUrl.searchParams.get('h') ||
      '';
    if (hB64) {
      try {
        headers = JSON.parse(urlSafeBase64Decode(hB64));
      } catch (e) {
        console.error('[LocalProxyServer] stream headers decode failed:', e);
      }
    }
    if (!headers['User-Agent']) {
      headers['User-Agent'] =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    }
    // 透传浏览器 Range（视频拖动进度条）
    if (req.headers.range) headers['Range'] = req.headers.range;

    const proxyBase = `${reqUrl.origin}/proxy?do=stream`;
    await this.streamFetch(target, headers, res, 0, 5, proxyBase, hB64);
  }

  private async streamFetch(
    target: string,
    headers: Record<string, string>,
    res: ServerResponse,
    redirectCount: number,
    maxRedirects: number,
    proxyBase: string,
    headersB64: string,
  ): Promise<void> {
    if (redirectCount > maxRedirects) {
      this.sendError(res, 502, 'Too many redirects');
      return;
    }
    const parsed = new URL(target);
    const lib = parsed.protocol === 'https:' ? _require('https') : http;
    const upstreamReq = lib.request(
      parsed,
      { headers, method: 'GET' },
      (upRes: any) => {
        const status = upRes.statusCode || 200;
        // 跟随重定向：保留 header（Referer/Cookie）与 Range
        if (status >= 300 && status < 400 && upRes.headers.location) {
          upRes.resume();
          const next = new URL(upRes.headers.location, target).toString();
          this.streamFetch(next, headers, res, redirectCount + 1, maxRedirects, proxyBase, headersB64);
          return;
        }
        const ct = String(upRes.headers['content-type'] || '');
        // 上游返回 m3u8 播放列表（夸克预览的转码流）：读取全文，
        // 把所有分片/子列表 URL 重写为本代理 do=stream 端点（继续带 header），
        // 这样 hls.js 在浏览器里请求分片也能带上 Referer/Cookie。
        if (/mpegurl|m3u8/i.test(ct) || /\.m3u8([?#]|$)/i.test(target)) {
          const chunks: Buffer[] = [];
          upRes.on('data', (c: Buffer) => chunks.push(c));
          upRes.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            const rewritten = text
              .split('\n')
              .map((line) => {
                const l = line.trim();
                if (!l || l.startsWith('#')) return line;
                const abs = /^https?:\/\//i.test(l)
                  ? l
                  : new URL(l, target).toString();
                return `${proxyBase}&url=${encodeURIComponent(
                  abs,
                )}&headers=${encodeURIComponent(headersB64)}`;
              })
              .join('\n');
            res.writeHead(200, {
              'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(rewritten);
          });
          upRes.on('error', (e: Error) => res.destroy());
          return;
        }
        // 普通视频流：原样透传（含 Range 206）
        res.writeHead(status, {
          'Content-Type': ct || 'application/octet-stream',
          'Content-Length': upRes.headers['content-length'] || undefined,
          'Accept-Ranges': upRes.headers['accept-ranges'] || 'bytes',
          'Content-Range': upRes.headers['content-range'] || undefined,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Range',
        });
        upRes.pipe(res);
      },
    );
    upstreamReq.on('error', (e: Error) => {
      console.error('[LocalProxyServer] stream proxy error:', e);
      if (!res.headersSent) this.sendError(res, 502, 'Stream proxy failed');
      else res.destroy();
    });
    upstreamReq.setTimeout(20000, () => {
      upstreamReq.destroy(new Error('stream proxy timeout'));
    });
    upstreamReq.end();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private sendError(res: ServerResponse, code: number, message: string): void {
    res.writeHead(code, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(message);
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }
}

// ─── URL-safe Base64 decode ──────────────────────────────────────────────────

function urlSafeBase64Decode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad === 2) base64 += '==';
  else if (pad === 3) base64 += '=';
  return Buffer.from(base64, 'base64').toString('utf-8');
}

// ─── Get local IP address ────────────────────────────────────────────────────

function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const ifaceList = interfaces[name];
    if (!ifaceList) continue;
    for (const iface of ifaceList) {
      // Skip internal and non-IPv4
      if (!iface.internal && iface.family === 'IPv4') {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ─── MIME type mapping ───────────────────────────────────────────────────────

function getContentType(ext: string): string {
  const mimeMap: Record<string, string> = {
    '.txt': 'text/plain; charset=utf-8',
    '.m3u': 'application/vnd.apple.mpegurl; charset=utf-8',
    '.m3u8': 'application/vnd.apple.mpegurl; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const localProxy = new LocalProxyServer();
