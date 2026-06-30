import type { SourceBean, ISpider } from './models';
import { JsSpider } from './JsSpider';
import { PySpider } from './PySpider';
import { JsonRuleParser } from './JsonRuleParser';

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
   * Determine the spider type from the api field format.
   * Box Android convention:
   * - api starts with "csp_" → JAR spider (Java class in JAR, not supported)
   * - api ends with ".js" → JS spider (remote JS file)
   * - api ends with ".py" or key starts with "py_" → Python spider
   * - type=0/1/2 → JSON/XML采集源 (JsonRuleParser)
   */
  private resolveApiUrl(source: SourceBean): string {
    const api = source.api || '';
    const jar = source.jar || '';

    // Check if this is a JAR spider (csp_ prefix)
    if (api.startsWith('csp_')) {
      // JAR spiders require loading Java classes from JAR files
      // We don't support JAR parsing, return empty to indicate unsupported
      console.warn(
        `[SpiderEngine] JAR spider detected (csp_ prefix): ${api}, JAR support not implemented`,
      );
      return '';
    }

    // If api is already a full HTTP URL, return as-is
    if (/^https?:\/\//i.test(api)) {
      return api;
    }

    // If jar is specified and is a full URL, it might be for JS API loading
    // (JsLoader can load a JAR for custom JS API before loading the JS spider)
    // We skip this since we don't support JAR
    if (jar && /^https?:\/\//i.test(jar)) {
      console.warn(
        `[SpiderEngine] Source has jar field but JAR support not implemented: ${jar}`,
      );
    }

    // If api has .js extension but no protocol, prepend spider base URL
    if (/\.js(\?|$)/i.test(api) && this.spiderBaseUrl) {
      return this.spiderBaseUrl + api;
    }

    // If api has .py extension but no protocol, prepend spider base URL
    if (/\.py(\?|$)/i.test(api) && this.spiderBaseUrl) {
      return this.spiderBaseUrl + api;
    }

    // For other cases, return api as-is (will be handled by type-based logic)
    return api;
  }

  async getSpider(source: SourceBean): Promise<ISpider | null> {
    const cached = this.spiderCache.get(source.key);
    if (cached) return cached;

    const api = this.resolveApiUrl(source);
    const key = source.key || '';
    const type = source.type ?? 3;

    console.log(
      `[SpiderEngine] getSpider: key=${key}, type=${type}, api=${api || '(empty)'}, ext=${(source.ext || '').substring(0, 80)}`,
    );

    let spider: ISpider | null = null;

    // Check for JAR spider (csp_ prefix) - not supported
    if ((source.api || '').startsWith('csp_')) {
      console.warn(
        `[SpiderEngine] Source "${source.name || key}" uses JAR spider (api="${source.api}"). JAR parsing is not supported.`,
      );
      return null;
    }

    if (api && /\.js(\?|$)/i.test(api)) {
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

    this.spiderCache.set(source.key, spider);
    return spider;
  }

  getSpiderByKey(key: string): ISpider | null {
    return this.spiderCache.get(key) ?? null;
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

  clear(key: string): void {
    const spider = this.spiderCache.get(key);
    if (spider) {
      try {
        spider.destroy();
      } catch {
        /* ignore */
      }
      this.spiderCache.delete(key);
    }
  }
}

export const spiderEngine = new SpiderEngine();
