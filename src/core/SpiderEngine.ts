import type { SourceBean, ISpider } from './models';
import { JsSpider } from './JsSpider';
import { PySpider } from './PySpider';
import { JsonRuleParser } from './JsonRuleParser';
import { JarSpider } from './JarSpider';
import { XbpqSpider } from './XbpqSpider';
import { XyqhikerSpider } from './XyqhikerSpider';
// DrpySpider no longer used — drpy spiders are handled by JsSpider

/**
 * Site URL overrides for sources whose upstream `ext` URL has gone dark
 * (522 / DNS fail / 404). Each rule matches by `api` class name and the
 * broken upstream URL fragment, replacing it with a working mirror.
 * This keeps the original config intact while letting the spider talk to
 * a live host.
 */
const SITE_EXT_OVERRIDES: Array<{
  api: string;
  contains: string;
  replaceFrom: string;
  replaceTo: string;
  reason: string;
}> = [
  {
    api: 'csp_Dm84',
    contains: 'https://dm84.net',
    replaceFrom: 'https://dm84.net',
    replaceTo: 'https://dmbus.cc',
    reason:
      'dm84.net 301 -> dmbus.cc (live mirror, requires browser UA through Cloudflare); dm84.site is a parked domain',
  },
  // AppGet/AppQi sources — ext format is "<api-url-or-txt>|<aes-key>".
  // The API URL must be alive AND the AES key must match what the API uses
  // to encrypt its responses. When the original upstream is down, we
  // replace the entire ext with a known-working URL+key combo. Downside:
  // the replaced source will mirror the content of the reference source
  // (蔬菜 uses bk/9.txt -> http://103.236.72.182:3688 with key
  // 88689667dce61725). This is a deliberate tradeoff: a working source
  // showing some content is better than a dead source showing nothing.
  {
    // 肥猫: cms140.yhg.one 超时（域名失效）
    api: 'csp_AppGet',
    contains: 'https://cms140.yhg.one|bM7iC9eA3oZ1nB7z',
    replaceFrom: 'https://cms140.yhg.one|bM7iC9eA3oZ1nB7z',
    replaceTo:
      'https://allinadmin.oss-cn-hangzhou.aliyuncs.com/bk/9.txt|88689667dce61725',
    reason:
      'cms140.yhg.one 超时；替换为可用的 bk/9.txt (API http://103.236.72.182:3688 + 匹配 key)',
  },
  {
    // 干饭: mk1080.top/get.txt 返回 "ok" 无 API
    api: 'csp_AppGet',
    contains: 'https://mk1080.top/get.txt|c60d88b2eep53za8',
    replaceFrom: 'https://mk1080.top/get.txt|c60d88b2eep53za8',
    replaceTo:
      'https://allinadmin.oss-cn-hangzhou.aliyuncs.com/bk/9.txt|88689667dce61725',
    reason:
      'mk1080.top/get.txt 返回 "ok" 无 API；替换为可用的 bk/9.txt (API http://103.236.72.182:3688 + 匹配 key)',
  },
  {
    // 光盘: 600.txt 返回 http://111.42.67.221:8004 (ECONNREFUSED)
    // AppQi 与 AppGet API 格式不同，bk/9.txt 的 API 不支持 AppQi。
    // 改用行动源 (csp_AppQi) 已验证可用的 ext。
    api: 'csp_AppQi',
    contains:
      'https://yun-1316442804.cos.ap-guangzhou.myqcloud.com/600.txt|FTgP4Gq8zPiqbt7M',
    replaceFrom:
      'https://yun-1316442804.cos.ap-guangzhou.myqcloud.com/600.txt|FTgP4Gq8zPiqbt7M',
    replaceTo: 'https://qj4.catbb.xyz|eecbio48dsq13kkk',
    reason:
      '600.txt 返回的 API ECONNREFUSED；bk/9.txt API 不支持 AppQi 格式；改用行动源已验证可用的 qj4.catbb.xyz (csp_AppQi)',
  },
  {
    // 再来: vv.229d.cn 超时（域名失效）
    api: 'csp_AppGet',
    contains: 'https://vv.229d.cn|8888888888888888',
    replaceFrom: 'https://vv.229d.cn|8888888888888888',
    replaceTo:
      'https://allinadmin.oss-cn-hangzhou.aliyuncs.com/bk/9.txt|88689667dce61725',
    reason:
      'vv.229d.cn 超时；替换为可用的 bk/9.txt (API http://103.236.72.182:3688 + 匹配 key)',
  },
];

function applyExtOverride(source: SourceBean): {
  ext: string;
  overridden: boolean;
  reason?: string;
} {
  const ext = source.ext || '';
  if (!ext) return { ext, overridden: false };
  for (const rule of SITE_EXT_OVERRIDES) {
    if (source.api !== rule.api) continue;
    if (!ext.includes(rule.contains)) continue;
    const newExt = ext.replace(rule.replaceFrom, rule.replaceTo);
    if (newExt !== ext) {
      console.log(
        `[SpiderEngine] ext override: ${source.key} (${source.api})`,
        `${rule.replaceFrom} -> ${rule.replaceTo}`,
        `(${rule.reason})`,
      );
      return { ext: newExt, overridden: true, reason: rule.reason };
    }
  }
  return { ext, overridden: false };
}

export class SpiderEngine {
  private spiderCache: Map<string, ISpider> = new Map();
  private spiderBaseUrl: string = '';
  private spiderUrl: string = ''; // Full spider URL from config (e.g. "https://xxx.png;md5;hash")
  private configBaseUrl: string = ''; // Base URL from config URL for resolving relative paths

  /** Set the config URL (the URL that was used to load the config JSON).
   * Used as a fallback base URL for resolving relative paths when
   * the spider field is not present.
   */
  setConfigUrl(url: string): void {
    if (!url) return;
    try {
      const parsed = new URL(url);
      this.configBaseUrl =
        parsed.origin +
        parsed.pathname.substring(0, parsed.pathname.lastIndexOf('/') + 1);
    } catch {
      // Not a valid URL, ignore
    }
  }

  /** Resolve a possibly-relative URL against the config base URL.
   * Handles "./xxx", "xxx", "/xxx" patterns. Absolute http(s) URLs are returned as-is.
   * Returns '' if input is empty or unresolvable.
   */
  private resolveRelative(url: string): string {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (!this.configBaseUrl) return url;
    try {
      return new URL(url, this.configBaseUrl).toString();
    } catch {
      return url;
    }
  }

  /** Set the spider URL from the config's "spider" field.
   * Format: "https://xxx.png;md5;hash" or "https://xxx.jar;md5;hash"
   * This URL is for JAR-based spiders (csp_* prefix), which we don't support.
   * But we store it for reference and for JS spider URL resolution.
   */
  setSpiderBaseUrl(url: string): void {
    // Resolve relative URLs (e.g. "./jar/fan.txt;md5;hash") against configBaseUrl.
    // Must be done AFTER setConfigUrl() so configBaseUrl is current.
    const resolved = this.resolveRelative(url);
    this.spiderUrl = resolved;
    // Extract the base URL part (before ;md5;)
    const parts = resolved.split(';md5;');
    if (parts.length > 0) {
      // For PNG/JAR URLs, the base is the file URL
      // For JS-based configs, the spider URL might be a directory
      let baseUrl = parts[0];
      // Remove file extension to get directory (if it's a file URL)
      // e.g. https://raw.githubusercontent.com/xxx/spider.js -> https://raw.githubusercontent.com/xxx/
      const lastSlash = baseUrl.lastIndexOf('/');
      if (lastSlash > 0) {
        this.spiderBaseUrl = baseUrl.substring(0, lastSlash + 1);
      } else {
        this.spiderBaseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
      }
    }
    console.log(
      `[SpiderEngine] spider URL: ${url} -> resolved: ${resolved}, base URL: ${this.spiderBaseUrl}`,
    );
  }

  /**
   * Resolve the spider URL for JAR spiders.
   * Priority (Box Android convention):
   * 1. If api contains ";md5;" format → extract URL from api
   * 2. If source has jar field → use source.jar (highest priority for this source)
   * 3. Otherwise → use global spiderUrl from config
   *
   * Returns the PNG/JAR URL without ";md5;hash" suffix.
   */
  private resolveJarUrl(source: SourceBean): string {
    const api = source.api || '';
    const jar = source.jar || '';

    // Case 1: api field contains spider URL format (like "https://xxx.png;md5;hash")
    if (api.includes(';md5;')) {
      return this.resolveRelative(api.split(';md5;')[0]);
    }

    // Case 2: source has jar field (highest priority for this source)
    // Box Android: jarUrl = source.getJar().isEmpty() ? spider : source.getJar()
    if (jar) {
      const jarUrl = jar.includes(';md5;') ? jar.split(';md5;')[0] : jar;
      return this.resolveRelative(jarUrl);
    }

    // Case 3: use global spiderUrl from config
    if (this.spiderUrl) {
      return this.spiderUrl.includes(';md5;')
        ? this.spiderUrl.split(';md5;')[0]
        : this.spiderUrl;
    }

    return '';
  }

  /**
   * Determine the spider type and resolve the API URL.
   * Box Android convention:
   * - api starts with "csp_" → JAR spider (Java class in JAR)
   * - api ends with ".js" → JS spider (remote JS file)
   * - api ends with ".py" or key starts with "py_" → Python spider
   * - type=0/1/2 → JSON/XML采集源 (JsonRuleParser)
   */
  private resolveApiUrl(source: SourceBean): string {
    const api = source.api || '';

    // For JAR spiders (csp_ prefix), we return the JAR URL, not the api field
    // The actual class name is in the api field (e.g., "csp_Duopan")
    if (api.startsWith('csp_')) {
      return this.resolveJarUrl(source);
    }

    // If api contains spider URL format, extract the URL part
    if (api.includes(';md5;')) {
      return api.split(';md5;')[0];
    }

    // If api is already a full HTTP URL, return as-is
    if (/^https?:\/\//i.test(api)) {
      return api;
    }

    // If api has .js extension but no protocol, prepend base URL
    if (/\.js(\?|$)/i.test(api)) {
      const base = this.spiderBaseUrl || this.configBaseUrl;
      if (base) return base + api;
    }

    // If api has .py extension but no protocol, prepend base URL
    if (/\.py(\?|$)/i.test(api)) {
      const base = this.spiderBaseUrl || this.configBaseUrl;
      if (base) return base + api;
    }

    // For other relative paths, try configBaseUrl as fallback
    if (api && !/^https?:\/\//i.test(api) && this.configBaseUrl) {
      return this.configBaseUrl + api;
    }

    // For other cases, return api as-is
    return api;
  }

  async getSpider(source: SourceBean): Promise<ISpider | null> {
    const uniqueKey = `${source.key}-${source.name}`;
    const cached = this.spiderCache.get(uniqueKey);
    if (cached) {
      console.log(
        '[SpiderEngine] getSpider cache hit:',
        JSON.stringify(
          {
            key: source.key,
            sourceName: source.name,
            uniqueKey,
            cachedType: cached.constructor.name,
          },
          null,
          2,
        ),
      );
      if (typeof cached.action === 'function') {
        return cached;
      }
      console.warn(
        `[SpiderEngine] Cached spider ${uniqueKey} missing action method, recreating`,
      );
    }

    const api = this.resolveApiUrl(source);
    const key = source.key || '';
    const type = source.type ?? 3;

    // Apply ext URL override for known-broken upstream sites
    const { ext: effectiveExt, overridden } = applyExtOverride(source);

    console.log(
      '[SpiderEngine] getSpider creating new:',
      JSON.stringify(
        {
          key,
          sourceName: source.name,
          uniqueKey,
          type,
          api: api || '(empty)',
          ext: effectiveExt.substring(0, 150),
          extOverridden: overridden,
          jar: source.jar,
        },
        null,
        2,
      ),
    );

    let spider: ISpider | null = null;

    // Determine if this source has a JAR URL available
    const hasJarUrl = !!this.resolveJarUrl(source);
    const apiStr = source.api || '';

    // Check for JAR spider (csp_ prefix) FIRST — csp_ is the definitive indicator
    // of a JAR spider regardless of key prefix (e.g., key=drpy_js_豆瓣 + api=csp_Douban)
    if (apiStr.startsWith('csp_')) {
      const jarUrl = api; // api is now the spiderUrl from resolveApiUrl
      if (!jarUrl && !hasJarUrl) {
        // No JAR URL — try custom implementations as fallback
        if (apiStr.startsWith('csp_XYQHiker')) {
          console.log(
            `[SpiderEngine] No JAR, creating XyqhikerSpider: key=${uniqueKey}, api=${apiStr}`,
          );
          spider = new XyqhikerSpider(source);
        } else if (apiStr.startsWith('csp_XBPQ')) {
          console.log(
            `[SpiderEngine] No JAR, creating XbpqSpider: key=${uniqueKey}, api=${apiStr}`,
          );
          spider = new XbpqSpider(source);
        } else {
          console.warn(
            `[SpiderEngine] JAR spider "${source.name || key}" has no spider URL`,
          );
          return null;
        }
      } else {
        // JAR URL available — use JarSpider for all csp_* spiders including XBPQ/XYQHiker
        console.log(
          `[SpiderEngine] Creating JarSpider: key=${uniqueKey}, api=${apiStr}, jarUrl=${jarUrl}`,
        );
        spider = new JarSpider(uniqueKey, apiStr, jarUrl, effectiveExt);
      }
    }
    // Check for drpy spider (api contains drpy library URL or key starts with drpy_js_)
    // drpy spiders are JS-based — route to JsSpider which has full VM + pdfh/pdfa/cheerio
    else if (apiStr.includes('drpy') || key.startsWith('drpy_js_')) {
      console.log(
        `[SpiderEngine] Creating JsSpider for drpy: key=${uniqueKey}, api=${api}`,
      );
      // For drpy spiders, api is the drpy library URL, ext is the spider rules URL
      // JsSpider will load both files
      spider = new JsSpider(key, api, effectiveExt);
    } else if (api && /\.js(\?|$)/i.test(api)) {
      spider = new JsSpider(key, api, effectiveExt);
    } else if ((api && /\.py(\?|$)/i.test(api)) || key.startsWith('py_')) {
      spider = new PySpider(key, api, effectiveExt);
    } else if (type === 0 || type === 1 || type === 2) {
      // JSON/XML采集源 - use JsonRuleParser with ext field rules
      // JsonRuleParser reads source.ext directly, so we must override on source
      if (overridden) source.ext = effectiveExt;
      spider = new JsonRuleParser(source);
    } else if (type === 3 || type === 4) {
      // type=3: Spider mode - could be JS or JAR
      // If we have a valid api URL, try as JS spider
      if (api && /^https?:\/\//i.test(api)) {
        console.log(
          `[SpiderEngine] type=${type}, trying JsSpider with URL: ${api}`,
        );
        spider = new JsSpider(key, api, effectiveExt);
      } else if (api && /\.js(\?|$)/i.test(api)) {
        spider = new JsSpider(key, api, effectiveExt);
      } else if (effectiveExt) {
        // If no api URL but has ext, try JsonRuleParser with ext rules
        console.log(
          `[SpiderEngine] type=${type} with ext rules, trying JsonRuleParser: ${key}`,
        );
        if (overridden) source.ext = effectiveExt;
        spider = new JsonRuleParser(source);
      } else {
        console.warn(
          `[SpiderEngine] type=${type} source "${source.name || key}" has no valid api URL or ext rules`,
        );
        return null;
      }
    } else {
      console.warn(`[SpiderEngine] Unknown spider type=${type} for: ${key}`);
      return null;
    }

    try {
      await spider.init(effectiveExt || '');
      console.log(`[SpiderEngine] Spider initialized successfully: ${key}`);
    } catch (e) {
      console.error(`[SpiderEngine] Failed to init spider ${key}:`, e);
      // If JsSpider failed for type=3, try JsonRuleParser as fallback (if has ext)
      if (type === 3 && spider instanceof JsSpider && effectiveExt) {
        console.log(
          `[SpiderEngine] JsSpider failed, trying JsonRuleParser fallback for: ${key}`,
        );
        try {
          if (overridden) source.ext = effectiveExt;
          spider = new JsonRuleParser(source);
          await spider.init(effectiveExt || '');
          console.log(
            `[SpiderEngine] JsonRuleParser fallback succeeded: ${key}`,
          );
        } catch (e2) {
          console.error(
            `[SpiderEngine] JsonRuleParser fallback also failed for ${key}:`,
            e2,
          );
          return null;
        }
      } else {
        return null;
      }
    }

    this.spiderCache.set(uniqueKey, spider);
    return spider;
  }

  getSpiderByKey(key: string): ISpider | null {
    return this.spiderCache.get(key) ?? null;
  }

  clear(key: string): void {
    for (const [cacheKey, spider] of this.spiderCache.entries()) {
      if (cacheKey.startsWith(key + '-')) {
        try {
          spider.destroy();
        } catch {
          /* ignore */
        }
        this.spiderCache.delete(cacheKey);
        console.log('[SpiderEngine] Cleared spider cache:', cacheKey);

        try {
          const ipc = window.electronIPC || require('electron').ipcRenderer;
          ipc.invoke('jar:clearSpiderCache', cacheKey).catch(() => {});
        } catch {
          /* ignore */
        }
      }
    }
  }

  clearAll(): void {
    for (const spider of this.spiderCache.values()) {
      try {
        spider.destroy();
      } catch {
        /* ignore */
      }
    }
    this.spiderCache.clear();
  }
}

export const spiderEngine = new SpiderEngine();
