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
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { jarLoader } from './JarLoader';
import { QuarkPanService } from './QuarkPanService';
import { UCPanService } from './UCPanService';
import { BaiduPanService } from './BaiduPanService';

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

  constructor(
    decodedUrl: string,
    port: number,
    doType: string,
    customHeaders: Record<string, string>,
  ) {
    // Don't set encoding - we want to output Buffer, not string
    // decodeStrings: true converts input Buffer to string for us
    super({ decodeStrings: true });
    this.port = port;
    this.doType = doType;
    this.customHeaders = customHeaders;
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
    if (line.match(/\.(ts|m3u8|m4s|mp4|key)$/i)) {
      let fullUrl: string;

      // Already absolute URL → rewrite to proxy URL with correct UA
      if (line.startsWith('http://') || line.startsWith('https://')) {
        fullUrl = line + this.queryPart;
      } else if (line.startsWith('/')) {
        // Absolute path (starts with /)
        fullUrl = this.baseOrigin + line + this.queryPart;
      } else {
        // Relative path
        fullUrl = this.basePath + line + this.queryPart;
      }

      // Encode URL and headers
      const encoded = encodeURIComponent(fullUrl);
      let proxyUrl = `http://127.0.0.1:${this.port}/proxy?do=${this.doType}&url=${encoded}`;

      // Add custom headers to URL params (for TS segments that need specific UA)
      if (this.customHeaders && Object.keys(this.customHeaders).length > 0) {
        const headerJson = JSON.stringify(this.customHeaders);
        proxyUrl += `&header=${encodeURIComponent(headerJson)}`;
      }

      // Debug: log first few rewrites (FULL URL, not truncated)
      if (this.rewriteCount < 3) {
        console.log('[M3u8Rewriter] rewriteLine #' + this.rewriteCount + ':');
        console.log('  original line (full):', line);
        console.log('  fullUrl:', fullUrl);
        console.log('  proxyUrl:', proxyUrl);
        this.rewriteCount++;
      }

      // Debug: log the first chunk's raw content to see the m3u8 structure
      if (!this.loggedFirstChunk && line.startsWith('#EXT')) {
        console.log('[M3u8Rewriter] First EXT line:', line);
        this.loggedFirstChunk = true;
      }

      return proxyUrl;
    }

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
   * Start the server. Tries ports 9978-9999 in order.
   * Resolves with the actual port in use.
   */
  start(): Promise<number> {
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
      void this.streamPanDirect(downloadUrl, req, res, panType);
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
      // This happens when:
      // 1. spider.proxyLocal() not implemented or returns null
      // 2. Proxy.proxy() fails due to missing DexNative JNI library
      console.log(
        '[ProxyServer] invokeSpiderProxy: spider methods failed, falling back to direct proxy for do=',
        params['do'],
      );

      const upstreamUrl = params['url'];
      if (upstreamUrl) {
        // Extract custom headers from params if present
        let customHeaders: Record<string, string> = {};
        try {
          const headerStr = params['header'];
          if (headerStr) {
            customHeaders = JSON.parse(headerStr);
          }
        } catch {}

        // Add injected headers (referer, user-agent, cookie)
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

      // No fallback available
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Spider proxy returned null and no URL available for fallback');
      }
      return;
    }

    const { status, mime, stream, headers } = result;
    const effectiveMime = this.resolveVideoMime(mime, params);

    const upstreamUrl = params['url'] || '';
    const site = params['site'];
    const totalLength = upstreamUrl
      ? await this.fetchContentLength(upstreamUrl, site)
      : -1;

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
      Cookie: cookie,
      'User-Agent': userAgent,
      Referer: referer,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
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
      `streamPanDirect REQ_HEADERS=${JSON.stringify({ ...upstreamHeaders, Cookie: `<${cookie.length} bytes>` })} clientHeaders=${JSON.stringify(req.headers)}`,
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
            upstreamRes.on('end', () => {
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
          const respHeaders: Record<string, string> = {
            'Content-Type': upstreamRes.headers['content-type'] || 'video/mp4',
            'Accept-Ranges': 'bytes',
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
          // 206 (Partial Content) for Range requests; 200 otherwise.
          // Browsers require 206 + Content-Range to seek.
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

          // Use Transform Stream to rewrite m3u8 line by line while streaming
          // This mirrors Android's chunked response behavior
          console.log(
            '[ProxyServer] streamUnknownProxy: creating M3u8Rewriter for streaming rewrite, do=',
            doType,
            'port=',
            this.port,
            'customHeaders=',
            JSON.stringify(customHeaders),
          );

          const m3u8Rewriter = new M3u8Rewriter(
            decodedUrl,
            this.port,
            doType,
            customHeaders,
          );

          // Pipeline: upstreamRes → M3u8Rewriter → res
          // (reads chunks, rewrites line by line, pushes immediately)
          console.log('[ProxyServer] streamUnknownProxy: starting pipe chain');
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
            })
            .on('finish', () => {
              console.log(
                '[ProxyServer] streamUnknownProxy: pipe chain finished for do=',
                doType,
              );
            });
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
