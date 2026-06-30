import axios from 'axios';
import type { ParseBean, PlayResult } from './models';
import { VideoParseRuler } from './VideoParseRuler';
import { AdBlocker } from './AdBlocker';
import { configParser } from './ConfigParser';

// Conditionally import BrowserWindow - only available in Electron main process.
// In renderer with nodeIntegration, require may work. Otherwise, falls back to fetch+regex.
let BrowserWindow: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  BrowserWindow = require('electron').BrowserWindow;
} catch {
  BrowserWindow = null;
}

/** Direct video URL pattern for quick bypass of parsing */
const DIRECT_VIDEO_REGEX =
  /\.(m3u8|mp4|flv|mkv|ts|mov|avi|wmv|3gp|webm|mpd|rm|rmvb|mpg|f4v|ogv|ogg|drc|m4v|asf|amv|vob)(\?.*)?$/i;
const DIRECT_VIDEO_PROTOCOL = /^(rtmp|rtsp):\/\//i;

/** Comprehensive video format regex (port of Android DefaultConfig.isVideoFormat) */
const VIDEO_FORMAT_REGEX =
  /http((?!http).){20,}?\.(m3u8|mp4|flv|avi|mkv|rm|wmv|mpg)\?.*|http((?!http).){20,}\.(m3u8|mp4|flv|avi|mkv|rm|wmv|mpg)|http((?!http).)*?video\/tos*|http((?!http).){20,}?\/m3u8\?pt=m3u8.*|http((?!http).)*?default\.ixigua\.com\/.*|http((?!http).)*?dycdn-tos\.pstatp[^\?]*|http.*?\/player\/m3u8play\.php\?url=.*|http.*?\/player\/.*?[pP]lay\.php\?url=.*|http.*?\/playlist\/m3u8\/\?vid=.*|http.*?\.php\?type=m3u8&.*|http.*?\/download\.aspx\?.*|http.*?\/api\/up_api\.php\?.*|https.*?\.66yk\.cn.*|http((?!http).)*?netease\.com\/file\/.*/i;

/** Blacklisted URL substrings that indicate non-video content */
const VIDEO_BLACKLIST = [
  '.js',
  '.css',
  '.jpg',
  '.png',
  '.gif',
  '.ico',
  'rl=',
  '.html',
  '=http',
];

/**
 * ParseEngine - Core VIP URL resolution engine.
 *
 * Parse types (from Android TVBox):
 * - Type 0: Sniffer - Use Electron BrowserWindow to load page and intercept video URL requests
 * - Type 1: JSON API - GET parse.url + rawUrl, expect {url, header} response
 * - Type 2: JSON Extension - Like type 1 but append cat_ext={base64(parse.ext)} as query param
 * - Type 3: Aggregate - Try ALL parses concurrently, return first successful result
 * - Type 4: Super Parse - Hard-coded aggregate of ALL available parses (inserted at index 0)
 */
export class ParseEngine {
  /**
   * Check if a PlayResult needs VIP parsing.
   * - parse === 1 means explicit VIP flag
   * - URL domain matches any VIP parse flag from config
   */
  static needsParse(playResult: PlayResult): boolean {
    if (playResult.parse === 1) return true;

    const vipFlags = ParseEngine.getVipParseFlags();
    if (vipFlags.length > 0 && playResult.url) {
      const urlLower = playResult.url.toLowerCase();
      for (const flag of vipFlags) {
        if (urlLower.includes(flag.toLowerCase())) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Resolve a raw URL using VIP parses.
   * @param rawUrl The video URL that needs parsing
   * @param playHeader JSON string of headers from the play result
   * @param vipFlags VIP parse flags from config
   * @param selectedParse Optional user-selected parse to use exclusively
   * @returns Resolved direct video URL
   */
  static async resolve(
    rawUrl: string,
    playHeader: string,
    vipFlags: string[],
    selectedParse?: ParseBean,
    currentFlag?: string,
    clickSelector?: string,
  ): Promise<string> {
    // If already a direct video URL, no parse needed
    if (ParseEngine.isDirectVideo(rawUrl)) {
      return rawUrl;
    }

    const parses = ParseEngine.getParses();

    if (selectedParse) {
      const result = await ParseEngine.tryParse(
        selectedParse,
        rawUrl,
        clickSelector,
      );
      if (result) return result;
    } else if (parses.length > 0) {
      for (const parse of parses) {
        if (parse.type === 3 || parse.type === 4) {
          const flagFilter =
            parse.type === 4 && currentFlag ? [currentFlag] : undefined;
          const result = await ParseEngine.aggregateParse(
            parses,
            rawUrl,
            flagFilter,
            clickSelector,
          );
          if (result) return result;
          continue;
        }
        const result = await ParseEngine.tryParse(parse, rawUrl, clickSelector);
        if (result) return result;
      }
    }

    // Fallback: try direct sniffing on the raw URL
    try {
      const sniffed = await ParseEngine.sniffUrl(rawUrl, clickSelector);
      if (sniffed) return sniffed;
    } catch {
      // sniffing failed, fall through
    }

    // Last resort: return the raw URL itself
    return rawUrl;
  }

  /**
   * Check if a URL is already a direct playable video URL.
   */
  static isDirectVideo(url: string): boolean {
    if (DIRECT_VIDEO_PROTOCOL.test(url)) return true;
    if (DIRECT_VIDEO_REGEX.test(url)) return true;
    // Also check via the comprehensive video format regex
    if (VIDEO_FORMAT_REGEX.test(url)) {
      for (const black of VIDEO_BLACKLIST) {
        if (url.includes(black)) return false;
      }
      return true;
    }
    return false;
  }

  // --- Private helpers ---

  private static getVipParseFlags(): string[] {
    return configParser.getVipParseFlags();
  }

  private static getParses(): ParseBean[] {
    return configParser.getParses();
  }

  /**
   * Try a single parse to resolve a URL.
   */
  private static async tryParse(
    parse: ParseBean,
    rawUrl: string,
    clickSelector?: string,
  ): Promise<string | null> {
    try {
      switch (parse.type) {
        case 0:
          return await ParseEngine.snifferParse(parse, rawUrl, clickSelector);
        case 1:
          return await ParseEngine.jsonApiParse(parse, rawUrl);
        case 2:
          return await ParseEngine.jsonExtParse(parse, rawUrl);
        case 3:
        case 4:
          return null;
        default:
          return null;
      }
    } catch (e) {
      console.warn(`[ParseEngine] Parse [${parse.name}] failed:`, e);
      return null;
    }
  }

  /**
   * Type 0 - Sniffer parse.
   * Use Electron BrowserWindow to load the parse URL and intercept video requests.
   * Falls back to fetch + regex if BrowserWindow is unavailable.
   */
  private static async snifferParse(
    parse: ParseBean,
    rawUrl: string,
    clickSelector?: string,
  ): Promise<string | null> {
    const targetUrl = parse.url + rawUrl;
    return ParseEngine.sniffUrl(targetUrl, clickSelector);
  }

  /**
   * Sniff a URL for video content using BrowserWindow or fetch fallback.
   */
  private static async sniffUrl(
    url: string,
    clickSelector?: string,
  ): Promise<string | null> {
    if (BrowserWindow) {
      return ParseEngine.sniffWithBrowser(url, clickSelector);
    }
    return ParseEngine.sniffWithFetch(url);
  }

  /**
   * Use a hidden Electron BrowserWindow to intercept video URL requests.
   */
  private static sniffWithBrowser(
    url: string,
    clickSelector?: string,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 800,
        height: 600,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false,
          images: false,
        },
      });

      let resolved = false;

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          if (!win.isDestroyed()) win.destroy();
          resolve(null);
        }
      };

      // Intercept network requests
      win.webContents.session.webRequest.onBeforeRequest(
        (details: any, callback: any) => {
          const reqUrl = details.url;

          if (AdBlocker.isAd(reqUrl)) {
            return callback({ cancel: true });
          }

          if (
            VideoParseRuler.isVideoUrl(url, reqUrl) &&
            !VideoParseRuler.isFiltered(url, reqUrl)
          ) {
            if (!resolved) {
              resolved = true;
              callback({ cancel: true });
              if (!win.isDestroyed()) win.destroy();
              resolve(reqUrl);
              return;
            }
          }
          callback({ cancel: false });
        },
      );

      // Timeout after 15 seconds
      setTimeout(cleanup, 15000);

      win.webContents.on('did-fail-load', () => {
        cleanup();
      });

      // Execute click selector and inject scripts when page loads
      win.webContents.on('dom-ready', () => {
        try {
          // Inject scripts from VideoParseRuler for the page's host
          const pageHost = new URL(url).hostname;
          const script = VideoParseRuler.getScript(pageHost);
          if (script) {
            win.webContents.executeJavaScript(script).catch(() => {});
          }

          // Execute clickSelector if provided
          if (clickSelector) {
            // Format: "prefix;selector" or just "selector"
            const parts = clickSelector.split(';');
            if (parts.length === 2) {
              // Only click if URL contains the prefix
              if (url.includes(parts[0])) {
                win.webContents
                  .executeJavaScript(
                    `document.querySelector('${parts[1]}')?.click()`,
                  )
                  .catch(() => {});
              }
            } else {
              win.webContents
                .executeJavaScript(
                  `document.querySelector('${clickSelector}')?.click()`,
                )
                .catch(() => {});
            }
          }
        } catch {
          /* ignore script injection errors */
        }
      });

      win.loadURL(url, {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
      });
    });
  }

  /**
   * Fallback sniffing via fetch + regex when BrowserWindow is unavailable.
   */
  private static async sniffWithFetch(url: string): Promise<string | null> {
    try {
      const { data } = await axios.get(url, {
        timeout: 10000,
      });

      // Try to find video URLs in the response content
      const content = typeof data === 'string' ? data : JSON.stringify(data);
      const match = content.match(
        /https?:\/\/[^\s"'<>]+?\.(m3u8|mp4|flv|mkv)(\?[^\s"'<>]*)?/i,
      );
      if (match) {
        return match[0];
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Type 1 - JSON API parse.
   * GET parse.url + rawUrl, expect {url, header} or {data:{url}} response.
   */
  private static async jsonApiParse(
    parse: ParseBean,
    rawUrl: string,
  ): Promise<string | null> {
    const reqUrl = parse.url + rawUrl;
    const { data } = await axios.get(reqUrl, { timeout: 8000 });

    const resultUrl = ParseEngine.extractUrlFromJson(data, rawUrl);
    if (
      resultUrl &&
      resultUrl !== rawUrl &&
      ParseEngine.isDirectVideo(resultUrl)
    ) {
      return resultUrl;
    }
    return resultUrl;
  }

  /**
   * Type 2 - JSON Extension parse.
   * Like type 1 but append cat_ext={base64(parse.ext)} as a query parameter.
   * Also extract custom headers from ext.header.
   */
  private static async jsonExtParse(
    parse: ParseBean,
    rawUrl: string,
  ): Promise<string | null> {
    let reqUrl = parse.url;
    const headers: Record<string, string> = {};

    if (parse.ext) {
      try {
        const extObj = JSON.parse(parse.ext);
        // Encode the ext JSON as base64 and add as cat_ext query param
        const extBase64 = Buffer.from(parse.ext, 'utf-8').toString('base64');

        // Insert cat_ext before any existing query params
        const qIdx = reqUrl.indexOf('?');
        if (qIdx > 0) {
          reqUrl =
            reqUrl.substring(0, qIdx + 1) +
            'cat_ext=' +
            encodeURIComponent(extBase64) +
            '&' +
            reqUrl.substring(qIdx + 1);
        } else {
          reqUrl += '?cat_ext=' + encodeURIComponent(extBase64);
        }

        // Extract custom headers from ext.header
        if (extObj.header && typeof extObj.header === 'object') {
          for (const [key, value] of Object.entries(extObj.header)) {
            headers[key] = String(value);
          }
        }
      } catch {
        // ext is not valid JSON, skip extension logic
      }
    }

    const { data } = await axios.get(reqUrl + rawUrl, {
      timeout: 8000,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });

    const resultUrl = ParseEngine.extractUrlFromJson(data, rawUrl);
    if (
      resultUrl &&
      resultUrl !== rawUrl &&
      ParseEngine.isDirectVideo(resultUrl)
    ) {
      return resultUrl;
    }
    return resultUrl;
  }

  /**
   * Type 3/4 - Aggregate parse.
   * Try ALL non-aggregate parses concurrently, return first successful result.
   * Mirrors Android JsonParallel behavior.
   */
  private static async aggregateParse(
    parses: ParseBean[],
    rawUrl: string,
    flagFilter?: string[],
    clickSelector?: string,
  ): Promise<string | null> {
    let candidates = parses.filter((p) => p.type !== 3 && p.type !== 4);

    if (flagFilter && flagFilter.length > 0) {
      const flagged = candidates.filter((p) => {
        if (!p.ext) return true;
        try {
          const extObj = JSON.parse(p.ext);
          if (extObj.flag && Array.isArray(extObj.flag)) {
            return extObj.flag.some((f: string) => flagFilter.includes(f));
          }
        } catch {
          /* ext is not JSON, include */
        }
        return true;
      });
      if (flagged.length > 0) candidates = flagged;
    }

    if (candidates.length === 0) return null;

    const promises = candidates.map((parse) =>
      ParseEngine.tryParse(parse, rawUrl, clickSelector).then((result) => {
        if (result) return result;
        throw new Error(`Parse [${parse.name}] returned no result`);
      }),
    );

    try {
      const result = await ParseEngine.promiseFirstSuccess(promises);
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Race multiple promises and resolve with the first one that succeeds.
   * Rejects only if ALL promises reject.
   */
  private static promiseFirstSuccess<T>(promises: Promise<T>[]): Promise<T> {
    return new Promise((resolve, reject) => {
      if (promises.length === 0) {
        reject(new Error('No promises to race'));
        return;
      }

      let settled = false;
      let rejectedCount = 0;
      const total = promises.length;

      for (const promise of promises) {
        promise
          .then((result) => {
            if (!settled) {
              settled = true;
              resolve(result);
            }
          })
          .catch(() => {
            rejectedCount++;
            if (rejectedCount === total && !settled) {
              reject(new Error('All parse attempts failed'));
            }
          });
      }
    });
  }

  /**
   * Extract a video URL from a JSON parse API response.
   * Handles both {url: "..."} and {data: {url: "..."}} formats.
   * Also handles URL normalization (adding https: prefix for // URLs).
   */
  private static extractUrlFromJson(
    data: any,
    inputUrl: string,
  ): string | null {
    try {
      const json = typeof data === 'string' ? JSON.parse(data) : data;
      let url: string | undefined;

      if (json.data && json.data.url) {
        url = json.data.url;
      } else if (json.url) {
        url = json.url;
      }

      if (!url) return null;

      // Normalize: // prefix -> https:
      if (url.startsWith('//')) {
        url = 'https:' + url;
      }

      // Must be a valid HTTP(S) URL
      if (!url.startsWith('http')) return null;

      // If the resolved URL equals the input, verify it's actually a video format
      if (url === inputUrl && !ParseEngine.isDirectVideo(url)) {
        return null;
      }

      return url;
    } catch {
      return null;
    }
  }
}
