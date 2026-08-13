import CryptoJS from 'crypto-js';
import type {
  SourceBean,
  ParseBean,
  TVBoxConfig,
  ParseRule,
  LiveChannelGroup,
  LiveChannelItem,
  IJKCodeGroup,
} from './models';

// ---------- Constants ----------

// Renderer-side LocalProxyServer port. It handles do=js/py/live/go/cache,
// /file, /doh and /m3u8 (JS/Python spiders + live). JAR proxy execution no
// longer runs here — it lives on the Android side, reached via port 19978
// (adb forward → emulator's NanoHTTPD :9978).
const RENDERER_PROXY_PORT = 19980;
const ANDROID_PROXY_URL = 'http://127.0.0.1:19978';

let proxyPort: number = RENDERER_PROXY_PORT;

/** Get the renderer LocalProxyServer URL (e.g. "http://127.0.0.1:19980"). */
export function getLocalProxy(): string {
  return `http://127.0.0.1:${proxyPort}`;
}

/** Update the renderer LocalProxyServer port (called after it starts). */
export function setLocalProxyPort(port: number): void {
  if (typeof port === 'number' && port > 0 && port !== proxyPort) {
    console.log(`[ConfigParser] local proxy port updated: ${proxyPort} → ${port}`);
    proxyPort = port;
  }
}

// Backward-compatible alias for code that still references LOCAL_PROXY.
// Use a getter so the current port is always resolved at call time.
function LOCAL_PROXY(): string {
  return getLocalProxy();
}

/**
 * Android Spider API base URL. Windows: http://127.0.0.1:19978 (adb forward →
 * emulator NanoHTTPD :9978). Mac/Linux users set their own runtime address in
 * Settings (stored under `tvbox_spider_api_url`).
 */
export function getSpiderApiBaseUrl(): string {
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem('tvbox_spider_api_url');
    if (stored && stored.trim()) return stored.trim().replace(/\/+$/, '');
  }
  return ANDROID_PROXY_URL;
}

export function setSpiderApiBaseUrl(url: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('tvbox_spider_api_url', url.trim().replace(/\/+$/, ''));
  }
}

// Electron IPC bridge - available in renderer with contextIsolation=false
declare global {
  interface Window {
    electronIPC?: {
      invoke: (channel: string, ...args: any[]) => Promise<any>;
      on?: (channel: string, listener: (...args: any[]) => void) => () => void;
    };
  }
}

function getIPC(): Window['electronIPC'] {
  if (typeof window !== 'undefined' && window.electronIPC) {
    return window.electronIPC;
  }
  try {
    const { ipcRenderer } = require('electron');
    return {
      invoke: (channel: string, ...args: any[]) =>
        ipcRenderer.invoke(channel, ...args),
      on: (channel: string, listener: (...args: any[]) => void) => {
        const wrapped = (_e: any, ...args: any[]) => listener(...args);
        ipcRenderer.on(channel, wrapped);
        return () => ipcRenderer.removeListener(channel, wrapped);
      },
    };
  } catch {
    return undefined;
  }
}

const DEFAULT_ADS: string[] = [
  'mimg.0c1q0l.cn',
  'www.googletagmanager.com',
  'www.google-analytics.com',
  'mc.usihnbcq.cn',
  'mg.g1mm3d.cn',
  'mscs.svaeuzh.cn',
  'cnzz.hhttm.top',
  'tp.vinuxhome.com',
  'cnzz.mmstat.com',
  'www.baihuillq.com',
  's23.cnzz.com',
  'z3.cnzz.com',
  'c.cnzz.com',
  'stj.v1vo.top',
  'z12.cnzz.com',
  'img.mosflower.cn',
  'tips.gamevvip.com',
  'ehwe.yhdtns.com',
  'xdn.cqqc3.com',
  'www.jixunkyy.cn',
  'sp.chemacid.cn',
  'hm.baidu.com',
  's9.cnzz.com',
  'z6.cnzz.com',
  'um.cavuc.com',
  'mav.mavuz.com',
  'wofwk.aoidf3.com',
  'z5.cnzz.com',
  'xc.hubeijieshikj.cn',
  'tj.tianwenhu.com',
  'xg.gars57.cn',
  'k.jinxiuzhilv.com',
  'cdn.bootcss.com',
  'ppl.xunzhuo123.com',
  'xomk.jiangjunmh.top',
  'img.xunzhuo123.com',
  'z1.cnzz.com',
  's13.cnzz.com',
  'xg.huataisangao.cn',
  'z7.cnzz.com',
  'xg.huataisangao.cn',
  'z2.cnzz.com',
  's96.cnzz.com',
  'q11.cnzz.com',
  'thy.dacedsfa.cn',
  'xg.whsbpw.cn',
  's19.cnzz.com',
  'z8.cnzz.com',
  's4.cnzz.com',
  'f5w.as12df.top',
  'ae01.alicdn.com',
  'www.92424.cn',
  'k.wudejia.com',
  'vivovip.mmszxc.top',
  'qiu.xixiqiu.com',
  'cdnjs.hnfenxun.com',
  'cms.qdwght.com',
];

const DEFAULT_IJK: IJKCodeGroup[] = [
  {
    group: '软解码',
    options: [
      { name: 'opensles', category: 4, value: '0' },
      { name: 'overlay-format', category: 4, value: '842225234' },
      { name: 'framedrop', category: 4, value: '0' },
      { name: 'soundtouch', category: 4, value: '1' },
      { name: 'start-on-prepared', category: 4, value: '1' },
      { name: 'http-detect-rangeupport', category: 1, value: '0' },
      { name: 'fflags', category: 1, value: 'fastseek' },
      { name: 'skip_loop_filter', category: 2, value: '48' },
      { name: 'reconnect', category: 4, value: '1' },
      { name: 'enable-accurate-seek', category: 4, value: '0' },
      { name: 'mediacodec', category: 4, value: '0' },
      { name: 'mediacodec-auto-rotate', category: 4, value: '0' },
      { name: 'mediacodec-handle-resolution-change', category: 4, value: '0' },
      { name: 'mediacodec-hevc', category: 4, value: '0' },
      { name: 'dns_cache_timeout', category: 1, value: '600000000' },
    ],
  },
  {
    group: '硬解码',
    options: [
      { name: 'opensles', category: 4, value: '0' },
      { name: 'overlay-format', category: 4, value: '842225234' },
      { name: 'framedrop', category: 4, value: '0' },
      { name: 'soundtouch', category: 4, value: '1' },
      { name: 'start-on-prepared', category: 4, value: '1' },
      { name: 'http-detect-rangeupport', category: 1, value: '0' },
      { name: 'fflags', category: 1, value: 'fastseek' },
      { name: 'skip_loop_filter', category: 2, value: '48' },
      { name: 'reconnect', category: 4, value: '1' },
      { name: 'enable-accurate-seek', category: 4, value: '0' },
      { name: 'mediacodec', category: 4, value: '1' },
      { name: 'mediacodec-auto-rotate', category: 4, value: '1' },
      { name: 'mediacodec-handle-resolution-change', category: 4, value: '1' },
      { name: 'mediacodec-hevc', category: 4, value: '1' },
      { name: 'dns_cache_timeout', category: 1, value: '600000000' },
    ],
  },
];

// ---------- Utility Functions ----------

function computeMd5(str: string): string {
  return CryptoJS.MD5(str).toString();
}

function rightPadding(str: string, pad: string, len: number): string {
  const trimmed = str.trim();
  if (trimmed.length > len) return trimmed.substring(0, len);
  if (trimmed.length === len) return trimmed;
  return trimmed + pad.repeat(len - trimmed.length);
}

function isJsonString(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

function safeGetString(obj: any, key: string, defaultVal: string): string {
  try {
    if (
      obj != null &&
      key in obj &&
      obj[key] !== undefined &&
      obj[key] !== null
    ) {
      const val = obj[key];
      if (typeof val === 'object') return JSON.stringify(val);
      return String(val).trim();
    }
  } catch {
    /* return default */
  }
  return defaultVal;
}

function safeGetInt(obj: any, key: string, defaultVal: number): number {
  try {
    if (
      obj != null &&
      key in obj &&
      obj[key] !== undefined &&
      obj[key] !== null
    ) {
      const n = Number(obj[key]);
      return Number.isNaN(n) ? defaultVal : n;
    }
  } catch {
    /* return default */
  }
  return defaultVal;
}

function safeGetStringList(obj: any, key: string): string[] {
  const result: string[] = [];
  try {
    if (
      obj != null &&
      key in obj &&
      obj[key] !== undefined &&
      obj[key] !== null
    ) {
      const val = obj[key];
      if (Array.isArray(val)) {
        for (const item of val) result.push(String(item));
      } else {
        result.push(String(val));
      }
    }
  } catch {
    /* return empty */
  }
  return result;
}

/** Convert hex string to a UTF-8 decoded string (mirrors Android AES.toBytes then new String) */
function hexToUtf8String(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/** M3U8.isAd equivalent - check if a regex string represents an ad marker */
function m3u8IsAd(regex: string): boolean {
  if (regex.includes('#EXT-X-DISCONTINUITY')) return true;
  if (regex.includes('#EXTINF')) return true;
  if (regex.includes('#EXT-X-ENDLIST')) return true;
  if (regex.includes('#EXT-X-KEY')) return true;
  try {
    if (parseFloat(regex) !== 0) return true;
  } catch {
    /* not a number */
  }
  return false;
}

// ---------- URL / Content Helpers ----------

/** Convert clan:// URL to http:// address */
function clanToAddress(clanUrl: string): string {
  if (clanUrl.startsWith('clan://localhost/')) {
    return clanUrl.replace('clan://localhost/', LOCAL_PROXY() + '/file/');
  }
  const link = clanUrl.substring(7); // strip "clan://"
  const slashIdx = link.indexOf('/');
  return (
    'http://' +
    link.substring(0, slashIdx) +
    '/file/' +
    link.substring(slashIdx + 1)
  );
}

/** Replace clan:// references in content with the actual base URL derived from a clan HTTP URL */
function clanContentFix(clanHttpUrl: string, content: string): string {
  const fix = clanHttpUrl.substring(0, clanHttpUrl.indexOf('/file/') + 6);
  return content.replace(/clan:\/\//g, fix);
}

/** Fix relative ./ paths in config content by replacing with the base URL directory */
function fixContentPath(url: string, content: string): string {
  if (!content.includes('"./')) return content;
  let fixedUrl = url.replace('file://', 'clan://localhost/');
  if (!fixedUrl.startsWith('http') && !fixedUrl.startsWith('clan://')) {
    fixedUrl = 'http://' + fixedUrl;
  }
  if (fixedUrl.startsWith('clan://')) fixedUrl = clanToAddress(fixedUrl);
  const base = fixedUrl.substring(0, fixedUrl.lastIndexOf('/') + 1);
  return content.replace(/\.\//g, base);
}

/**
 * Replace proxy:// with the Android JAR proxy URL (mirrors Android
 * DefaultConfig.checkReplaceProxy).
 *
 * JAR spiders run inside the MuMu emulator, where Proxy.set(9978) makes them
 * emit URLs like `http://127.0.0.1:9978/proxy?do=hxq&...` (or -1 on probe
 * failure). The browser cannot reach the emulator's loopback, so these are
 * rewritten to `http://127.0.0.1:19978/proxy?...` — the adb forward that maps
 * to the emulator's NanoHTTPD :9978.
 *
 * Renderer-constructed URLs (JsSpider do=js, LiveParser do=live, ...) point
 * at the LocalProxyServer on port 19980 and are left untouched. URLs already
 * pointing at 19978 with do=js/live/py/go/cache are legacy constructions from
 * the old single-port scheme and get moved to 19980.
 */
export function checkReplaceProxy(url: string): string {
  if (url.startsWith('proxy://')) {
    return url.replace('proxy://', ANDROID_PROXY_URL + '/proxy?');
  }
  // Rewrite http(s)://127.0.0.1:<port>/proxy?... → appropriate local target.
  // The spider's Proxy.getUrl() constructs URLs like
  //   http://127.0.0.1:<port>/proxy?do=hxq&url=...
  // where <port> is what Proxy.a() probed inside the emulator (often -1 on
  // probe failure, or 9978 when it found the spider's own HTTP server).
  // Port pattern allows optional minus sign to handle the -1 sentinel.
  const proxyHostMatch = url.match(
    /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::-?\d+)?\/proxy\?/,
  );
  if (proxyHostMatch) {
    const portMatch = url.match(
      /^https?:\/\/(?:127\.0\.0\.1|localhost):(-?\d+)\/proxy\?/,
    );
    const port = portMatch ? parseInt(portMatch[1], 10) : null;
    // Android JAR probe ports (9978-9999) or the -1 sentinel → Android proxy.
    if (port !== null && (port === -1 || (port >= 9978 && port <= 9999))) {
      return url.replace(proxyHostMatch[0], ANDROID_PROXY_URL + '/proxy?');
    }
    // Old renderer-LocalProxyServer URL (port 19978) with js/live/py/go/cache
    // → new LocalProxyServer port. The Android API lives on 19978 now.
    if (port === 19978) {
      return url.replace(proxyHostMatch[0], LOCAL_PROXY() + '/proxy?');
    }
    // Port 19980 (current LocalProxyServer) — leave as-is.
    if (port === RENDERER_PROXY_PORT) {
      return url;
    }
  }
  return url;
}

/** Base64 URL-safe encode (matches Android Base64.URL_SAFE | NO_WRAP) */
function base64UrlEncode(str: string): string {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Base64 URL-safe decode */
function base64UrlDecode(str: string): string {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return decodeURIComponent(escape(atob(s)));
}

// ---------- Lenient JSON Parsing ----------
// Many TVBox configs contain JS comments, unescaped control characters,
// and trailing commas that strict JSON.parse rejects. These helpers
// progressively clean the text until it parses.

/** Escape unescaped control characters (0x00-0x1F) inside JSON string literals. */
function escapeControlCharsInStrings(text: string): string {
  let result = '';
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      if (c === '\\' && i + 1 < text.length) {
        result += c + text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        inString = false;
        result += c;
        i++;
        continue;
      }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        if (code === 0x0a) result += '\\n';
        else if (code === 0x0d) result += '\\r';
        else if (code === 0x09) result += '\\t';
        else result += '\\u' + code.toString(16).padStart(4, '0');
        i++;
        continue;
      }
      result += c;
      i++;
    } else {
      if (c === '"') inString = true;
      result += c;
      i++;
    }
  }
  return result;
}

/** Strip JS // line comments and /* block comments while respecting string literals. */
function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let stringChar = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      result += c;
      if (c === '\\' && i + 1 < text.length) {
        result += next;
        i += 2;
        continue;
      }
      if (c === stringChar) inString = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      result += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    result += c;
    i++;
  }
  return result;
}

/** Remove trailing commas before } or ] (e.g., {"a":1,} → {"a":1}). */
function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([\]}])/g, '$1');
}

/** Try to parse JSON with progressively more lenient preprocessing. */
function lenientJsonParse(text: string): any | null {
  // Stage 1: direct
  try {
    return JSON.parse(text);
  } catch {
    /* try next */
  }
  // Stage 2: strip comments
  try {
    return JSON.parse(stripJsonComments(text));
  } catch {
    /* try next */
  }
  // Stage 3: strip comments + escape control chars
  try {
    return JSON.parse(escapeControlCharsInStrings(stripJsonComments(text)));
  } catch {
    /* try next */
  }
  // Stage 4: strip comments + escape control chars + remove trailing commas
  try {
    return JSON.parse(
      removeTrailingCommas(
        escapeControlCharsInStrings(stripJsonComments(text)),
      ),
    );
  } catch {
    /* give up */
  }
  return null;
}

/**
 * Decode a base64 string to UTF-8 text. Tries standard base64 first, then
 * URL-safe variant.
 */
function base64ToText(b64: string): string {
  try {
    return atob(b64);
  } catch {
    try {
      return base64UrlDecode(b64);
    } catch {
      return '';
    }
  }
}

/**
 * Try to extract a config JSON from raw bytes. Handles:
 *  1. Direct lenient JSON
 *  2. [A-Za-z0-9]{8}** prefix → base64 decode
 *  3. JPEG steganography (data after FFD8...FFD9)
 *  4. PNG steganography (data after IEND)
 *  5. WebP steganography (data after RIFF container)
 * Returns the decoded text (not yet parsed) or null.
 */
function tryExtractConfig(bytes: Uint8Array): string | null {
  // Convert to text for non-binary patterns. Use latin1 to preserve byte values
  // for steganography scans, then re-encode as utf8 for actual JSON.
  let text = '';
  for (let i = 0; i < bytes.length; i++) {
    text += String.fromCharCode(bytes[i]);
  }

  // 1. Direct lenient JSON (try utf8 decode first)
  const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (lenientJsonParse(utf8Text)) {
    return utf8Text;
  }

  // 2. [A-Za-z0-9]{8}** pattern → base64 decode
  // Some configs use an 8-char alphanumeric prefix (may include digits,
  // e.g. "et9lLZSr") followed by "**" then base64 JSON.
  // The regex matches the LAST 8 alphanumeric chars before "**", so it works
  // for both 8-char prefixes and longer ones.
  const pattern = /[A-Za-z0-9]{8}\*\*/;
  const patternMatch = pattern.exec(utf8Text);
  if (patternMatch) {
    const b64 = utf8Text.substring(patternMatch.index + 10);
    const decoded = base64ToText(b64);
    if (decoded && lenientJsonParse(decoded)) {
      return decoded;
    }
  }

  // 3. JPEG steganography: data after FFD8...FFD9 markers
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Find FFD9 (end-of-image marker)
    for (let i = 2; i < bytes.length - 1; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
        const after = new TextDecoder('utf-8', { fatal: false }).decode(
          bytes.slice(i + 2),
        );
        // Try pattern first (饭太硬 uses this)
        const pm = pattern.exec(after);
        if (pm) {
          const b64 = after.substring(pm.index + 10);
          const decoded = base64ToText(b64);
          if (decoded && lenientJsonParse(decoded)) {
            return decoded;
          }
        }
        // Try direct lenient JSON
        if (lenientJsonParse(after)) {
          return after;
        }
        break;
      }
    }
  }

  // 4. PNG steganography: data after IEND chunk
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    // Find IEND marker (49 45 4E 44)
    const iend = [0x49, 0x45, 0x4e, 0x44];
    let iendIdx = -1;
    for (let i = 0; i < bytes.length - 4; i++) {
      if (
        bytes[i] === iend[0] &&
        bytes[i + 1] === iend[1] &&
        bytes[i + 2] === iend[2] &&
        bytes[i + 3] === iend[3]
      ) {
        iendIdx = i;
        break;
      }
    }
    if (iendIdx >= 0) {
      // IEND chunk is 4 bytes type + 4 bytes CRC = 8 bytes total
      const afterStart = Math.min(iendIdx + 8, bytes.length);
      const after = new TextDecoder('utf-8', { fatal: false }).decode(
        bytes.slice(afterStart),
      );
      // Try pattern first
      const pm = pattern.exec(after);
      if (pm) {
        const b64 = after.substring(pm.index + 10);
        const decoded = base64ToText(b64);
        if (decoded && lenientJsonParse(decoded)) {
          return decoded;
        }
      }
      // Try direct lenient JSON
      if (lenientJsonParse(after)) {
        return after;
      }
    }
  }

  // 5. WebP steganography: data after RIFF container
  // WebP files start with "RIFF" + 4-byte little-endian file size + "WEBP".
  // Some configs append encoded JSON after the RIFF container ends.
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // 'R'
    bytes[1] === 0x49 && // 'I'
    bytes[2] === 0x46 && // 'F'
    bytes[3] === 0x46 && // 'F'
    bytes[8] === 0x57 && // 'W'
    bytes[9] === 0x45 && // 'E'
    bytes[10] === 0x42 && // 'B'
    bytes[11] === 0x50 // 'P'
  ) {
    // Read RIFF file size (little-endian, 4 bytes at offset 4)
    const riffSize =
      bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
    // RIFF container ends at byte 8 + riffSize
    const riffEnd = Math.min(8 + riffSize, bytes.length);
    if (bytes.length > riffEnd) {
      const after = new TextDecoder('utf-8', { fatal: false }).decode(
        bytes.slice(riffEnd),
      );
      // Try pattern first (8-char prefix + ** + base64 JSON)
      const pm = pattern.exec(after);
      if (pm) {
        const b64 = after.substring(pm.index + 10);
        const decoded = base64ToText(b64);
        if (decoded && lenientJsonParse(decoded)) {
          return decoded;
        }
      }
      // Try direct lenient JSON
      if (lenientJsonParse(after)) {
        return after;
      }
    }
  }

  // 6. Fallback: try latin1 text directly (some configs have mixed encodings)
  if (lenientJsonParse(text)) {
    return text;
  }

  return null;
}

// ---------- ConfigParser ----------

export class ConfigParser {
  /** Public config object for backward compatibility */
  public config: TVBoxConfig | null = null;

  // Internal parsed state
  private sourceBeanList: Map<string, SourceBean> = new Map();
  private mHomeSource: SourceBean | null = null;
  private mDefaultParse: ParseBean | null = null;
  private parseBeanList: ParseBean[] = [];
  private liveChannelGroupList: LiveChannelGroup[] = [];
  private vipParseFlags: string[] = [];
  private ijkCodes: IJKCodeGroup[] = [];
  private spiderJar = '';
  private wallpaperStr = '';
  private jarCacheStr = 'true';
  private livePlayHeadersVal: any = null;
  private parseRules: ParseRule[] = [];
  private adDomains: string[] = [];
  private configLiveUrl = '';

  // ========== Config Loading ==========

  async load(url: string, useCache = false): Promise<TVBoxConfig> {
    const cacheKey = `tvbox_cache_${computeMd5(url)}`;
    console.log(`[ConfigParser] load config: url=${url}, useCache=${useCache}`);

    // 1. Try loading from cache when useCache is true
    if (useCache) {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        try {
          console.log(
            `[ConfigParser] loading from cache, size=${cached.length}`,
          );
          this.parseJson(url, cached);
          return this.config!;
        } catch {
          /* fall through to network */
        }
      }
    }

    // 2. Process the URL: extract ;pk; AES key, convert clan, ensure http prefix
    let configKey: string | null = null;
    let configUrl = url;
    const pkSeparator = ';pk;';

    if (configUrl.includes(pkSeparator)) {
      const parts = configUrl.split(pkSeparator);
      configKey = parts[1] || null;
      if (parts[0].startsWith('clan')) {
        configUrl = clanToAddress(parts[0]);
      } else if (parts[0].startsWith('http')) {
        configUrl = parts[0];
      } else {
        configUrl = 'http://' + parts[0];
      }
    } else if (configUrl.startsWith('clan')) {
      configUrl = clanToAddress(configUrl);
    } else if (!configUrl.startsWith('http')) {
      configUrl = 'http://' + configUrl;
    }

    console.log(
      `[ConfigParser] resolved configUrl=${configUrl}, key=${configKey ? '***' : null}`,
    );

    // 3. Fetch remote config via main process IPC.
    // Many config endpoints (菜妮丝, 欧歌, etc.) only return JSON when the
    // User-Agent is okhttp/4.9.3 (Android TVBox). Browsers silently strip
    // User-Agent from fetch/XHR, so we must fetch via main process which can
    // set any header. The response is returned as base64 to preserve binary
    // data (some configs are JPEG/PNG images with embedded JSON).
    const ipc = getIPC();
    if (!ipc) {
      throw new Error('Electron IPC not available for config fetch');
    }

    try {
      const result = await ipc.invoke('config:fetchRemote', configUrl);
      if (!result || !result.ok) {
        throw new Error(
          `Failed to fetch config: ${result?.error || `HTTP ${result?.status}`}`,
        );
      }

      // Decode base64 body to bytes for steganography detection
      const binaryString = atob(result.bodyBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      console.log(
        `[ConfigParser] fetched config, length=${bytes.length}, contentType=${result.contentType}`,
      );

      // Try to extract JSON from the bytes (handles direct JSON, [A-Za-z]{8}**
      // pattern, JPEG steganography, PNG steganography)
      let json = tryExtractConfig(bytes);
      if (!json) {
        // Fall back to raw text + findResult (handles AES-encrypted configs)
        json = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        console.warn(
          `[ConfigParser] tryExtractConfig failed, falling back to findResult with raw text`,
        );
      }

      // Decrypt content if a key was provided (e.g., ;pk; in URL)
      json = ConfigParser.findResult(json, configKey);
      console.log(`[ConfigParser] after decryption, length=${json.length}`);

      // Fix clan:// references if original URL was a clan URL
      const originalBase = url.split(pkSeparator)[0];
      if (originalBase.startsWith('clan')) {
        json = clanContentFix(clanToAddress(originalBase), json);
      }

      // Fix relative ./ paths
      json = fixContentPath(url, json);

      // Detect multi-config wrapper format {"urls":[{name,url},...]}.
      // This format (used by 及时雨 and similar aggregator configs) lists
      // multiple sub-config URLs that must each be fetched and merged.
      // Mirrors Android TVBox's MultiConfigLoader behavior.
      const wrapper = lenientJsonParse(json);
      if (
        wrapper &&
        Array.isArray(wrapper.urls) &&
        wrapper.urls.length > 0 &&
        !wrapper.sites &&
        !wrapper.video?.sites
      ) {
        console.log(
          `[ConfigParser] detected multi-config wrapper with ${wrapper.urls.length} sub-URLs`,
        );
        const mergedJson = await this.loadMultiConfig(wrapper.urls);
        json = JSON.stringify(mergedJson);
        console.log(
          `[ConfigParser] merged multi-config: ${mergedJson.sites?.length || 0} sites total`,
        );
      }

      // Parse the JSON into internal state
      this.parseJson(url, json);

      // Cache the raw result for offline use
      try {
        localStorage.setItem(cacheKey, json);
      } catch {
        /* ignore storage quota errors */
      }

      return this.config!;
    } catch (error) {
      console.error('[ConfigParser] fetch config failed:', error);
      // On network error, attempt cache fallback
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        try {
          console.log(`[ConfigParser] fallback to cache`);
          this.parseJson(url, cached);
          return this.config!;
        } catch {
          /* ignore */
        }
      }
      throw error;
    }
  }

  /**
   * Fetch each sub-URL in a multi-config wrapper ({urls:[{name,url},...]})
   * and merge their sites/parses/flags into a single combined config JSON.
   * Failed sub-URLs are skipped (logged as warnings) so one bad URL doesn't
   * break the whole aggregator config.
   */
  private async loadMultiConfig(
    urls: Array<{ name?: string; url: string }>,
  ): Promise<any> {
    const ipc = getIPC();
    if (!ipc) {
      throw new Error('Electron IPC not available for multi-config fetch');
    }

    // Fetch all sub-URLs in parallel for speed (typical aggregator has 20+ URLs)
    const results = await Promise.all(
      urls.map(async (u) => {
        const subUrl = String(u.url || '').trim();
        const subName = String(u.name || '').trim();
        if (!subUrl) return null;
        try {
          const result = await ipc.invoke('config:fetchRemote', subUrl);
          if (!result || !result.ok) {
            console.warn(
              `[ConfigParser] multi-config sub-URL failed: ${subName} ${subUrl} (${result?.error || `HTTP ${result?.status}`})`,
            );
            return null;
          }
          const binaryString = atob(result.bodyBase64);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          let subJson = tryExtractConfig(bytes);
          if (!subJson) {
            subJson = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
          }
          subJson = ConfigParser.findResult(subJson, null);
          subJson = fixContentPath(subUrl, subJson);
          const parsed = lenientJsonParse(subJson);
          if (!parsed) {
            console.warn(
              `[ConfigParser] multi-config sub-URL not JSON: ${subName} ${subUrl}`,
            );
            return null;
          }
          return { url: subUrl, name: subName, parsed };
        } catch (e: any) {
          console.warn(
            `[ConfigParser] multi-config sub-URL error: ${subName} ${subUrl}:`,
            e?.message || e,
          );
          return null;
        }
      }),
    );

    // Merge all successfully-parsed sub-configs
    const merged: any = {
      sites: [],
      parses: [],
      flags: [],
      live: [],
      ijkCodes: [],
    };
    let mergedSpider = '';
    let mergedWallpaper = '';

    for (const r of results) {
      if (!r) continue;
      const p = r.parsed;
      // Sites: append each sub-config's sites with a name prefix to avoid
      // key collisions across sub-configs (different configs may share keys
      // like "csp_AppYsV2").
      const subSites: any[] = p.video?.sites ?? p.sites ?? [];
      for (const s of subSites) {
        if (!s || !s.key) continue;
        // Prefix the key with the sub-config index/name to make it unique
        // across all sub-configs. Original key is preserved as the display
        // key (used by spiders as the lookup key in their internal maps).
        const uniqueKey = `${r.name || r.url}::${s.key}`;
        merged.sites.push({
          ...s,
          key: uniqueKey,
          // Preserve original key as a separate field so we can fall back to
          // it for spider init (some spiders look up their config by key).
          originalKey: s.key,
          name: s.name || s.key,
        });
      }
      // spider (global JAR URL): take the first non-empty
      if (!mergedSpider && p.spider) mergedSpider = String(p.spider);
      if (!mergedWallpaper && p.wallpaper)
        mergedWallpaper = String(p.wallpaper);
      // parses: concat (deduplicate by URL)
      if (Array.isArray(p.parses)) {
        for (const ps of p.parses) {
          if (
            ps &&
            !merged.parses.some(
              (m: any) => m.url === ps.url && m.name === ps.name,
            )
          ) {
            merged.parses.push(ps);
          }
        }
      }
      // flags: concat (deduplicate)
      if (Array.isArray(p.flags)) {
        for (const f of p.flags) {
          if (!merged.flags.includes(f)) merged.flags.push(f);
        }
      }
      // live: concat
      if (Array.isArray(p.live)) {
        merged.live.push(...p.live);
      }
      // ijkCodes: concat
      if (Array.isArray(p.ijkCodes)) {
        merged.ijkCodes.push(...p.ijkCodes);
      }
    }

    if (mergedSpider) merged.spider = mergedSpider;
    if (mergedWallpaper) merged.wallpaper = mergedWallpaper;

    console.log(
      `[ConfigParser] multi-config merged: ${merged.sites.length} sites, ${merged.parses.length} parses, ${merged.flags.length} flags`,
    );
    return merged;
  }

  // ========== Config Decryption (FindResult) ==========

  /**
   * Decrypt/decode a config string. Mirrors Android ApiConfig.FindResult.
   * - If already valid JSON, return as-is.
   * - Pattern [A-Za-z0]{8}\*\* → strip prefix, Base64 decode.
   * - Prefix "2423" → AES CBC: extract data, decode hex for key/iv, decrypt.
   * - If configKey provided and not JSON → AES ECB decrypt with configKey.
   * - Otherwise return as-is.
   */
  static findResult(json: string, configKey?: string | null): string {
    let content = json;
    try {
      // Already valid JSON?
      if (isJsonString(content)) return content;

      // Pattern: [A-Za-z0-9]{8}\*\* → strip the 10-char prefix, base64-decode the rest
      // Note: some configs use an 8-char alphanumeric prefix that may
      // include digits (e.g. "et9lLZSr"). The regex matches the last 8
      // alphanumeric chars before "**", so it works for both 8-char prefixes
      // and longer ones.
      const pattern = /[A-Za-z0-9]{8}\*\*/;
      const match = pattern.exec(content);
      if (match) {
        content = content.substring(content.indexOf(match[0]) + 10);
        try {
          content = atob(content);
        } catch {
          content = base64UrlDecode(content);
        }
      }

      if (content.startsWith('2423')) {
        // AES CBC decryption
        // data is between the first "2324" marker and the last 26 chars
        const idx2324 = content.indexOf('2324');
        if (idx2324 === -1) return content;
        const data = content.substring(idx2324 + 4, content.length - 26);

        // Decode the full hex string to a UTF-8 string, then lowercase
        const decoded = hexToUtf8String(content).toLowerCase();

        // Key is between "$#" and "#$"
        const keyStart = decoded.indexOf('$#');
        const keyEnd = decoded.indexOf('#$');
        let rawKey = '';
        if (keyStart !== -1 && keyEnd !== -1 && keyStart + 2 < keyEnd) {
          rawKey = decoded.substring(keyStart + 2, keyEnd);
        }
        const key = rightPadding(rawKey, '0', 16);

        // IV is the last 13 chars of the decoded string
        const iv = rightPadding(
          decoded.substring(decoded.length - 13),
          '0',
          16,
        );

        const decrypted = ConfigParser.aesCbc(data, key, iv);
        if (decrypted) return decrypted;
      } else if (configKey && !isJsonString(content)) {
        // AES ECB decrypt with configKey
        const decrypted = ConfigParser.aesEcb(content, configKey);
        if (decrypted) return decrypted;
      } else {
        return content;
      }
    } catch (e) {
      console.error('ConfigParser.findResult error:', e);
    }
    return json;
  }

  // ========== AES Helpers ==========

  private static aesCbc(
    hexData: string,
    key: string,
    iv: string,
  ): string | null {
    try {
      const keyParsed = CryptoJS.enc.Utf8.parse(key);
      const ivParsed = CryptoJS.enc.Utf8.parse(iv);
      const ciphertext = CryptoJS.enc.Hex.parse(hexData);
      const decrypted = CryptoJS.AES.decrypt({ ciphertext } as any, keyParsed, {
        iv: ivParsed,
        padding: CryptoJS.pad.Pkcs7,
      });
      const result = decrypted.toString(CryptoJS.enc.Utf8);
      return result || null;
    } catch (e) {
      console.error('AES CBC decrypt error:', e);
      return null;
    }
  }

  private static aesEcb(hexData: string, key: string): string | null {
    try {
      const paddedKey = rightPadding(key, '0', 16);
      const keyParsed = CryptoJS.enc.Utf8.parse(paddedKey);
      const ciphertext = CryptoJS.enc.Hex.parse(hexData);
      const decrypted = CryptoJS.AES.decrypt({ ciphertext } as any, keyParsed, {
        mode: CryptoJS.mode.ECB,
        padding: CryptoJS.pad.Pkcs7,
      });
      const result = decrypted.toString(CryptoJS.enc.Utf8);
      return result || null;
    } catch (e) {
      console.error('AES ECB decrypt error:', e);
      return null;
    }
  }

  // ========== Full JSON Parsing (parseJson equivalent) ==========

  private parseJson(apiUrl: string, jsonStr: string): void {
    // Use lenient parsing — some configs (especially AES-decrypted ones) may
    // contain comments or trailing commas that strict JSON.parse rejects.
    const infoJson = lenientJsonParse(jsonStr);
    if (!infoJson) {
      throw new Error(`Failed to parse config JSON from ${apiUrl}`);
    }
    console.log(`[ConfigParser] parseJson: apiUrl=${apiUrl}`);

    // jarCache
    this.jarCacheStr = safeGetString(infoJson, 'jarCache', 'true');

    // spider (global JAR URL)
    this.spiderJar = safeGetString(infoJson, 'spider', '');

    // wallpaper
    this.wallpaperStr = safeGetString(infoJson, 'wallpaper', '');

    // livePlayHeaders
    if ('livePlayHeaders' in infoJson) {
      this.livePlayHeadersVal = infoJson.livePlayHeaders;
    } else {
      this.livePlayHeadersVal = null;
    }

    // ---- Sites ----
    this.sourceBeanList.clear();
    let firstVisibleSite: SourceBean | null = null;

    const sites: any[] = infoJson.video?.sites ?? infoJson.sites ?? [];
    console.log(`[ConfigParser] sites count: ${sites.length}`);

    for (const obj of sites) {
      const siteKey = String(obj.key ?? '').trim();
      if (!siteKey) continue;

      const sb: SourceBean = {
        key: siteKey,
        name: safeGetString(obj, 'name', siteKey),
        type: safeGetInt(obj, 'type', 0),
        api: safeGetString(obj, 'api', ''),
        searchable: safeGetInt(obj, 'searchable', 1),
        quickSearch: safeGetInt(obj, 'quickSearch', 1),
        filterable: siteKey.startsWith('py_')
          ? 1
          : safeGetInt(obj, 'filterable', 1),
        hide: safeGetInt(obj, 'hide', 0),
        playerUrl: safeGetString(obj, 'playUrl', ''),
        ext: safeGetString(obj, 'ext', ''),
        jar: safeGetString(obj, 'jar', ''),
        playerType: safeGetInt(obj, 'playerType', -1),
        categories: safeGetStringList(obj, 'categories'),
        clickSelector: safeGetString(obj, 'click', ''),
        style: safeGetString(obj, 'style', ''),
      };

      if (firstVisibleSite === null && sb.hide === 0) {
        firstVisibleSite = sb;
      }
      this.sourceBeanList.set(siteKey, sb);
    }

    console.log(
      `[ConfigParser] parsed sites: ${this.sourceBeanList.size}, visible sites: ${Array.from(this.sourceBeanList.values()).filter((s) => s.hide !== 1).length}`,
    );
    for (const [key, site] of this.sourceBeanList) {
      if (site.hide !== 1) {
        console.log(
          `[ConfigParser] site: key=${key}, name=${site.name}, type=${site.type}, api=${site.api.substring(0, 100)}`,
        );
      }
    }

    // Set home source from saved preference
    if (this.sourceBeanList.size > 0) {
      const savedHome = localStorage.getItem('tvbox_home_source') || '';
      const stored = savedHome ? this.sourceBeanList.get(savedHome) : null;
      if (stored && stored.hide !== 1) {
        this.mHomeSource = stored;
      } else {
        this.mHomeSource = firstVisibleSite;
      }
    }

    // ---- VIP Parse Flags ----
    this.vipParseFlags = safeGetStringList(infoJson, 'flags');

    // ---- Parses ----
    this.parseBeanList = [];
    if (infoJson.parses && Array.isArray(infoJson.parses)) {
      for (const obj of infoJson.parses) {
        let parseUrl = safeGetString(obj, 'url', '').trim();
        // Handle proxy:// URLs in parse - convert to local proxy URL
        if (parseUrl.startsWith('proxy://')) {
          try {
            const proxyUrl = new URL(parseUrl);
            proxyUrl.searchParams.get('ext') || '';
            parseUrl = `${LOCAL_PROXY()}/proxy?${proxyUrl.searchParams.toString()}`;
          } catch {
            /* keep original */
          }
        }
        const pb: ParseBean = {
          name: safeGetString(obj, 'name', '').trim(),
          url: parseUrl,
          type: safeGetInt(obj, 'type', 0),
          ext:
            obj.ext !== undefined && obj.ext !== null
              ? typeof obj.ext === 'object'
                ? JSON.stringify(obj.ext)
                : String(obj.ext)
              : undefined,
        };
        this.parseBeanList.push(pb);
      }
      // Insert "超级解析" (Super Parse) at index 0 if there are any parses
      if (this.parseBeanList.length > 0) {
        this.parseBeanList.unshift({
          name: '超级解析',
          url: 'SuperParse',
          type: 4,
          ext: '',
        });
      }
    }

    // Set default parse from saved preference
    if (this.parseBeanList.length > 0) {
      const savedParse = localStorage.getItem('tvbox_default_parse') || '';
      const found = savedParse
        ? this.parseBeanList.find((p) => p.name === savedParse)
        : null;
      this.mDefaultParse = found || this.parseBeanList[0];
    } else {
      this.mDefaultParse = null;
    }

    // ---- Lives ----
    this.liveChannelGroupList = [];
    this.configLiveUrl = '';
    const savedLiveUrl = localStorage.getItem('tvbox_live_url') || '';
    const savedEpgUrl = localStorage.getItem('tvbox_epg_url') || '';
    let liveURL_final: string | null = null;

    try {
      if (
        infoJson.lives &&
        Array.isArray(infoJson.lives) &&
        infoJson.lives.length > 0
      ) {
        const livesObj = infoJson.lives[0];
        const livesStr = JSON.stringify(livesObj);
        const proxyIndex = livesStr.indexOf('proxy://');

        if (proxyIndex !== -1) {
          // proxy:// format - extract ext URL parameter
          const endQuoteIdx = livesStr.lastIndexOf('"');
          let proxyUrl = livesStr.substring(proxyIndex, endQuoteIdx);
          proxyUrl = checkReplaceProxy(proxyUrl);

          // Extract ext parameter from URL
          const extMatch = proxyUrl.match(/[?&]ext=([^&]*)/);
          if (extMatch && extMatch[1]) {
            let extUrl = extMatch[1];
            // Decode ext if not already an HTTP/clan URL (may be base64)
            if (!extUrl.startsWith('http') && !extUrl.startsWith('clan://')) {
              try {
                extUrl = base64UrlDecode(extUrl);
              } catch {
                /* not base64, use as-is */
              }
            }
            // Convert clan:// URLs in ext
            if (extUrl.startsWith('clan://')) {
              const originalBase = apiUrl.split(';pk;')[0];
              extUrl = clanContentFix(clanToAddress(originalBase), extUrl);
            }

            console.log('Live URL:', extUrl);
            this.putLiveHistory(extUrl);

            if (!savedLiveUrl) {
              localStorage.setItem('tvbox_live_url', extUrl);
            } else {
              extUrl = savedLiveUrl;
            }
            this.configLiveUrl = extUrl;
            liveURL_final = extUrl;
          }

          // EPG from config
          if (livesObj.epg) {
            const epg = String(livesObj.epg);
            console.log('EPG URL:', epg);
            this.putEpgHistory(epg);
            if (!savedEpgUrl) {
              localStorage.setItem('tvbox_epg_url', epg);
            } else {
              localStorage.setItem('tvbox_epg_url', savedEpgUrl);
            }
          }
        } else if (!livesStr.includes('"type"')) {
          // Old format: array of {group, channels} objects
          this.loadLives(infoJson.lives);
        } else {
          // FongMi format: {type:"0", url, epg}
          const fongMiObj = infoJson.lives[0];
          const typeVal = String(fongMiObj.type ?? '');

          if (typeVal === '0') {
            let furl = String(fongMiObj.url ?? '');

            // EPG from FongMi config
            if (fongMiObj.epg) {
              const epg = String(fongMiObj.epg);
              console.log('EPG URL:', epg);
              this.putEpgHistory(epg);
              if (!savedEpgUrl) {
                localStorage.setItem('tvbox_epg_url', epg);
              } else {
                localStorage.setItem('tvbox_epg_url', savedEpgUrl);
              }
            }

            if (furl.startsWith('http')) {
              console.log('Live URL:', furl);
              this.putLiveHistory(furl);
              if (!savedLiveUrl) {
                localStorage.setItem('tvbox_live_url', furl);
              } else {
                furl = savedLiveUrl;
              }
              this.configLiveUrl = furl;
              liveURL_final = furl;
            }
          }
        }

        // Build final proxy live URL
        if (!liveURL_final) {
          liveURL_final = savedLiveUrl || null;
        }
        if (liveURL_final) {
          const encoded = base64UrlEncode(liveURL_final);
          const proxyLiveUrl = `${LOCAL_PROXY()}/proxy?do=live&type=txt&ext=${encoded}`;
          this.liveChannelGroupList.push({
            groupName: proxyLiveUrl,
            groupIndex: 0,
            channels: [],
          });
        }
      }
    } catch (e) {
      console.error('Error parsing lives:', e);
    }

    // ---- Rules (sniffing / ad filtering / script injection) ----
    this.parseRules = [];
    if (infoJson.rules && Array.isArray(infoJson.rules)) {
      for (const obj of infoJson.rules) {
        // {host, rule:[], filter:[]} - host-specific video match/filter rules
        if (obj.host) {
          const rule: ParseRule = { host: String(obj.host) };
          if (Array.isArray(obj.rule) && obj.rule.length > 0) {
            rule.rule = obj.rule.map(String);
          }
          if (Array.isArray(obj.filter) && obj.filter.length > 0) {
            rule.filter = obj.filter.map(String);
          }
          this.parseRules.push(rule);
        }

        // {hosts:[], regex:[]} - multi-host rules, split into ad filters or sniff rules
        if (Array.isArray(obj.hosts) && Array.isArray(obj.regex)) {
          const ads: string[] = [];
          const rules: string[] = [];
          for (const r of obj.regex) {
            const rs = String(r);
            if (m3u8IsAd(rs)) {
              ads.push(rs);
            } else {
              rules.push(rs);
            }
          }
          for (const h of obj.hosts) {
            const hs = String(h);
            if (rules.length > 0) {
              this.parseRules.push({ host: hs, rule: [...rules] });
            }
            if (ads.length > 0) {
              this.parseRules.push({ host: hs, filter: [...ads] });
            }
          }
        }

        // {hosts:[], script:[]} - host-specific JS scripts to inject
        if (
          Array.isArray(obj.hosts) &&
          Array.isArray(obj.script) &&
          obj.script.length > 0
        ) {
          const scripts = obj.script.map(String);
          for (const h of obj.hosts) {
            this.parseRules.push({ host: String(h), script: [...scripts] });
          }
        }
      }
    }

    // ---- Ads ----
    this.adDomains = [...DEFAULT_ADS];
    if (infoJson.ads && Array.isArray(infoJson.ads)) {
      for (const host of infoJson.ads) {
        const h = String(host);
        if (!this.adDomains.includes(h)) {
          this.adDomains.push(h);
        }
      }
    }

    // ---- IJK Codec Parameters ----
    if (this.ijkCodes.length === 0) {
      const ijkSource =
        infoJson.ijk && Array.isArray(infoJson.ijk)
          ? infoJson.ijk
          : DEFAULT_IJK;
      this.ijkCodes = [];
      for (const obj of ijkSource) {
        const group: IJKCodeGroup = {
          group: String(obj.group ?? ''),
          options: Array.isArray(obj.options)
            ? obj.options.map((o: any) => ({
                name: String(o.name ?? ''),
                category: Number(o.category ?? 0),
                value: String(o.value ?? ''),
              }))
            : [],
        };
        this.ijkCodes.push(group);
      }

      // Ensure at least one codec is available
      if (this.ijkCodes.length === 0) {
        this.ijkCodes = DEFAULT_IJK.map((g) => ({
          group: g.group,
          options: g.options.map((o) => ({ ...o })),
        }));
      }
    }

    // ---- Build public config for backward compatibility ----
    this.config = {
      sites: Array.from(this.sourceBeanList.values()),
      parses: this.parseBeanList,
      flags: this.vipParseFlags,
      wallpaper: this.wallpaperStr,
      spider: this.spiderJar,
      jarCache: this.jarCacheStr,
      livePlayHeaders: this.livePlayHeadersVal,
      lives: this.liveChannelGroupList as any[],
      rules: this.parseRules,
      ads: this.adDomains,
      ijk: this.ijkCodes,
    };
  }

  // ========== Live Channel Parsing (Old Format) ==========

  private loadLives(livesArray: any[]): void {
    this.liveChannelGroupList = [];
    let groupIndex = 0;
    let channelNum = 0;

    for (const groupElement of livesArray) {
      const rawGroupName = String(groupElement.group ?? '').trim();
      const splitParts = rawGroupName.split('_', 2);

      const channels: LiveChannelItem[] = [];
      let channelIndex = 0;

      if (Array.isArray(groupElement.channels)) {
        for (const ch of groupElement.channels) {
          const chName = String(ch.name ?? '').trim();
          const urls = safeGetStringList(ch, 'urls');
          const channelUrls: string[] = [];
          const channelSourceNames: string[] = [];

          let sourceIdx = 1;
          for (const url of urls) {
            const parts = url.split('$', 2);
            channelUrls.push(parts[0]);
            channelSourceNames.push(
              parts.length > 1 ? parts[1] : `源${sourceIdx}`,
            );
            sourceIdx++;
          }

          channels.push({
            channelName: chName,
            channelIndex: channelIndex++,
            channelNum: ++channelNum,
            channelUrls,
            channelSourceNames,
          });
        }
      }

      this.liveChannelGroupList.push({
        groupName: splitParts[0],
        groupPassword: splitParts.length > 1 ? splitParts[1] : undefined,
        groupIndex: groupIndex++,
        channels,
      });
    }
  }

  // ========== History Helpers ==========

  private putLiveHistory(url: string): void {
    if (!url) return;
    try {
      const key = 'tvbox_live_history';
      let history: string[] = JSON.parse(localStorage.getItem(key) || '[]');
      history = history.filter((h) => h !== url);
      history.unshift(url);
      if (history.length > 20) history = history.slice(0, 20);
      localStorage.setItem(key, JSON.stringify(history));
    } catch {
      /* ignore */
    }
  }

  private putEpgHistory(url: string): void {
    if (!url) return;
    try {
      const key = 'tvbox_epg_history';
      let history: string[] = JSON.parse(localStorage.getItem(key) || '[]');
      history = history.filter((h) => h !== url);
      history.unshift(url);
      if (history.length > 20) history = history.slice(0, 20);
      localStorage.setItem(key, JSON.stringify(history));
    } catch {
      /* ignore */
    }
  }

  // ========== Public Accessors ==========

  getSites(): SourceBean[] {
    return Array.from(this.sourceBeanList.values());
  }

  getSite(key: string): SourceBean | undefined {
    return this.sourceBeanList.get(key);
  }

  getHomeSource(): SourceBean | null {
    return this.mHomeSource;
  }

  setHomeSource(bean: SourceBean): void {
    this.mHomeSource = bean;
    localStorage.setItem('tvbox_home_source', bean.key);
  }

  getParses(): ParseBean[] {
    return this.parseBeanList;
  }

  getDefaultParse(): ParseBean | null {
    return this.mDefaultParse;
  }

  setDefaultParse(pb: ParseBean): void {
    this.mDefaultParse = pb;
    localStorage.setItem('tvbox_default_parse', pb.name);
  }

  getVipParseFlags(): string[] {
    return this.vipParseFlags;
  }

  getSpider(): string {
    return this.spiderJar;
  }

  getRules(): ParseRule[] {
    return this.parseRules;
  }

  getAds(): string[] {
    return this.adDomains;
  }

  getLiveChannelGroups(): LiveChannelGroup[] {
    return this.liveChannelGroupList;
  }

  getConfigLiveUrl(): string {
    return this.configLiveUrl;
  }

  getWallpaper(): string {
    return this.wallpaperStr;
  }

  getJarCache(): string {
    return this.jarCacheStr;
  }

  getLivePlayHeaders(): any {
    return this.livePlayHeadersVal;
  }

  getIjkCodes(): IJKCodeGroup[] {
    return this.ijkCodes;
  }
}

export const configParser = new ConfigParser();
