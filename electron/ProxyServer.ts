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
import { jarLoader } from './JarLoader';
import { QuarkPanService } from './QuarkPanService';

type PortCallback = (port: number) => void;

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
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.0.1 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch',
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

    // Only GET /proxy is implemented (matches the spider's expectations)
    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
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

    // Other do= values → forward to spider
    if (!params['do']) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing "do" parameter');
      return;
    }

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

    // Inject cookie from the in-memory cache (set by syncCookieToJVM).
    // This bypasses the spider's SharedPreferences read path, which fails
    // to send __puus to the CDN (causing 412 Precondition Failed).
    if (site === 'quark') {
      const cookie = QuarkPanService.getSyncedCookie();
      if (cookie) {
        params['cookie'] = cookie;
      }
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
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Spider proxy returned null');
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
}

// Singleton instance
export const proxyServer = new ProxyServer();
