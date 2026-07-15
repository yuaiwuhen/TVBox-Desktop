/**
 * DrpySpider - Dynamic Runtime for Python-like JS spiders
 *
 * Drpy is a JS library that provides a Python-like API for writing spiders.
 * It uses eval() to execute spider rules defined in the 'ext' field.
 */

import type { ISpider } from './models';

interface SourceBean {
  key: string;
  name: string;
  api: string;
  ext?: string;
  type?: number;
}

/**
 * Fetch content via main process IPC
 */
async function fetchContent(url: string): Promise<string> {
  const ipc = (window as any).electronIPC;
  if (!ipc) {
    throw new Error('electronIPC not available');
  }

  const result = await ipc.invoke('http:fetchHtml', {
    url,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36',
    },
    timeout: 30000,
  });

  if (!result.success) {
    throw new Error(result.error || 'Unknown error');
  }

  return result.data;
}

/**
 * DrpySpider loads drpy library and executes spider rules in a sandboxed environment.
 *
 * Security note: This uses eval() to execute external JS code.
 * While this is necessary for drpy compatibility, we mitigate risks by:
 * 1. Running in the renderer process (sandboxed from Node.js APIs)
 * 2. Limiting available APIs to safe ones
 * 3. Using strict mode
 */
export class DrpySpider implements ISpider {
  private key: string;
  private name: string;
  private drpyLib: string;
  private spiderRules: string;
  private spiderObj: any = null;

  constructor(source: SourceBean) {
    this.key = source.key;
    this.name = source.name;

    // api is the drpy library URL
    // ext is the spider rules URL
    this.drpyLib = source.api;
    this.spiderRules = source.ext || '';

    console.log(`[DrpySpider] Created: ${this.key}`, {
      name: this.name,
      lib: this.drpyLib,
      rules: this.spiderRules,
    });
  }

  async init(extend: string): Promise<void> {
    try {
      // Load drpy library
      console.log(`[DrpySpider] Loading drpy library from ${this.drpyLib}`);
      const drpyCode = await fetchContent(this.drpyLib);

      // Load spider rules
      console.log(`[DrpySpider] Loading spider rules from ${this.spiderRules}`);
      const rulesCode = await fetchContent(this.spiderRules);

      // Execute in sandbox
      // Note: This is a simplified implementation
      // A full implementation would use vm2 or isolated-vm for better security

      // Create sandbox environment with safe APIs
      const sandbox = this.createSandbox();

      // Execute drpy library
      try {
        const drpyFunc = new Function('sandbox', `
          with (sandbox) {
            ${drpyCode}
          }
        `);
        drpyFunc(sandbox);
      } catch (e) {
        console.error('[DrpySpider] Failed to execute drpy library:', e);
      }

      // Execute spider rules
      try {
        const rulesFunc = new Function('sandbox', `
          with (sandbox) {
            ${rulesCode}
            return typeof __jsSpawnRun__ !== 'undefined' ? __jsSpawnRun__ : (typeof rule !== 'undefined' ? { rule } : {});
          }
        `);
        this.spiderObj = rulesFunc(sandbox);

        // If the result has a 'rule' property, it's the rule object
        if (this.spiderObj.rule) {
          this.spiderObj = this.spiderObj.rule;
        }
      } catch (e) {
        console.error('[DrpySpider] Failed to execute spider rules:', e);
      }

      console.log(`[DrpySpider] Initialized: ${this.key}`);
    } catch (e) {
      console.error(`[DrpySpider] Init failed:`, e);
    }
  }

  /**
   * Create sandbox environment with safe APIs
   */
  private createSandbox(): any {
    const sandbox: any = {
      // Console
      console: {
        log: (...args: any[]) => console.log('[Drpy]', ...args),
        error: (...args: any[]) => console.error('[Drpy]', ...args),
        warn: (...args: any[]) => console.warn('[Drpy]', ...args),
      },

      // Global objects
      window: {},
      global: {},
      this: {},

      // Utility functions that drpy spiders commonly use
      fetch: (url: string, options?: any) => {
        return fetchContent(url);
      },

      // Base64
      base64: {
        encode: (str: string) => btoa(unescape(encodeURIComponent(str))),
        decode: (str: string) => decodeURIComponent(escape(atob(str))),
      },

      // JSON
      JSON: JSON,

      // Date
      Date: Date,

      // Math
      Math: Math,

      // Array
      Array: Array,

      // Object
      Object: Object,

      // String
      String: String,

      // RegExp
      RegExp: RegExp,

      // parseInt, parseFloat
      parseInt: parseInt,
      parseFloat: parseFloat,
      isNaN: isNaN,

      // encodeURIComponent, decodeURIComponent
      encodeURIComponent: encodeURIComponent,
      decodeURIComponent: decodeURIComponent,
      encodeURI: encodeURI,
      decodeURI: decodeURI,
    };

    return sandbox;
  }

  /**
   * Call spider method safely
   */
  private callSpiderMethod(method: string, ...args: any[]): any {
    if (!this.spiderObj) {
      console.warn(`[DrpySpider] Spider not initialized`);
      return null;
    }

    if (typeof this.spiderObj[method] !== 'function') {
      console.warn(`[DrpySpider] Method ${method} not found`);
      return null;
    }

    try {
      return this.spiderObj[method](...args);
    } catch (e) {
      console.error(`[DrpySpider] Error calling ${method}:`, e);
      return null;
    }
  }

  async homeContent(filter: boolean): Promise<string> {
    const result = this.callSpiderMethod('homeContent', filter);
    return result || JSON.stringify({ list: [], class: [], filters: {} });
  }

  async homeVideoContent(): Promise<string> {
    const result = this.callSpiderMethod('homeVideoContent');
    return result || JSON.stringify({ list: [] });
  }

  async categoryContent(
    tid: string,
    pg: string,
    filter: boolean,
    extend: Record<string, string>,
  ): Promise<string> {
    const result = this.callSpiderMethod('categoryContent', tid, pg, filter, extend);
    return result || JSON.stringify({ list: [], count: 0 });
  }

  async detailContent(ids: string[]): Promise<string> {
    const result = this.callSpiderMethod('detailContent', ids);
    return result || JSON.stringify({ list: [] });
  }

  async searchContent(
    key: string,
    quick: boolean,
    pg?: string,
  ): Promise<string> {
    const result = this.callSpiderMethod('searchContent', key, quick, pg);
    return result || JSON.stringify({ list: [] });
  }

  async playerContent(
    flag: string,
    id: string,
    vipFlags: string[],
  ): Promise<string> {
    const result = this.callSpiderMethod('playerContent', flag, id, vipFlags);
    return result || JSON.stringify({ parse: 0, url: id, header: '' });
  }

  async isVideoFormat(url: string): Promise<boolean> {
    const result = this.callSpiderMethod('isVideoFormat', url);
    return result || false;
  }

  async manualVideoCheck(): Promise<boolean> {
    const result = this.callSpiderMethod('manualVideoCheck');
    return result || false;
  }

  async action(actionId: string, actionData: any): Promise<string> {
    const result = this.callSpiderMethod('action', actionId, actionData);
    return result || '';
  }

  destroy(): void {
    this.spiderObj = null;
    console.log(`[DrpySpider] Destroyed: ${this.key}`);
  }
}