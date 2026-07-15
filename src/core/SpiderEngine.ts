import type { SourceBean, ISpider } from './models';
import { JsSpider } from './JsSpider';
import { PySpider } from './PySpider';
import { JsonRuleParser } from './JsonRuleParser';
import { JarSpider } from './JarSpider';
import { XbpqSpider } from './XbpqSpider';

export class SpiderEngine {
  private spiderCache: Map<string, ISpider> = new Map();
  private spiderBaseUrl: string = '';
  private spiderUrl: string = ''; // Full spider URL from config (e.g. "https://xxx.png;md5;hash")

  /** Set the spider URL from the config's "spider" field.
   * Format: "https://xxx.png;md5;hash" or "https://xxx.jar;md5;hash"
   * This URL is for JAR-based spiders (csp_* prefix), which we don't support.
   * But we store it for reference and for JS spider URL resolution.
   */
  setSpiderBaseUrl(url: string): void {
    this.spiderUrl = url;
    // Extract the base URL part (before ;md5;)
    const parts = url.split(';md5;');
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
      `[SpiderEngine] spider URL: ${url}, base URL: ${this.spiderBaseUrl}`,
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
      return api.split(';md5;')[0];
    }

    // Case 2: source has jar field (highest priority for this source)
    // Box Android: jarUrl = source.getJar().isEmpty() ? spider : source.getJar()
    if (jar) {
      return jar.includes(';md5;') ? jar.split(';md5;')[0] : jar;
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

    // If api has .js extension but no protocol, prepend spider base URL
    if (/\.js(\?|$)/i.test(api) && this.spiderBaseUrl) {
      return this.spiderBaseUrl + api;
    }

    // If api has .py extension but no protocol, prepend spider base URL
    if (/\.py(\?|$)/i.test(api) && this.spiderBaseUrl) {
      return this.spiderBaseUrl + api;
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

    console.log(
      '[SpiderEngine] getSpider creating new:',
      JSON.stringify(
        {
          key,
          sourceName: source.name,
          uniqueKey,
          type,
          api: api || '(empty)',
          ext: (source.ext || '').substring(0, 150),
          jar: source.jar,
        },
        null,
        2,
      ),
    );

    let spider: ISpider | null = null;

    // Check for XBPQ spider (rule-based web scraper)
    if ((source.api || '').startsWith('csp_XBPQ')) {
      console.log(
        `[SpiderEngine] Creating XbpqSpider: key=${uniqueKey}, api=${source.api}`,
      );
      spider = new XbpqSpider(source);
    }
    // Check for JAR spider (csp_ prefix)
    else if ((source.api || '').startsWith('csp_')) {
      const jarUrl = api; // api is now the spiderUrl from resolveApiUrl
      if (!jarUrl) {
        console.warn(
          `[SpiderEngine] JAR spider "${source.name || key}" has no spider URL`,
        );
        return null;
      }
      console.log(
        `[SpiderEngine] Creating JarSpider: key=${uniqueKey}, api=${source.api}, jarUrl=${jarUrl}`,
      );
      spider = new JarSpider(uniqueKey, source.api || '', jarUrl, source.ext);
    } else if (api && /\.js(\?|$)/i.test(api)) {
      spider = new JsSpider(key, api, source.ext);
    } else if ((api && /\.py(\?|$)/i.test(api)) || key.startsWith('py_')) {
      spider = new PySpider(key, api, source.ext);
    } else if (type === 0 || type === 1 || type === 2) {
      // JSON/XML采集源 - use JsonRuleParser with ext field rules
      spider = new JsonRuleParser(source);
    } else if (type === 3 || type === 4) {
      // type=3: Spider mode - could be JS or JAR
      // If we have a valid api URL, try as JS spider
      if (api && /^https?:\/\//i.test(api)) {
        console.log(
          `[SpiderEngine] type=${type}, trying JsSpider with URL: ${api}`,
        );
        spider = new JsSpider(key, api, source.ext);
      } else if (api && /\.js(\?|$)/i.test(api)) {
        spider = new JsSpider(key, api, source.ext);
      } else if (source.ext) {
        // If no api URL but has ext, try JsonRuleParser with ext rules
        console.log(
          `[SpiderEngine] type=${type} with ext rules, trying JsonRuleParser: ${key}`,
        );
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
      await spider.init(source.ext || '');
      console.log(`[SpiderEngine] Spider initialized successfully: ${key}`);
    } catch (e) {
      console.error(`[SpiderEngine] Failed to init spider ${key}:`, e);
      // If JsSpider failed for type=3, try JsonRuleParser as fallback (if has ext)
      if (type === 3 && spider instanceof JsSpider && source.ext) {
        console.log(
          `[SpiderEngine] JsSpider failed, trying JsonRuleParser fallback for: ${key}`,
        );
        try {
          spider = new JsonRuleParser(source);
          await spider.init(source.ext || '');
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
