/**
 * ProxyServer - Local HTTP Proxy Server
 *
 * Mirrors Android's RemoteServer.java + ApiConfig.proxyLocal() flow:
 *   1. Spider's Proxy.a() probes ports 9978-9999 with `GET /proxy?do=ck`
 *      expecting response body "ok".
 *   2. playerContent returns URLs like `http://127.0.0.1:<port>/proxy?do=ali&...`
 *   3. Client requests that URL → we forward params + headers to
 *      jarLoader.proxyInvoke() which calls spider's Proxy.proxy(Map).
 *   4. Spider returns Object[]{status, mime, InputStream, headers?} which
 *      we stream back to the HTTP client with chunked transfer encoding.
 */

import http from 'http';
import https from 'https';
import net from 'net';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { Transform, PassThrough } from 'stream';
import dns from 'dns';
import { spawn } from 'child_process';
import { BrowserWindow } from 'electron';
import { jarLoader } from './JarLoader';
import { QuarkPanService } from './QuarkPanService';
import { UCPanService } from './UCPanService';
import { BaiduPanService } from './BaiduPanService';
import { dnsOptimizer } from './DnsOptimizer';

type PortCallback = (port: number) => void;

// Keep-alive agents so Range requests during video playback reuse the same
// TCP/TLS connection to the CDN instead of doing a fresh handshake every
// time (browsers fire multiple Range requests for buffering/seek; without
// reuse, each one pays 200-500ms TLS handshake latency → stutter).
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
});

// Persistent debug log for streamPanDirect — written to disk so we can
// inspect 412/403 errors without relying on vite's stdout capture (which
// gets truncated/buffered in dev mode). Each entry is timestamped.
const PROXY_DEBUG_LOG = path.join(
  process.env.APPDATA ? path.join(process.env.APPDATA, 'tvbox-pc') : __dirname,
  'proxy-debug.log',
);
function debugLog(msg: string): void {
  try {
    const dir = path.dirname(PROXY_DEBUG_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(PROXY_DEBUG_LOG, line, { flag: 'a' });
  } catch {}
}

/**
 * Transform stream that rewrites m3u8 paths line by line.
 * Mirrors Android's chunked response: reads chunks from upstream,
 * processes them, and immediately pushes to downstream.
 *
 * This avoids the "read full m3u8 → rewrite → send" delay that causes
 * player timeout/cancellation issues.
 */
class M3u8Rewriter extends Transform {
  private buffer: string = '';
  private baseUrl: string;
  private baseOrigin: string;
  private basePath: string;
  private queryPart: string;
  private port: number;
  private doType: string;
  private customHeaders: Record<string, string>;
  private rewriteCount: number = 0;
  private loggedFirstChunk: boolean = false;
  private directCdn: boolean;

  constructor(
    decodedUrl: string,
    port: number,
    doType: string,
    customHeaders: Record<string, string>,
    directCdn: boolean = false,
  ) {
    // Don't set encoding - we want to output Buffer, not string
    // decodeStrings: true converts input Buffer to string for us
    super({ decodeStrings: true });
    this.port = port;
    this.doType = doType;
    this.customHeaders = customHeaders;
    this.directCdn = directCdn;
    this.baseUrl = decodedUrl.split('?')[0];
    this.baseOrigin =
      this.baseUrl.match(/^https?:\/\/[^/]+/)?.[0] || this.baseUrl;
    this.basePath = this.baseUrl.substring(
      0,
      this.baseUrl.lastIndexOf('/') + 1,
    );
    this.queryPart = decodedUrl.includes('?')
      ? '?' + decodedUrl.split('?')[1]
      : '';
    console.log(
      '[M3u8Rewriter] constructor: baseOrigin=',
      this.baseOrigin,
      'basePath=',
      this.basePath,
      'queryPart=',
      this.queryPart.substring(0, 50),
      'directCdn=',
      this.directCdn,
    );
  }

  _transform(chunk: Buffer, encoding: string, callback: Function) {
    console.log(
      '[M3u8Rewriter] _transform called, chunk size=',
      chunk.length,
      'encoding=',
      encoding,
    );
    const text = chunk.toString('utf8');
    this.buffer += text;

    // Debug: log first chunk's raw content
    if (!this.loggedFirstChunk) {
      console.log(
        '[M3u8Rewriter] First chunk raw content:',
        text.substring(0, 300),
      );
      this.loggedFirstChunk = true;
    }

    // Process complete lines (m3u8 is line-oriented)
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in buffer
    this.buffer = lines.pop() || '';

    // Rewrite and push each complete line immediately (as Buffer)
    let pushedLines = 0;
    for (const line of lines) {
      const rewritten = this.rewriteLine(line);
      const buf = Buffer.from(rewritten + '\n', 'utf8');
      this.push(buf);
      pushedLines++;
    }
    console.log('[M3u8Rewriter] pushed', pushedLines, 'lines');

    callback();
  }

  _flush(callback: Function) {
    console.log(
      '[M3u8Rewriter] _flush called, buffer length=',
      this.buffer.length,
    );
    // Process any remaining data in buffer (last line without newline)
    if (this.buffer.length > 0) {
      const rewritten = this.rewriteLine(this.buffer);
      const buf = Buffer.from(rewritten, 'utf8');
      this.push(buf);
      console.log(
        '[M3u8Rewriter] flushed last line:',
        rewritten.substring(0, 50),
      );
    }
    callback();
  }

  private rewriteLine(line: string): string {
    // Skip comments and empty lines
    if (line.startsWith('#') || line.trim().length === 0) {
      return line;
    }

    // Rewrite media segment URLs (.ts, .m3u8, .m4s, .mp4, .key)
    // Support URLs with query strings (e.g., .ts?sign=xxx&t=xxx)
    if (line.match(/\.(ts|m3u8|m4s|mp4|key)(\?.*)?$/i)) {
      let fullUrl: string;

      // Already absolute URL → use as-is (don't append queryPart if it already has query params)
      if (line.startsWith('http://') || line.startsWith('https://')) {
        // Only append queryPart if the line doesn't already have query params
        fullUrl = line.includes('?') ? line : line + this.queryPart;
      } else if (line.startsWith('/')) {
        // Absolute path (starts with /)
        fullUrl = this.baseOrigin + line + this.queryPart;
      } else {
        // Relative path
        fullUrl = this.basePath + line + this.queryPart;
      }

      // Debug: log first few rewrites
      if (this.rewriteCount < 3) {
        console.log('[M3u8Rewriter] rewriteLine #' + this.rewriteCount + ':');
        console.log('  original line (full):', line);
        console.log('  fullUrl:', fullUrl);
        this.rewriteCount++;
      }

      // directCdn mode: output absolute CDN URL directly (hxq source).
      // The browser fetches TS from CDN at full speed without proxy overhead.
      if (this.directCdn) {
        return fullUrl;
      }

      // Normal mode: wrap in proxy URL for header injection.
      const encoded = encodeURIComponent(fullUrl);
      let proxyUrl = `http://127.0.0.1:${this.port}/proxy?do=${this.doType}&url=${encoded}`;

      // Add custom headers to URL params (for TS segments that need specific UA)
      if (this.customHeaders && Object.keys(this.customHeaders).length > 0) {
        const headerJson = JSON.stringify(this.customHeaders);
        proxyUrl += `&header=${encodeURIComponent(headerJson)}`;
      }

      return proxyUrl;
    }

    return line;
  }
}

/**
 * Transform stream that rewrites CDN hostnames in m3u8 TS URLs.
 * Replaces slow CDN domains with the fastest known CDN for the same base domain.
 *
 * This mirrors Android's DexNative CDN scheduling — the native library
 * probes multiple CDN endpoints and picks the fastest one. On PC we
 * don't have DexNative, so we test CDN speeds at startup and rewrite
 * TS URLs to use the fastest CDN.
 */
class CdnRewriter extends Transform {
  private buffer: string = '';
  private fastestCdn: string;
  private rewriteCount: number = 0;
  private loggedFirstChunk: boolean = false;

  constructor(fastestCdn: string) {
    super({ decodeStrings: true });
    this.fastestCdn = fastestCdn;
  }

  _transform(chunk: Buffer, encoding: string, callback: Function) {
    const text = chunk.toString('utf8');
    this.buffer += text;

    if (!this.loggedFirstChunk) {
      console.log(
        '[CdnRewriter] First chunk, rewriting CDN to',
        this.fastestCdn,
      );
      this.loggedFirstChunk = true;
    }

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const rewritten = this.rewriteLine(line);
      this.push(Buffer.from(rewritten + '\n', 'utf8'));
    }

    callback();
  }

  _flush(callback: Function) {
    if (this.buffer.length > 0) {
      const rewritten = this.rewriteLine(this.buffer);
      this.push(Buffer.from(rewritten, 'utf8'));
    }
    callback();
  }

  private rewriteLine(line: string): string {
    if (line.startsWith('#') || line.trim().length === 0) {
      return line;
    }

    // Only rewrite TS segment URLs (not m3u8, key, etc.)
    if (!line.match(/\.ts(\?.*)?$/i)) {
      return line;
    }

    // Only rewrite if the line is an absolute URL
    if (!line.startsWith('http://') && !line.startsWith('https://')) {
      return line;
    }

    try {
      const url = new URL(line);
      // Only rewrite 51touxiang.com CDN domains
      if (url.hostname.includes('51touxiang.com')) {
        const oldHost = url.hostname;
        url.hostname = this.fastestCdn;
        if (this.rewriteCount < 3) {
          console.log(
            '[CdnRewriter] CDN rewrite:',
            oldHost,
            '→',
            this.fastestCdn,
          );
          this.rewriteCount++;
        }
        return url.toString();
      }
    } catch {}

    return line;
  }
}

/**
 * Default upstream Referer/User-Agent per pan site.
 *
 * The browser's <video> element sends its own Referer (page origin) and UA
 * (Electron's UA) when fetching the proxy URL. CDNs reject these as 403.
 * These values mirror what the JAR spider expects (from playerContent
 * header output) and are injected when the request doesn't already
 * include them.
 */
const UPSTREAM_HEADER_DEFAULTS: Record<
  string,
  { referer?: string; userAgent?: string }
> = {
  quark: {
    referer: 'https://pan.quark.cn/',
    // Spider's NewQuark.getHeaders() UA. CDN returns 412 with other UAs.
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch',
  },
  uc: {
    referer: 'https://drive.uc.cn/',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  },
  aliyun: {
    referer: 'https://www.aliyundrive.com/',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  },
  baidu: {
    referer: 'https://pan.baidu.com/',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  },
  bili: {
    referer: 'https://www.bilibili.com/',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  },
};

export class ProxyServer {
  private server: http.Server | null = null;
  private port: number = -1;
  private onPortChanged: PortCallback | null = null;
  private static readonly START_PORT = 9978;
  private static readonly END_PORT = 9999;
  private contentLengthCache = new Map<string, number>();
  private dnsOptimized: boolean = false; // DNS优化是否已初始化
  private cdnOptimized: boolean = false; // CDN优化是否已初始化
  private fastestCdn: string = ''; // 最快的CDN域名
  private static readonly CDN_CANDIDATES = [
    'voldn-ser01.51touxiang.com',
    'piccct2.cdn.51touxiang.com',
    'piccc.cdn.51touxiang.com',
  ];

  /**
   * Set callback fired when the actual listening port is determined.
   */
  setPortCallback(cb: PortCallback): void {
    this.onPortChanged = cb;
  }

  /**
   * Get the actual listening port. Returns -1 if not started.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get the proxy base URL, e.g. "http://127.0.0.1:9978".
   * Returns empty string if not started.
   */
  getUrl(): string {
    if (this.port < 0) return '';
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * 初始化DNS优化
   * 启动时自动测速DoH服务器并选择最快的
   */
  async initDnsOptimization(): Promise<void> {
    console.log('[ProxyServer] 初始化DNS-over-HTTPS优化...');

    try {
      // 测速DoH服务器
      const results = await dnsOptimizer.testDohServers();

      // 输出测速结果
      console.log('[ProxyServer] DoH测速结果:');
      for (const result of results) {
        if (result.success) {
          console.log(`  ${result.name}: ${result.latency}ms`);
        } else {
          console.log(`  ${result.name}: 失败 (${result.error})`);
        }
      }

      this.dnsOptimized = true;
      console.log('[ProxyServer] DNS优化已启用');
    } catch (e: any) {
      console.warn('[ProxyServer] DNS优化初始化失败:', e.message);
      this.dnsOptimized = false;
    }
  }

  /**
   * 初始化CDN优化
   * 启动时测试所有候选CDN域名的下载速度，选择最快的
   */
  async initCdnOptimization(): Promise<void> {
    console.log('[ProxyServer] 初始化CDN优化...');
    console.log(
      '[ProxyServer] 候选CDN:',
      ProxyServer.CDN_CANDIDATES.join(', '),
    );

    const results: { cdn: string; speedKBps: number; error?: string }[] = [];

    for (const cdn of ProxyServer.CDN_CANDIDATES) {
      try {
        const score = await this.testCdnSpeed(cdn);
        results.push({ cdn, speedKBps: score });
        console.log(`[ProxyServer] CDN ${cdn}: TTFB score=${score.toFixed(1)}`);
      } catch (e: any) {
        results.push({ cdn, speedKBps: 0, error: e.message });
        console.log(`[ProxyServer] CDN ${cdn}: 失败 (${e.message})`);
      }
    }

    // 选择下载速度最快的CDN
    const valid = results.filter((r) => r.speedKBps > 0);
    if (valid.length > 0) {
      valid.sort((a, b) => b.speedKBps - a.speedKBps);
      this.fastestCdn = valid[0].cdn;
      this.cdnOptimized = true;
      console.log(
        '[ProxyServer] ✅ 最快CDN:',
        this.fastestCdn,
        `(${(valid[0].speedKBps / 1024).toFixed(2)} MB/s)`,
      );
    } else {
      console.warn('[ProxyServer] ⚠️ 所有CDN测试失败，CDN优化未启用');
      this.cdnOptimized = false;
    }
  }

  /**
   * 测试单个CDN域名的TCP连接延迟。
   * 使用TCP连接延迟倒数作为评分（延迟越低分数越高）。
   * TCP延迟不受应用层下载限速影响，比HTTP TTFB更可靠。
   */
  private testCdnSpeed(hostname: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const sock = net.connect({ host: hostname, port: 80 }, () => {
        const elapsed = Date.now() - startTime;
        sock.destroy();
        // 返回延迟倒数作为评分（ms → score），延迟越低分数越高
        // 100ms → 10.0, 50ms → 20.0, 200ms → 5.0
        resolve(1000 / Math.max(elapsed, 1));
      });
      sock.on('error', (err: Error) => reject(err));
      sock.setTimeout(5000, () => {
        sock.destroy();
        reject(new Error('TCP timeout'));
      });
    });
  }

  /**
   * 使用DNS优化解析域名并建立HTTP连接
   * 优先使用DoH，失败则使用系统DNS
   */
  async resolveWithDnsOptimization(hostname: string): Promise<string[]> {
    if (!this.dnsOptimized) {
      // DNS优化未启用，直接返回域名
      return [hostname];
    }

    try {
      // 使用DNS优化解析域名
      const ips = await dnsOptimizer.resolve(hostname);
      console.log(
        `[ProxyServer] DNS优化解析: ${hostname} -> ${ips.join(', ')}`,
      );
      return ips;
    } catch (e: any) {
      console.warn(`[ProxyServer] DNS优化解析失败: ${hostname}`, e.message);
      return [hostname];
    }
  }

  /**
   * Start the server. Tries ports 9978-9999 in order.
   * Resolves with the actual port in use.
   */
  async start(): Promise<number> {
    // DNS和CDN优化在后台异步执行，不阻塞主进程启动
    // 这样用户可以立即开始使用，优化完成后自动生效
    this.initDnsOptimization().catch((e) =>
      console.warn('[ProxyServer] DNS优化失败:', e.message),
    );
    this.initCdnOptimization().catch((e) =>
      console.warn('[ProxyServer] CDN优化失败:', e.message),
    );

    return new Promise<number>((resolve, reject) => {
      if (this.server) {
        resolve(this.port);
        return;
      }
      this.tryListen(ProxyServer.START_PORT, (port) => {
        if (port < 0) {
          reject(
            new Error(
              `No available port in ${ProxyServer.START_PORT}-${ProxyServer.END_PORT}`,
            ),
          );
          return;
        }
        this.port = port;
        console.log(`[ProxyServer] Listening on http://127.0.0.1:${port}`);
        if (this.onPortChanged) {
          try {
            this.onPortChanged(port);
          } catch (_) {}
        }
        resolve(port);
      });
    });
  }

  /**
   * Stop the server.
   */
  stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      const s = this.server;
      s.close(() => {
        this.server = null;
        this.port = -1;
        console.log('[ProxyServer] Stopped');
        resolve();
      });
    });
  }

  private tryListen(port: number, callback: (port: number) => void): void {
    if (port > ProxyServer.END_PORT) {
      callback(-1);
      return;
    }
    const server = http.createServer((req, res) =>
      this.handleRequest(req, res),
    );
    server.timeout = 60000;
    server.keepAliveTimeout = 65000;

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[ProxyServer] Port ${port} in use, trying ${port + 1}`);
        this.tryListen(port + 1, callback);
        return;
      }
      console.error('[ProxyServer] Server error:', err.message);
      callback(-1);
    });
    server.listen(port, '127.0.0.1', () => {
      this.server = server;
      callback(port);
    });
  }

  /**
   * Main request handler. Mirrors Android RemoteServer.serve().
   */
  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const method = req.method || 'GET';
    const fullUrl = req.url || '/';

    // Parse URL and query
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(fullUrl, 'http://127.0.0.1');
    } catch (e: any) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return;
    }

    const pathname = parsedUrl.pathname || '/';
    const params: Record<string, string> = {};

    // Copy query params
    for (const [k, v] of parsedUrl.searchParams.entries()) {
      params[k] = v;
    }

    // Only GET is implemented (matches the spider's expectations)
    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    // Spider probes /platform?type=androidbro during detailContent and
    // expects exactly "OK" (no JSON, no trailing newline). Returning
    // anything else causes the spider to treat the local proxy as offline.
    if (pathname === '/platform') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }

    if (pathname !== '/proxy') {
      // m3u8 proxy: /m3u8.m3u8?url=<encoded video URL>&header=<encoded JSON>
      // Routes direct video URLs through Node.js (not the browser) so we can
      // set User-Agent/Referer freely and avoid Chromium TLS fingerprinting.
      // For m3u8 manifests, TS segment URLs are rewritten to route through
      // this same endpoint so the CDN sees consistent headers on every request.
      if (
        pathname === '/m3u8.m3u8' ||
        pathname === '/m3u8' ||
        pathname === '/ts'
      ) {
        const upstreamUrl = params['url'];
        if (!upstreamUrl) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing url parameter');
          return;
        }
        let headerJson: Record<string, string> | null = null;
        if (params['header']) {
          try {
            headerJson = JSON.parse(params['header']);
          } catch {
            console.warn(
              '[ProxyServer] /m3u8.m3u8: failed to parse header param',
            );
          }
        }
        void this.streamVideoDirect(
          upstreamUrl,
          req,
          res,
          headerJson,
          pathname === '/ts',
        );
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    // Probe response: do=ck → "ok"
    if (params['do'] === 'ck') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('ok');
      return;
    }

    // quarkDirect/ucDirect/baiduDirect: stream directly from a pan CDN download
    // URL. Used by resolveQuarkPlayerContent fallback when the spider's pan
    // resolver can't resolve the share link. The download URL was already
    // obtained via the pan service's resolveDownloadUrl; we just need to
    // inject Cookie + Referer + User-Agent and stream the bytes back,
    // honoring Range requests for video seeking.
    // (Aliyun's signed download_url works without auth, so it's returned
    // directly without going through the proxy.)
    if (
      params['do'] === 'quarkDirect' ||
      params['do'] === 'ucDirect' ||
      params['do'] === 'baiduDirect'
    ) {
      const downloadUrl = params['url'];
      if (!downloadUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing url parameter');
        return;
      }
      const panType =
        params['do'] === 'quarkDirect'
          ? 'quark'
          : params['do'] === 'ucDirect'
            ? 'uc'
            : 'baidu';
      // Spider's translatePlayerContent encodes spider-provided headers
      // (User-Agent, Referer) into the proxy URL as &header=<encoded JSON>.
      // Pass them to streamPanDirect so it can use the spider's UA instead
      // of the hardcoded default — Baidu CDN's sign validation rejects
      // mismatched UAs with error_code 31362 "sign error".
      let headerOverride: Record<string, string> | undefined;
      if (params['header']) {
        try {
          const parsed = JSON.parse(params['header']);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            headerOverride = parsed;
          }
        } catch {
          // ignore parse error, fall back to defaults
        }
      }
      void this.streamPanDirect(downloadUrl, req, res, panType, headerOverride);
      return;
    }

    // Other do= values → forward to spider
    if (!params['do']) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing "do" parameter');
      return;
    }

    // All proxy requests now go through jarLoader.proxyInvoke which will:
    // 1. Try spider.proxyLocal() if recentSpiderKey is set (for spider-specific logic)
    // 2. Fallback to Proxy.proxy() static method if spider.proxyLocal fails
    // This mirrors Android's ApiConfig.proxyLocal() flow and ensures compatibility
    // with all spider types (encryption/decryption, CDN scheduling, etc.)

    // Merge request headers into params (Android: params.putAll(session.getHeaders()))
    // Header keys come lowercased from Node http.
    const headerSnapshot: Record<string, string> = {};
    for (const [hk, hv] of Object.entries(req.headers)) {
      if (typeof hv === 'string') {
        params[hk] = hv;
        headerSnapshot[hk] = hv;
      } else if (Array.isArray(hv)) {
        const joined = hv.join(', ');
        params[hk] = joined;
        headerSnapshot[hk] = joined;
      }
    }
    // Spider may also want a JSON snapshot of the request headers
    // (Android RemoteServer.serve adds: params.put("request-headers", new Gson().toJson(session.getHeaders())))
    try {
      params['request-headers'] = JSON.stringify(headerSnapshot);
    } catch (_) {}

    // Browsers' <video> element cannot send custom headers (Cookie/Referer/UA)
    // to cross-origin URLs. When the player requests the proxy URL, the browser
    // sends its own Referer (the page origin) and UA (Electron's UA), which the
    // upstream CDN rejects with 403. Inject the correct defaults per pan site
    // so the spider sends what the CDN expects. The spider reads the cookie
    // from SharedPreferences, but Referer/UA must come from the params.
    this.injectUpstreamHeaders(params);

    // Honor Range header if the player requests a byte range
    // (already included via req.headers merge above as 'range')

    void this.invokeSpiderProxy(params, req, res);
  }

  /**
   * Inject the correct Referer/User-Agent/Cookie for upstream CDN requests.
   *
   * The browser's <video> element always sends its own Referer (page origin)
   * and UA (Electron's UA) when fetching the proxy URL. These never match
   * what the upstream CDN expects, causing 403. The browser also cannot send
   * the pan Cookie header to a cross-origin URL.
   *
   * The spider can read the Cookie from SharedPreferences, but the spider's
   * read path may not reliably forward __puus to the CDN (causing 412). We
   * inject the cached cookie directly into the params to bypass the spider's
   * SharedPreferences read path.
   *
   * We always overwrite these headers for pan CDN requests because the
   * browser's values are never correct for the upstream CDN.
   */
  private injectUpstreamHeaders(params: Record<string, string>): void {
    const site = params['site'];
    if (!site) return;

    const defaults = UPSTREAM_HEADER_DEFAULTS[site];
    if (!defaults) return;

    if (defaults.referer) {
      params['referer'] = defaults.referer;
    }
    if (defaults.userAgent) {
      params['user-agent'] = defaults.userAgent;
    }

    // Inject cookie from the in-memory cache (set by syncCookieToJVM /
    // setSyncedCookie). This bypasses the spider's SharedPreferences read
    // path, which fails to send __puus to the CDN (causing 412).
    let cookie: string | null = null;
    if (site === 'quark') {
      cookie = QuarkPanService.getSyncedCookie();
    } else if (site === 'uc') {
      cookie = UCPanService.getSyncedCookie();
    } else if (site === 'baidu') {
      cookie = BaiduPanService.getSyncedCookie();
    }
    if (cookie) {
      params['cookie'] = cookie;
    }
  }

  /**
   * Call jarLoader.proxyInvoke(params) and stream the Java InputStream
   * back to the HTTP response. Mirrors Android RemoteServer.getProxy().
   */
  private async invokeSpiderProxy(
    params: Record<string, string>,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Decode the upstream URL BEFORE calling spider to detect TS segments.
    // TS segments don't need spider processing — we stream them directly
    // from CDN with ffmpeg transcoding (HEVC→H.264). Checking early avoids
    // the spider call overhead and ensures correct Content-Type headers.
    let decodedUrl = '';
    try {
      decodedUrl = decodeURIComponent(params['url'] || '');
    } catch {}

    const isTsByUrl = decodedUrl && decodedUrl.match(/\.ts(\?.*)?$/i);

    if (isTsByUrl) {
      // TS segment: stream directly from CDN through ffmpeg for HEVC→H.264
      // transcoding. No spider call needed — auth params are in the URL.
      console.log('[ProxyServer] TS segment detected, streaming transcode...');
      this.streamTranscodeTs(decodedUrl, req, res);
      return;
    }

    let result: {
      status: number;
      mime: string;
      stream: any;
      headers?: Record<string, string>;
    } | null = null;

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let clientDisconnected = false;

    req.on('close', () => {
      clientDisconnected = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    });

    req.on('error', () => {
      clientDisconnected = true;
    });

    timeoutTimer = setTimeout(() => {
      if (!res.headersSent) {
        clientDisconnected = true;
        try {
          res.writeHead(504, { 'Content-Type': 'text/plain' });
          res.end('Gateway Timeout');
        } catch {}
      }
      timeoutTimer = null;
    }, 30000);

    try {
      result = await jarLoader.proxyInvokeAsync(params);
    } catch {
      if (!res.headersSent && !clientDisconnected) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Proxy invoke failed');
      }
      return;
    }

    if (clientDisconnected) {
      if (result?.stream) {
        try {
          result.stream.closeSync();
        } catch {}
      }
      return;
    }

    if (!result) {
      // Fallback to streamUnknownProxy when spider methods fail
      console.log(
        '[ProxyServer] invokeSpiderProxy: spider methods failed, falling back to direct proxy for do=',
        params['do'],
      );

      const upstreamUrl = params['url'];
      if (upstreamUrl) {
        let customHeaders: Record<string, string> = {};
        try {
          const headerStr = params['header'];
          if (headerStr) {
            customHeaders = JSON.parse(headerStr);
          }
        } catch {}
        if (params['referer']) {
          customHeaders['Referer'] = params['referer'];
        }
        if (params['user-agent']) {
          customHeaders['User-Agent'] = params['user-agent'];
        }
        if (params['cookie']) {
          customHeaders['Cookie'] = params['cookie'];
        }

        void this.streamUnknownProxy(
          upstreamUrl,
          req,
          res,
          customHeaders,
          params['do'],
        );
        return;
      }

      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Spider proxy returned null and no URL available for fallback');
      }
      return;
    }

    const { status, mime, stream, headers } = result;
    const effectiveMime = this.resolveVideoMime(mime, params);

    const isM3u8 =
      effectiveMime.includes('mpegurl') || effectiveMime.includes('mpegURL');

    const upstreamUrl = params['url'] || '';
    const site = params['site'];
    const totalLength =
      isM3u8 || !upstreamUrl
        ? -1
        : await this.fetchContentLength(upstreamUrl, site);

    const rangeHeader = req.headers['range'] as string | undefined;
    const range =
      totalLength > 0 ? this.parseRange(rangeHeader, totalLength) : null;

    let headerObj: http.OutgoingHttpHeaders;
    let effectiveStatus: number;

    if (totalLength > 0 && range) {
      const contentLength = range.end - range.start + 1;
      headerObj = {
        'Content-Type': effectiveMime,
        'Content-Length': contentLength,
        'Content-Range': `bytes ${range.start}-${range.end}/${totalLength}`,
        'Accept-Ranges': 'bytes',
        Connection: 'keep-alive',
      };
      effectiveStatus = 206;
    } else if (totalLength > 0 && !rangeHeader) {
      headerObj = {
        'Content-Type': effectiveMime,
        'Content-Length': totalLength,
        'Accept-Ranges': 'bytes',
        Connection: 'keep-alive',
      };
      effectiveStatus = status === 206 ? 200 : status || 200;
    } else {
      headerObj = {
        'Content-Type': effectiveMime,
        'Transfer-Encoding': 'chunked',
        'Accept-Ranges': 'bytes',
        Connection: 'keep-alive',
      };
      effectiveStatus = status === 206 ? 200 : status || 200;
    }

    if (!stream) {
      try {
        res.writeHead(effectiveStatus, headerObj);
      } catch {}
      res.end();
      return;
    }

    try {
      res.writeHead(effectiveStatus, headerObj);
    } catch {
      try {
        stream.closeSync();
      } catch {}
      return;
    }

    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }

    // For m3u8 content: decide whether to rewrite TS URLs.
    //
    // hxq source: TS URLs already contain auth params (utk, uk, sign, etc.)
    // in the query string. The CDN serves them without requiring special
    // headers. We pass the m3u8 through unchanged so the browser fetches TS
    // directly from CDN at full speed. HEVC decoding is handled by the
    // browser's native decoder (PlatformHEVCDecoderSupport flag) or by
    // hevc.js WASM decoder in the player.
    //
    // Other sources (quark, uc, etc.): TS requests need Cookie/Referer/UA
    // headers that the browser can't send cross-origin. We rewrite TS URLs
    // to proxy URLs so the proxy can inject these headers.
    if (isM3u8) {
      const isHxq = params['do'] === 'hxq';

      if (isHxq) {
        // hxq: rewrite relative TS paths to absolute CDN URLs (NOT proxy URLs).
        // The m3u8 from the CDN contains relative paths like
        // "/m3u8/.../file.ts" which the browser would resolve against the
        // proxy origin (127.0.0.1:9978) → 404. We rewrite them to absolute
        // CDN URLs so the browser fetches TS directly from CDN at full speed.
        // Auth params (utk, uk, sign, t) are in the queryPart appended to each URL.
        //
        // CDN optimization: replace slow CDN hostnames (e.g. piccc.cdn) with
        // the fastest CDN (e.g. voldn-ser01) selected at startup. This avoids
        // the ~0.06 MB/s throttling on piccc.cdn.
        console.log(
          '[ProxyServer] m3u8 streaming (hxq: rewrite to absolute CDN URLs)',
        );
        const passThrough = new PassThrough();
        const m3u8Rewriter = new M3u8Rewriter(
          decodedUrl,
          this.port,
          params['do'],
          {},
          true, // directCdn: output absolute CDN URLs, not proxy URLs
        );
        if (this.cdnOptimized && this.fastestCdn) {
          const cdnRewriter = new CdnRewriter(this.fastestCdn);
          passThrough.pipe(m3u8Rewriter).pipe(cdnRewriter).pipe(res);
          console.log(
            '[ProxyServer] hxq m3u8: CDN rewrite enabled, target=',
            this.fastestCdn,
          );
        } else {
          passThrough.pipe(m3u8Rewriter).pipe(res);
        }
        jarLoader.streamJavaToNode(
          stream,
          passThrough,
          () => {
            try {
              passThrough.end();
            } catch {}
          },
          () => {
            try {
              passThrough.destroy();
            } catch {}
          },
        );
      } else {
        // Other sources: rewrite TS URLs to proxy URLs for header injection.
        let customHeaders: Record<string, string> = {};
        try {
          const headerStr = params['header'];
          if (headerStr) {
            customHeaders = JSON.parse(headerStr);
          }
        } catch {}
        if (params['referer']) customHeaders['Referer'] = params['referer'];
        if (params['user-agent'])
          customHeaders['User-Agent'] = params['user-agent'];
        if (params['cookie']) customHeaders['Cookie'] = params['cookie'];

        const passThrough = new PassThrough();
        const m3u8Rewriter = new M3u8Rewriter(
          decodedUrl,
          this.port,
          params['do'],
          customHeaders,
        );
        passThrough.pipe(m3u8Rewriter).pipe(res);
        console.log(
          '[ProxyServer] m3u8 streaming with M3u8Rewriter (TS → proxy)',
        );
        jarLoader.streamJavaToNode(
          stream,
          passThrough,
          () => {
            try {
              passThrough.end();
            } catch {}
          },
          () => {
            try {
              passThrough.destroy();
            } catch {}
          },
        );
      }
    } else {
      jarLoader.streamJavaToNode(
        stream,
        res,
        () => {
          try {
            res.end();
          } catch {}
        },
        () => {
          try {
            res.destroy();
          } catch {}
        },
      );
    }
  }

  /**
   * Stream a TS segment from CDN through ffmpeg for HEVC→H.264 transcoding.
   *
   * Uses streaming pipes (no buffering):
   *   CDN download → ffmpeg stdin → ffmpeg stdout → HTTP response
   *
   * This eliminates the "download-then-transcode" latency of the old
   * downloadAndTranscodeTs approach. ffmpeg starts producing output as soon
   * as it has enough input, and the client receives data immediately.
   */
  private streamTranscodeTs(
    tsUrl: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const startTime = Date.now();

    const u = new URL(tsUrl);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;

    // Send response headers immediately — we'll stream the transcoded data
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
    });

    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
    });
    req.on('error', () => {
      clientGone = true;
    });

    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-i',
        'pipe:0',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-c:a',
        'copy',
        '-f',
        'mpegts',
        '-y',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let totalOut = 0;
    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      totalOut += chunk.length;
    });

    let stderrLog = '';
    ffmpeg.stderr.on('data', (data: Buffer) => {
      stderrLog += data.toString();
    });

    ffmpeg.on('error', (err: Error) => {
      console.error(
        '[ProxyServer] streamTranscodeTs: ffmpeg error:',
        err.message,
      );
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {}
      }
    });

    ffmpeg.on('close', (code: number) => {
      const elapsed = Date.now() - startTime;
      console.log(
        '[ProxyServer] streamTranscodeTs: done, ffmpeg exit=',
        code,
        'output=',
        totalOut,
        'bytes, elapsed=',
        elapsed,
        'ms',
      );
      if (code !== 0) {
        console.error(
          '[ProxyServer] streamTranscodeTs: ffmpeg stderr:',
          stderrLog.substring(0, 500),
        );
      }
    });

    // Pipe ffmpeg stdout directly to HTTP response
    ffmpeg.stdout.pipe(res, { end: true });

    // Download from CDN and pipe directly to ffmpeg stdin
    const cdnReq = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
          Accept: '*/*',
          'Accept-Encoding': 'identity',
        },
        agent: isHttps ? httpsAgent : httpAgent,
      },
      (upstreamRes) => {
        if (upstreamRes.statusCode !== 200) {
          console.error(
            '[ProxyServer] streamTranscodeTs: CDN returned',
            upstreamRes.statusCode,
          );
          ffmpeg.stdin.end();
          return;
        }

        // Pipe CDN response stream directly to ffmpeg stdin
        upstreamRes.pipe(ffmpeg.stdin);

        upstreamRes.on('error', (err: Error) => {
          console.error(
            '[ProxyServer] streamTranscodeTs: CDN download error:',
            err.message,
          );
          try {
            ffmpeg.stdin.end();
          } catch {}
        });
      },
    );

    cdnReq.on('error', (err: Error) => {
      console.error(
        '[ProxyServer] streamTranscodeTs: CDN request error:',
        err.message,
      );
      try {
        ffmpeg.stdin.end();
      } catch {}
    });

    cdnReq.setTimeout(15000, () => {
      console.error('[ProxyServer] streamTranscodeTs: CDN download timeout');
      cdnReq.destroy();
      try {
        ffmpeg.stdin.end();
      } catch {}
    });

    cdnReq.end();
  }

  /**
   * Fetch the total content length for an upstream CDN URL.
   *
   * The spider's Proxy.proxy() doesn't expose the CDN's Content-Length or
   * Content-Range in its result. To support seeking, we probe the CDN
   * directly with a GET request using `Range: bytes=0-0` (1 byte). The
   * CDN responds with `Content-Range: bytes 0-0/<total>` from which we
   * extract the total length.
   *
   * Results are cached per URL for the session (URLs are unique per video
   * and expire after a few hours, so the cache won't grow unbounded).
   *
   * Returns -1 if the length cannot be determined (caller should fall back
   * to chunked 200 without seeking).
   */
  private fetchContentLength(
    upstreamUrl: string,
    site: string | undefined,
  ): Promise<number> {
    return new Promise((resolve) => {
      if (this.contentLengthCache.has(upstreamUrl)) {
        resolve(this.contentLengthCache.get(upstreamUrl)!);
        return;
      }

      const headers: Record<string, string> = {
        Range: 'bytes=0-0',
        Accept: '*/*',
        'Accept-Encoding': 'identity',
      };

      if (site) {
        const defaults = UPSTREAM_HEADER_DEFAULTS[site];
        if (defaults?.referer) headers['Referer'] = defaults.referer;
        if (defaults?.userAgent) headers['User-Agent'] = defaults.userAgent;
      }

      if (site === 'quark') {
        const cookie = QuarkPanService.getSyncedCookie();
        if (cookie) headers['Cookie'] = cookie;
      }

      let url: URL;
      try {
        url = new URL(upstreamUrl);
      } catch (_) {
        resolve(-1);
        return;
      }

      const lib = url.protocol === 'https:' ? https : http;

      const probeReq = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'GET',
          headers,
        },
        (response) => {
          // Destroy immediately to avoid downloading body
          response.destroy();

          // Follow redirects (3xx) — extract total from Location's Content-Range
          // isn't possible, so just fail for redirects.
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400
          ) {
            console.warn(
              '[ProxyServer] fetchContentLength: redirect',
              response.statusCode,
              '- not supported',
            );
            resolve(-1);
            return;
          }

          const contentRange = response.headers['content-range'];
          if (contentRange) {
            // Content-Range: bytes 0-0/<total>
            const match = contentRange.match(/bytes \d+-\d+\/(\d+)/);
            if (match) {
              const total = parseInt(match[1]);
              this.contentLengthCache.set(upstreamUrl, total);
              console.log(
                '[ProxyServer] fetchContentLength: total=',
                total,
                'from Content-Range',
              );
              resolve(total);
              return;
            }
          }

          // Fall back to Content-Length header (no Range support on CDN)
          const contentLength = response.headers['content-length'];
          if (contentLength) {
            const total = parseInt(contentLength);
            this.contentLengthCache.set(upstreamUrl, total);
            console.log(
              '[ProxyServer] fetchContentLength: total=',
              total,
              'from Content-Length (no range support)',
            );
            resolve(total);
            return;
          }

          console.warn(
            '[ProxyServer] fetchContentLength: failed, status=',
            response.statusCode,
          );
          resolve(-1);
        },
      );

      probeReq.on('error', (err: NodeJS.ErrnoException) => {
        console.warn('[ProxyServer] fetchContentLength error:', err.message);
        resolve(-1);
      });

      probeReq.setTimeout(5000, () => {
        console.warn('[ProxyServer] fetchContentLength: timeout');
        probeReq.destroy();
        resolve(-1);
      });

      probeReq.end();
    });
  }

  /**
   * Parse a Range header like "bytes=5000000-" or "bytes=5000000-10000000"
   * into {start, end}. Returns null if parsing fails or no Range header.
   */
  private parseRange(
    rangeHeader: string | undefined,
    totalLength: number,
  ): { start: number; end: number } | null {
    if (!rangeHeader) return null;
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) return null;
    const start = parseInt(match[1]);
    let end = match[2] ? parseInt(match[2]) : totalLength - 1;
    if (end >= totalLength) end = totalLength - 1;
    if (start > end) return null;
    return { start, end };
  }

  /**
   * Resolve the effective Content-Type for the HTTP response.
   *
   * The spider often returns "application/oct-stream" or empty as the MIME,
   * which the browser's <video> element refuses to play. When this happens,
   * we detect the actual video type from the upstream URL (passed in
   * params.url) or the proxy's `cate`/`type` params.
   *
   * For non-video MIMEs (e.g. image, JSON, HTML), we keep the spider's value.
   */
  private resolveVideoMime(
    spiderMime: string | undefined,
    params: Record<string, string>,
  ): string {
    const mime = (spiderMime || '').toLowerCase();
    // Detect "unknown/binary" MIMEs that the spider uses for video streams
    const isGenericBinary =
      !mime ||
      mime === 'application/octet-stream' ||
      mime === 'application/oct-stream' ||
      mime === 'binary/octet-stream';

    if (!isGenericBinary) return spiderMime as string;

    // Try to detect from upstream URL extension
    const upstreamUrl = params['url'] || '';
    let ext = '';
    try {
      const u = new URL(upstreamUrl);
      // 1. Check URL path for a file extension
      const pathname = u.pathname.toLowerCase();
      const dotIdx = pathname.lastIndexOf('.');
      if (dotIdx >= 0) {
        ext = pathname.slice(dotIdx + 1);
      }
      // 2. Quark CDN puts the filename in the response-content-disposition
      // query param (the URL path is just a hash). Extract the extension
      // from there. Example: response-content-disposition=attachment;
      //    filename=Swim.to.Me.2025.1080p.WEB.h264.mkv
      if (!ext) {
        const rcd = u.searchParams.get('response-content-disposition') || '';
        console.log('[ProxyServer] resolveVideoMime: rcd=', rcd);
        const match = rcd.match(/filename\*?=(?:utf-8'')?([^;]+)/i);
        console.log(
          '[ProxyServer] resolveVideoMime: match=',
          match ? match[1] : null,
        );
        if (match) {
          const filename = decodeURIComponent(match[1]).toLowerCase();
          const dotIdx2 = filename.lastIndexOf('.');
          console.log(
            '[ProxyServer] resolveVideoMime: filename=',
            filename,
            'dotIdx2=',
            dotIdx2,
          );
          if (dotIdx2 >= 0) {
            ext = filename.slice(dotIdx2 + 1);
          }
        }
      }
      // 3. Check a plain "filename" query param
      if (!ext) {
        const filename = u.searchParams.get('filename') || '';
        if (filename) {
          const lower = filename.toLowerCase();
          const dotIdx2 = lower.lastIndexOf('.');
          if (dotIdx2 >= 0) ext = lower.slice(dotIdx2 + 1);
        }
      }
      console.log(
        '[ProxyServer] resolveVideoMime: final ext=',
        ext,
        'upstreamUrl=',
        upstreamUrl.substring(0, 200),
      );
    } catch (e: any) {
      // Not a valid URL, try as a plain string
      console.warn(
        '[ProxyServer] resolveVideoMime: URL parse failed:',
        e?.message,
        'upstreamUrl=',
        upstreamUrl.substring(0, 200),
      );
      const lower = upstreamUrl.toLowerCase();
      const dotIdx = lower.lastIndexOf('.');
      if (dotIdx >= 0) ext = lower.slice(dotIdx + 1).split(/[?&]/)[0];
    }

    switch (ext) {
      case 'mp4':
      case 'm4v':
        return 'video/mp4';
      case 'm3u8':
        return 'application/vnd.apple.mpegurl';
      case 'flv':
        return 'video/x-flv';
      case 'mpd':
        return 'application/dash+xml';
      case 'ts':
        return 'video/mp2t';
      case 'mkv':
        return 'video/x-matroska';
      case 'webm':
        return 'video/webm';
      case 'mov':
        return 'video/quicktime';
      case 'avi':
        return 'video/x-msvideo';
      default:
        // If params indicate video type, default to mp4
        if (params['type'] === 'video' || params['cate'] === 'down') {
          return 'video/mp4';
        }
        return 'application/octet-stream';
    }
  }

  /**
   * Stream a pan-CDN download URL directly to the HTTP response.
   *
   * Used by the playerContent fallback path (do=quarkDirect|ucDirect|baiduDirect).
   * The download URL was pre-resolved by the pan service's resolveDownloadUrl;
   * we just inject the upstream headers (Cookie/Referer/UA) the browser can't
   * send and pipe the bytes through, honoring Range requests for seeking.
   */
  private async streamPanDirect(
    downloadUrl: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    panType: 'quark' | 'uc' | 'baidu',
    headerOverride?: Record<string, string>,
  ): Promise<void> {
    let cookie: string | null = null;
    let referer = '';
    let userAgent = '';
    if (panType === 'quark') {
      cookie = QuarkPanService.getSyncedCookie();
      referer = 'https://pan.quark.cn/';
      // Spider's NewQuark.getHeaders() uses the quark-cloud-drive desktop UA.
      // The video CDN rejects other UAs with 412 Precondition Failed.
      userAgent = QuarkPanService.getQuarkDesktopUA();
    } else if (panType === 'uc') {
      cookie = UCPanService.getSyncedCookie();
      referer = 'https://drive.uc.cn/';
      userAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    } else {
      cookie = BaiduPanService.getSyncedCookie();
      referer = 'https://pan.baidu.com/';
      userAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    }
    // Spider-provided headers override defaults. Baidu's download URL sign is
    // bound to the UA the spider used when generating the link (Android UA
    // like "com.android.chrome/... AndroidXMedia3/..."). Sending a Windows
    // UA causes the CDN to reject with 31362 "sign error".
    if (headerOverride) {
      if (headerOverride['User-Agent']) {
        userAgent = headerOverride['User-Agent'];
      }
      if (headerOverride['Referer']) {
        referer = headerOverride['Referer'];
      }
    }
    if (!cookie) {
      console.warn(
        '[ProxyServer] streamPanDirect:',
        panType,
        'cookie not synced',
      );
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`${panType} cookie not synced`);
      }
      return;
    }

    const upstreamHeaders: Record<string, string> = {
      'User-Agent': userAgent,
      Referer: referer,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Cookie: cookie,
    };
    if (req.headers['range']) {
      upstreamHeaders['Range'] = String(req.headers['range']);
    }

    console.log(
      '[ProxyServer] streamPanDirect:',
      panType,
      'url=',
      downloadUrl,
      'cookieLen=',
      cookie.length,
      'hasRange=',
      !!req.headers['range'],
      'cookiePreview=',
      cookie.substring(0, 80) + '...',
      'hasPuus=',
      cookie.includes('__puus'),
      'ua=',
      userAgent.substring(0, 60),
    );
    debugLog(
      `streamPanDirect START panType=${panType} url=${downloadUrl} cookieLen=${cookie.length} hasRange=${!!req.headers['range']} hasPuus=${cookie.includes('__puus')} ua=${userAgent}`,
    );
    debugLog(`streamPanDirect cookie=${cookie}`);
    debugLog(
      `streamPanDirect REQ_HEADERS=${JSON.stringify({ ...upstreamHeaders, Cookie: `<${cookie.length} bytes>` })} actualCookieSent=${upstreamHeaders.Cookie ? 'YES' : 'NO'} clientHeaders=${JSON.stringify(req.headers)}`,
    );

    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
    });
    req.on('error', () => {
      clientGone = true;
    });

    try {
      const parsedUrl = new URL(downloadUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;
      const upstreamReq = lib.request(
        downloadUrl,
        {
          method: 'GET',
          headers: upstreamHeaders,
          agent: isHttps ? httpsAgent : httpAgent,
        },
        (upstreamRes) => {
          if (clientGone) {
            try {
              upstreamRes.destroy();
            } catch {}
            return;
          }
          const status = upstreamRes.statusCode || 200;
          console.log(
            '[ProxyServer] streamPanDirect: upstream responded status=',
            status,
            'content-type=',
            upstreamRes.headers['content-type'],
            'content-length=',
            upstreamRes.headers['content-length'],
            'headers=',
            JSON.stringify(upstreamRes.headers).substring(0, 500),
            panType,
          );
          debugLog(
            `streamPanDirect UPSTREAM status=${status} content-type=${upstreamRes.headers['content-type']} content-length=${upstreamRes.headers['content-length']} respHeaders=${JSON.stringify(upstreamRes.headers)}`,
          );
          // For non-2xx responses, capture the body to see what the CDN
          // is complaining about (Quark returns a small HTML error page
          // for 412/403). Without this we only see the status code.
          if (status >= 400) {
            const bodyChunks: Buffer[] = [];
            upstreamRes.on('data', (chunk: Buffer) => {
              bodyChunks.push(chunk);
            });
            upstreamRes.on('end', async () => {
              const body = Buffer.concat(bodyChunks).toString('utf8');
              console.warn(
                '[ProxyServer] streamPanDirect: upstream error body (len=' +
                  body.length +
                  '):',
                panType,
                body.substring(0, 1000),
              );
              debugLog(
                `streamPanDirect ERROR_BODY len=${body.length} body=${body.substring(0, 2000)}`,
              );
              // Send the error response to the browser FIRST, so the video
              // player doesn't wait for the login validity check below.
              if (!res.headersSent) {
                res.writeHead(status, {
                  'Content-Type':
                    upstreamRes.headers['content-type'] || 'text/plain',
                });
                res.end(body);
              }
              // 412 from Quark CDN can mean: (1) __puus is stale, (2) the
              // download URL's auth_key has expired, or (3) Cookie was sent
              // when it shouldn't be. Only case (1) warrants a login prompt —
              // the others just need a fresh playerContent call. So verify
              // login validity before popping up the QR code dialog.
              if (status === 412 && panType === 'quark') {
                let loginActuallyExpired = false;
                try {
                  const validity = await QuarkPanService.checkTokenValid();
                  loginActuallyExpired = !validity.valid;
                  console.warn(
                    '[ProxyServer] streamPanDirect: Quark 412 detected, checkTokenValid=',
                    validity.valid,
                    loginActuallyExpired
                      ? '-> emitting pan:loginExpired'
                      : '-> login still valid, 412 is likely expired auth_key',
                  );
                } catch (e: any) {
                  console.warn(
                    '[ProxyServer] streamPanDirect: checkTokenValid failed:',
                    e.message,
                    '-> treating as expired (safer)',
                  );
                  loginActuallyExpired = true;
                }
                if (loginActuallyExpired) {
                  try {
                    BrowserWindow.getAllWindows().forEach((w) =>
                      w.webContents.send('pan:loginExpired', 'quark'),
                    );
                  } catch (e: any) {
                    console.warn(
                      '[ProxyServer] Failed to emit pan:loginExpired:',
                      e.message,
                    );
                  }
                }
              }
            });
            upstreamRes.on('error', () => {
              if (!res.headersSent) {
                try {
                  res.end();
                } catch {}
              }
            });
            return;
          }
          // Detect m3u8 manifest — need to rewrite TS segment URLs
          // to route through the proxy so the CDN sees consistent headers
          // (browser can't set User-Agent/Referer on fetch/XHR).
          const contentType = String(
            upstreamRes.headers['content-type'] || '',
          ).toLowerCase();
          const isM3u8 =
            contentType.includes('mpegurl') ||
            contentType.includes('m3u8') ||
            downloadUrl.toLowerCase().includes('.m3u8');

          if (isM3u8) {
            const bodyChunks: Buffer[] = [];
            upstreamRes.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
            upstreamRes.on('end', () => {
              const manifest = Buffer.concat(bodyChunks).toString('utf8');
              console.log(
                '[ProxyServer] streamPanDirect: m3u8 manifest received, len=',
                manifest.length,
                'firstLine=',
                manifest.substring(0, 100),
              );
              const rewritten = this.rewritePanM3u8Manifest(
                manifest,
                downloadUrl,
                panType,
              );
              const m3u8Headers: Record<string, string> = {
                'Content-Type':
                  upstreamRes.headers['content-type'] ||
                  'application/vnd.apple.mpegurl',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
              };
              if (!res.headersSent) {
                res.writeHead(200, m3u8Headers);
                res.end(rewritten);
              }
            });
            upstreamRes.on('error', () => {
              if (!res.headersSent) {
                try {
                  res.end();
                } catch {}
              }
            });
            return;
          }

          // TS segment or other media: stream bytes through
          const respHeaders: Record<string, string> = {
            'Content-Type': upstreamRes.headers['content-type'] || 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
          };
          if (upstreamRes.headers['content-length']) {
            respHeaders['Content-Length'] = String(
              upstreamRes.headers['content-length'],
            );
          }
          if (upstreamRes.headers['content-range']) {
            respHeaders['Content-Range'] = String(
              upstreamRes.headers['content-range'],
            );
          }
          res.writeHead(status, respHeaders);
          upstreamRes.on('error', () => {
            try {
              res.end();
            } catch {}
          });
          upstreamRes.pipe(res);
        },
      );
      upstreamReq.on('error', (err) => {
        console.error(
          '[ProxyServer] streamPanDirect: upstream error:',
          err.message,
        );
        if (!res.headersSent && !clientGone) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Upstream error: ' + err.message);
        } else {
          try {
            res.end();
          } catch {}
        }
      });
      upstreamReq.end();
    } catch (e: any) {
      console.error('[ProxyServer] streamPanDirect: setup error:', e.message);
      if (!res.headersSent && !clientGone) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Proxy error: ' + e.message);
      }
    }
  }

  /**
   * Stream a direct video URL (m3u8 manifest or TS segment) through Node.js
   * with custom headers. Routes around the browser's forbidden-header
   * restrictions and TLS fingerprinting.
   *
   * For m3u8 manifests: rewrites all segment URLs to route through this same
   * endpoint so the CDN sees consistent headers on every segment request.
   *
   * For TS segments (or any non-m3u8 content): streams the bytes through
   * directly, honoring Range requests for seeking.
   */
  private async streamVideoDirect(
    upstreamUrl: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    customHeaders: Record<string, string> | null,
    isTsSegment: boolean,
  ): Promise<void> {
    const upstreamHeaders: Record<string, string> = {
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      ...(customHeaders || {}),
    };
    if (req.headers['range']) {
      upstreamHeaders['Range'] = String(req.headers['range']);
    }

    console.log(
      '[ProxyServer] streamVideoDirect:',
      isTsSegment ? '[TS]' : '[m3u8]',
      'url=',
      upstreamUrl.substring(0, 120),
      'hasRange=',
      !!req.headers['range'],
      'headerKeys=',
      customHeaders ? Object.keys(customHeaders).join(',') : '(none)',
    );

    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
    });
    req.on('error', () => {
      clientGone = true;
    });

    // Node.js http.request does NOT auto-follow 3xx redirects (unlike
    // Android okhttp). CDNs such as vd.wmvbo.com return 302 with an empty
    // body and a Location header pointing to an edge node. Without this
    // redirect loop, the proxy returns the empty 302 body to hls.js, which
    // fails with "no EXTM3U delimiter".
    const MAX_REDIRECTS = 5;
    let currentUrl = upstreamUrl;
    let redirectCount = 0;

    const makeRequest = (): void => {
      if (clientGone) return;
      try {
        const parsedUrl = new URL(currentUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const lib = isHttps ? https : http;
        const upstreamReq = lib.request(
          currentUrl,
          {
            method: 'GET',
            headers: upstreamHeaders,
            agent: isHttps ? httpsAgent : httpAgent,
          },
          (upstreamRes) => {
            if (clientGone) {
              try {
                upstreamRes.destroy();
              } catch {}
              return;
            }
            const status = upstreamRes.statusCode || 200;
            const contentType = String(
              upstreamRes.headers['content-type'] || '',
            ).toLowerCase();
            console.log(
              '[ProxyServer] streamVideoDirect: upstream status=',
              status,
              'content-type=',
              contentType,
              'content-length=',
              upstreamRes.headers['content-length'],
              'redirectCount=',
              redirectCount,
            );

            // Follow 3xx redirects. Resolve Location against currentUrl
            // (handles both absolute and relative redirects).
            if (
              (status === 301 ||
                status === 302 ||
                status === 303 ||
                status === 307 ||
                status === 308) &&
              upstreamRes.headers['location'] &&
              redirectCount < MAX_REDIRECTS
            ) {
              redirectCount++;
              const location = String(upstreamRes.headers['location']);
              let nextUrl: string;
              try {
                nextUrl = new URL(location, currentUrl).href;
              } catch {
                nextUrl = location;
              }
              console.log(
                '[ProxyServer] streamVideoDirect: following redirect ' +
                  redirectCount +
                  '/' +
                  MAX_REDIRECTS +
                  ' →',
                nextUrl.substring(0, 120),
              );
              upstreamRes.resume(); // drain redirect body
              currentUrl = nextUrl;
              makeRequest(); // recursive call
              return;
            }

            // Error responses: capture body for diagnostics
            if (status >= 400) {
              const bodyChunks: Buffer[] = [];
              upstreamRes.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
              upstreamRes.on('end', () => {
                const body = Buffer.concat(bodyChunks).toString('utf8');
                console.warn(
                  '[ProxyServer] streamVideoDirect: upstream error body (len=' +
                    body.length +
                    '):',
                  body.substring(0, 1000),
                );
                if (!res.headersSent) {
                  res.writeHead(status, {
                    'Content-Type':
                      upstreamRes.headers['content-type'] || 'text/plain',
                  });
                  res.end(body);
                }
              });
              upstreamRes.on('error', () => {
                if (!res.headersSent) {
                  try {
                    res.end();
                  } catch {}
                }
              });
              return;
            }

            // m3u8 manifest: rewrite segment URLs to route through proxy.
            // Use currentUrl (post-redirect) as the base so relative TS
            // paths resolve against the actual serving host.
            if (
              !isTsSegment &&
              (contentType.includes('mpegurl') ||
                contentType.includes('m3u8') ||
                currentUrl.toLowerCase().includes('.m3u8'))
            ) {
              const bodyChunks: Buffer[] = [];
              upstreamRes.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
              upstreamRes.on('end', () => {
                const manifest = Buffer.concat(bodyChunks).toString('utf8');
                if (!manifest.trimStart().startsWith('#EXTM3U')) {
                  console.warn(
                    '[ProxyServer] streamVideoDirect: m3u8 URL returned non-EXTM3U body (len=' +
                      manifest.length +
                      '):',
                    manifest.substring(0, 500),
                  );
                }
                const rewritten = this.rewriteM3u8Manifest(
                  manifest,
                  currentUrl,
                  customHeaders,
                );
                const respHeaders: Record<string, string> = {
                  'Content-Type':
                    upstreamRes.headers['content-type'] ||
                    'application/vnd.apple.mpegurl',
                  'Access-Control-Allow-Origin': '*',
                  'Cache-Control': 'no-cache',
                };
                if (!res.headersSent) {
                  res.writeHead(200, respHeaders);
                  res.end(rewritten);
                }
              });
              upstreamRes.on('error', () => {
                if (!res.headersSent) {
                  try {
                    res.end();
                  } catch {}
                }
              });
              return;
            }

            // TS segment or other media: stream bytes through
            const respHeaders: Record<string, string> = {
              'Content-Type':
                upstreamRes.headers['content-type'] || 'video/mp2t',
              'Accept-Ranges': 'bytes',
              'Access-Control-Allow-Origin': '*',
            };
            if (upstreamRes.headers['content-length']) {
              respHeaders['Content-Length'] = String(
                upstreamRes.headers['content-length'],
              );
            }
            if (upstreamRes.headers['content-range']) {
              respHeaders['Content-Range'] = String(
                upstreamRes.headers['content-range'],
              );
            }
            res.writeHead(status, respHeaders);
            upstreamRes.on('error', () => {
              try {
                res.end();
              } catch {}
            });
            upstreamRes.pipe(res);
          },
        );
        upstreamReq.on('error', (err) => {
          console.error(
            '[ProxyServer] streamVideoDirect: upstream error:',
            err.message,
          );
          if (!res.headersSent && !clientGone) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Upstream error: ' + err.message);
          } else {
            try {
              res.end();
            } catch {}
          }
        });
        upstreamReq.end();
      } catch (e: any) {
        console.error(
          '[ProxyServer] streamVideoDirect: setup error:',
          e.message,
        );
        if (!res.headersSent && !clientGone) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Proxy error: ' + e.message);
        }
      }
    };

    makeRequest();
  }

  /**
   * Rewrite segment URLs inside an m3u8 manifest to route through our
   * /m3u8.m3u8 proxy endpoint. This ensures the CDN sees the same headers
   * (User-Agent, Referer) on every TS segment request, not just the manifest.
   *
   * Handles both relative ("seg-1.ts") and absolute ("https://...") URLs.
   */
  private rewriteM3u8Manifest(
    manifest: string,
    baseUrl: string,
    customHeaders: Record<string, string> | null,
  ): string {
    const port = this.port;
    const headerParam = customHeaders
      ? '&header=' + encodeURIComponent(JSON.stringify(customHeaders))
      : '';
    const lines = manifest.split('\n');
    let baseOrigin = '';
    let basePath = '';
    try {
      const parsed = new URL(baseUrl);
      baseOrigin = `${parsed.protocol}//${parsed.host}`;
      basePath = parsed.pathname.substring(
        0,
        parsed.pathname.lastIndexOf('/') + 1,
      );
    } catch {}

    const rewritten: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      // Directive lines (start with #) — pass through unchanged.
      // But rewrite #EXT-X-KEY URI if present (encrypted HLS).
      if (trimmed.startsWith('#')) {
        rewritten.push(
          this.rewriteManifestDirective(
            trimmed,
            baseOrigin,
            basePath,
            port,
            headerParam,
          ),
        );
        continue;
      }
      // Empty line — pass through
      if (!trimmed) {
        rewritten.push(line);
        continue;
      }
      // Segment URL line — rewrite to go through proxy
      let absoluteUrl: string;
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        absoluteUrl = trimmed;
      } else if (trimmed.startsWith('//')) {
        absoluteUrl = baseOrigin.split('//')[0] + trimmed;
      } else if (trimmed.startsWith('/')) {
        absoluteUrl = baseOrigin + trimmed;
      } else {
        absoluteUrl = baseOrigin + basePath + trimmed;
      }
      rewritten.push(
        `http://127.0.0.1:${port}/ts?url=${encodeURIComponent(absoluteUrl)}${headerParam}`,
      );
    }
    return rewritten.join('\n');
  }

  /**
   * Rewrite m3u8 manifest for pan direct streaming (quarkDirect/ucDirect/etc).
   * Same as rewriteM3u8Manifest but routes TS segments through the pan proxy
   * endpoint so CDN requests get the correct pan-specific headers (no Cookie
   * for quark, Chrome UA, etc.).
   */
  private rewritePanM3u8Manifest(
    manifest: string,
    baseUrl: string,
    panType: string,
  ): string {
    const port = this.port;
    const lines = manifest.split('\n');
    let baseOrigin = '';
    let basePath = '';
    try {
      const parsed = new URL(baseUrl);
      baseOrigin = `${parsed.protocol}//${parsed.host}`;
      basePath = parsed.pathname.substring(
        0,
        parsed.pathname.lastIndexOf('/') + 1,
      );
    } catch {}

    const rewritten: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      // Directive lines (#EXTINF, #EXT-X-*, etc.) — pass through
      if (trimmed.startsWith('#')) {
        rewritten.push(line);
        continue;
      }
      // Empty line — pass through
      if (!trimmed) {
        rewritten.push(line);
        continue;
      }
      // Segment URL line — rewrite to go through pan proxy
      let absoluteUrl: string;
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        absoluteUrl = trimmed;
      } else if (trimmed.startsWith('//')) {
        absoluteUrl = baseOrigin.split('//')[0] + trimmed;
      } else if (trimmed.startsWith('/')) {
        absoluteUrl = baseOrigin + trimmed;
      } else {
        absoluteUrl = baseOrigin + basePath + trimmed;
      }
      rewritten.push(
        `http://127.0.0.1:${port}/proxy?do=${panType}Direct&url=${encodeURIComponent(absoluteUrl)}`,
      );
    }
    return rewritten.join('\n');
  }

  /**
   * Rewrite URI="..." inside manifest directives (#EXT-X-KEY, #EXT-X-MAP).
   * Encrypted HLS keys/segments also need to go through the proxy.
   */
  private rewriteManifestDirective(
    directive: string,
    baseOrigin: string,
    basePath: string,
    port: number,
    headerParam: string,
  ): string {
    const uriMatch = directive.match(/URI="([^"]+)"/);
    if (!uriMatch) return directive;
    const originalUri = uriMatch[1];
    let absoluteUrl: string;
    if (
      originalUri.startsWith('http://') ||
      originalUri.startsWith('https://')
    ) {
      absoluteUrl = originalUri;
    } else if (originalUri.startsWith('//')) {
      absoluteUrl = baseOrigin.split('//')[0] + originalUri;
    } else if (originalUri.startsWith('/')) {
      absoluteUrl = baseOrigin + originalUri;
    } else {
      absoluteUrl = baseOrigin + basePath + originalUri;
    }
    const proxiedUri = `http://127.0.0.1:${port}/ts?url=${encodeURIComponent(absoluteUrl)}${headerParam}`;
    return directive.replace(`URI="${originalUri}"`, `URI="${proxiedUri}"`);
  }

  /**
   * Directly proxy unknown do= values (like hxq) that spider's Proxy.proxy()
   * can't handle. Streams the URL content with custom headers (if provided).
   * Used when Init.proxyInvoke is missing from the JAR.
   */
  private async streamUnknownProxy(
    upstreamUrl: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    customHeaders: Record<string, string>,
    doType: string,
  ): Promise<void> {
    const decodedUrl = decodeURIComponent(upstreamUrl);
    console.log(
      '[ProxyServer] streamUnknownProxy: do=',
      doType,
      'decodedUrl=',
      decodedUrl.substring(0, 100) + '...',
    );

    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
      console.log(
        '[ProxyServer] streamUnknownProxy: client closed connection early for do=',
        doType,
      );
    });
    req.on('error', () => {
      clientGone = true;
      console.log(
        '[ProxyServer] streamUnknownProxy: client connection error for do=',
        doType,
      );
    });

    const u = new URL(decodedUrl);
    const isHttps = u.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const headers: Record<string, string> = {
      'User-Agent':
        customHeaders['User-Agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Connection: 'keep-alive',
    };
    // Add custom headers from spider (like Referer)
    for (const [k, v] of Object.entries(customHeaders)) {
      if (k.toLowerCase() !== 'user-agent') {
        headers[k] = v;
      }
    }
    // Add Referer if not present - critical for 51touxiang.com CDN
    // Android native method may add Referer; use origin as fallback
    if (!headers['Referer'] && !headers['referer']) {
      headers['Referer'] = u.origin + '/';
    }
    // For m3u8 files, do NOT pass Range header (m3u8 must be fetched completely)
    // Only add Range for non-m3u8 content (like TS segments)
    const urlLower = decodedUrl.toLowerCase();
    const isM3u8Request =
      urlLower.endsWith('.m3u8') || urlLower.includes('.m3u8?');
    if (!isM3u8Request) {
      const rangeHeader = req.headers['range'];
      if (rangeHeader) {
        headers['Range'] = rangeHeader as string;
      }
    }

    console.log(
      '[ProxyServer] streamUnknownProxy: requesting with headers=',
      JSON.stringify(headers),
      'isM3u8=',
      isM3u8Request,
    );

    const upstreamReq = httpModule.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        agent: isHttps ? httpsAgent : httpAgent, // 复用连接减少 TLS 握手延迟
      },
      (upstreamRes) => {
        if (clientGone) {
          try {
            upstreamRes.resume();
          } catch {}
          return;
        }
        console.log(
          '[ProxyServer] streamUnknownProxy: upstream status=',
          upstreamRes.statusCode,
          'content-type=',
          upstreamRes.headers['content-type'],
        );

        // For m3u8 content, rewrite relative paths to absolute URLs
        const contentType = upstreamRes.headers['content-type'] || '';
        const isM3u8 =
          contentType.includes('mpegurl') ||
          contentType.includes('m3u8') ||
          decodedUrl.endsWith('.m3u8');

        // Handle upstream error status codes first
        if (upstreamRes.statusCode && upstreamRes.statusCode >= 400) {
          console.error(
            '[ProxyServer] streamUnknownProxy: upstream error status=',
            upstreamRes.statusCode,
            'url=',
            decodedUrl.substring(0, 100),
          );
          // Forward the error to the player
          res.writeHead(upstreamRes.statusCode, {
            'Content-Type': upstreamRes.headers['content-type'] || 'text/plain',
            'Access-Control-Allow-Origin': '*',
          });
          upstreamRes.pipe(res);
          return;
        }

        if (isM3u8 && upstreamRes.statusCode === 200) {
          // Send response headers immediately (before reading full content)
          // to reduce latency and prevent player timeout
          res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
          });
          console.log(
            '[ProxyServer] streamUnknownProxy: headers sent for m3u8, res.headersSent=',
            res.headersSent,
          );

          // hxq source: TS URLs have auth in query string, pass through
          // unchanged so the browser fetches TS directly from CDN.
          // CDN optimization: replace slow CDN hostnames with the fastest
          // CDN selected at startup (avoids ~0.06 MB/s throttling).
          if (doType === 'hxq') {
            console.log(
              '[ProxyServer] streamUnknownProxy: hxq m3u8, rewrite to absolute CDN URLs',
            );
            const m3u8Rewriter = new M3u8Rewriter(
              decodedUrl,
              this.port,
              doType,
              customHeaders,
              true, // directCdn: output absolute CDN URLs
            );
            if (this.cdnOptimized && this.fastestCdn) {
              const cdnRewriter = new CdnRewriter(this.fastestCdn);
              console.log(
                '[ProxyServer] streamUnknownProxy: hxq m3u8 CDN rewrite enabled, target=',
                this.fastestCdn,
              );
              upstreamRes
                .pipe(m3u8Rewriter)
                .on('error', (err: Error) => {
                  console.error(
                    '[ProxyServer] streamUnknownProxy: m3u8 rewriter error:',
                    err.message,
                  );
                })
                .pipe(cdnRewriter)
                .on('error', (err: Error) => {
                  console.error(
                    '[ProxyServer] streamUnknownProxy: cdn rewriter error:',
                    err.message,
                  );
                })
                .pipe(res)
                .on('error', (err: Error) => {
                  console.error(
                    '[ProxyServer] streamUnknownProxy: response stream error:',
                    err.message,
                  );
                });
            } else {
              upstreamRes
                .pipe(m3u8Rewriter)
                .on('error', (err: Error) => {
                  console.error(
                    '[ProxyServer] streamUnknownProxy: m3u8 rewriter error:',
                    err.message,
                  );
                })
                .pipe(res)
                .on('error', (err: Error) => {
                  console.error(
                    '[ProxyServer] streamUnknownProxy: response stream error:',
                    err.message,
                  );
                });
            }
          } else {
            // Other sources: rewrite TS URLs to proxy URLs for header injection
            console.log(
              '[ProxyServer] streamUnknownProxy: creating M3u8Rewriter, do=',
              doType,
              'port=',
              this.port,
            );
            const m3u8Rewriter = new M3u8Rewriter(
              decodedUrl,
              this.port,
              doType,
              customHeaders,
            );
            upstreamRes
              .pipe(m3u8Rewriter)
              .on('error', (err: Error) => {
                console.error(
                  '[ProxyServer] streamUnknownProxy: m3u8 rewriter error:',
                  err.message,
                );
              })
              .pipe(res)
              .on('error', (err: Error) => {
                console.error(
                  '[ProxyServer] streamUnknownProxy: response stream error:',
                  err.message,
                );
              });
          }
        } else {
          // Non-m3u8 content (like TS segments) - pipe directly
          const statusCode = upstreamRes.statusCode === 206 ? 206 : 200;
          const responseHeaders: http.OutgoingHttpHeaders = {
            'Content-Type':
              upstreamRes.headers['content-type'] || 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
          };
          if (upstreamRes.headers['content-length']) {
            responseHeaders['Content-Length'] =
              upstreamRes.headers['content-length'];
          }
          if (upstreamRes.headers['content-range']) {
            responseHeaders['Content-Range'] =
              upstreamRes.headers['content-range'];
          }
          console.log(
            '[ProxyServer] streamUnknownProxy: TS segment headers sent, statusCode=',
            statusCode,
            'content-length=',
            upstreamRes.headers['content-length'],
            'content-type=',
            upstreamRes.headers['content-type'],
          );
          res.writeHead(statusCode, responseHeaders);
          upstreamRes.pipe(res).on('finish', () => {
            console.log(
              '[ProxyServer] streamUnknownProxy: TS segment pipe finished, do=',
              doType,
            );
          });
        }
      },
    );

    upstreamReq.on('error', (err) => {
      console.error(
        '[ProxyServer] streamUnknownProxy: upstream error:',
        err.message,
      );
      if (!res.headersSent && !clientGone) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Upstream error: ' + err.message);
      } else {
        try {
          res.end();
        } catch {}
      }
    });

    upstreamReq.end();
  }
}

// Singleton instance
export const proxyServer = new ProxyServer();
