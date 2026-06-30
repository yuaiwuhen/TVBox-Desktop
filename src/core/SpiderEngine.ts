import type { SourceBean, ISpider } from './models';
import { JsSpider } from './JsSpider';
import { PySpider } from './PySpider';
import { JsonRuleParser } from './JsonRuleParser';

export class SpiderEngine {
  private spiderCache: Map<string, ISpider> = new Map();
  private spiderBaseUrl: string = '';

  /** Set the spider base URL from the config's "spider" field. */
  setSpiderBaseUrl(url: string): void {
    // Ensure trailing slash for proper URL construction
    this.spiderBaseUrl = url.endsWith('/') ? url : url + '/';
    console.log(`[SpiderEngine] spider base URL: ${this.spiderBaseUrl}`);
  }

  /**
   * Resolve the actual spider API URL from the source's api field.
   * If api is already a full URL (http/https), return as-is.
   * If api is a key name, use the spider base URL to construct the full URL.
   */
  private resolveApiUrl(source: SourceBean): string {
    const api = source.api || '';
    const jar = source.jar || '';

    // If jar is specified, use it as the full spider URL
    if (jar && /^https?:\/\//i.test(jar)) {
      return jar;
    }

    // If api is already a full URL, return as-is
    if (/^https?:\/\//i.test(api)) {
      return api;
    }

    // If api has a .js or .py extension but no protocol, prepend spider base
    if (/\.(js|py)(\?|$)/i.test(api) && this.spiderBaseUrl) {
      return this.spiderBaseUrl + api;
    }

    // If api is just a key name and spider base URL is available, construct the URL
    if (api && this.spiderBaseUrl) {
      return this.spiderBaseUrl + api + '.js';
    }

    return api;
  }

  async getSpider(source: SourceBean): Promise<ISpider | null> {
    const cached = this.spiderCache.get(source.key);
    if (cached) return cached;

    const api = this.resolveApiUrl(source);
    const key = source.key || '';
    const type = source.type ?? 3;

    console.log(
      `[SpiderEngine] getSpider: key=${key}, type=${type}, api=${api}, ext=${(source.ext || '').substring(0, 80)}`,
    );

    let spider: ISpider | null = null;

    if (/\.js(\?|$)/i.test(api)) {
      spider = new JsSpider(key, api, source.ext);
    } else if (/\.py(\?|$)/i.test(api) || key.startsWith('py_')) {
      spider = new PySpider(key, api, source.ext);
    } else if (type === 0 || type === 1 || type === 2) {
      spider = new JsonRuleParser(source);
    } else if (type === 3 || type === 4) {
      if (api) {
        console.log(`[SpiderEngine] type=${type}, trying JsSpider: ${key}`);
        spider = new JsSpider(key, api, source.ext);
      } else {
        console.warn(
          `[SpiderEngine] type=${type} with empty api, trying JsonRuleParser: ${key}`,
        );
        spider = new JsonRuleParser(source);
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
      // If JsSpider failed for type=3, try JsonRuleParser as fallback
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
