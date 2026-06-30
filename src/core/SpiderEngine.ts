import type { SourceBean, ISpider } from './models';
import { JsSpider } from './JsSpider';
import { PySpider } from './PySpider';
import { JsonRuleParser } from './JsonRuleParser';

export class SpiderEngine {
  private spiderCache: Map<string, ISpider> = new Map();

  async getSpider(source: SourceBean): Promise<ISpider | null> {
    const cached = this.spiderCache.get(source.key);
    if (cached) return cached;

    const api = source.api || '';
    const key = source.key || '';
    const type = source.type ?? 3;

    let spider: ISpider | null = null;

    if (/\.js(\?|$)/i.test(api)) {
      spider = new JsSpider(key, api, source.ext);
    } else if (/\.py(\?|$)/i.test(api) || key.startsWith('py_')) {
      spider = new PySpider(key, api, source.ext);
    } else if (type === 0 || type === 1 || type === 2) {
      // Old-style XML/JSON/Mix sources use JsonRuleParser
      spider = new JsonRuleParser(source);
    } else {
      console.warn(`[SpiderEngine] JAR spider not supported: ${key}`);
      return null;
    }

    try {
      await spider.init(source.ext || '');
    } catch (e) {
      console.error(`[SpiderEngine] Failed to init spider ${key}:`, e);
      return null;
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
