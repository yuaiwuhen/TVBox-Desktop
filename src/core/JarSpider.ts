/**
 * JarSpider - JAR Spider implementation for renderer process
 *
 * Implements ISpider interface by communicating with main process via IPC.
 * Main process uses JarLoader to load JAR files and invoke Spider methods.
 */

import type { ISpider } from './models';
import { useLoading } from '../composables/useLoading';

// Electron IPC bridge - available in renderer with contextIsolation=false
declare global {
  interface Window {
    electronIPC?: {
      invoke: (channel: string, ...args: any[]) => Promise<any>;
      on: (channel: string, listener: (...args: any[]) => void) => () => void;
    };
  }
}

// Get IPC interface
function getIPC(): Window['electronIPC'] {
  if (window.electronIPC) {
    return window.electronIPC;
  }

  try {
    const { ipcRenderer } = require('electron');
    return {
      invoke: (channel: string, ...args: any[]) =>
        ipcRenderer.invoke(channel, ...args),
      on: (channel: string, listener: (...args: any[]) => void) => {
        const wrappedListener = (_event: any, ...args: any[]) =>
          listener(...args);
        ipcRenderer.on(channel, wrappedListener);
        return () => ipcRenderer.removeListener(channel, wrappedListener);
      },
    };
  } catch {
    console.warn('[JarSpider] Electron IPC not available');
    return undefined;
  }
}

export class JarSpider implements ISpider {
  private key: string;
  private className: string;
  private ext: string;
  private jarUrl: string;
  private initialized: boolean = false;
  private progressUnsub: (() => void) | null = null;
  private abortController: AbortController | null = null;

  constructor(key: string, className: string, jarUrl: string, ext?: string) {
    this.key = key;
    this.className = className;
    this.jarUrl = jarUrl;
    this.ext = ext || '';
    console.log(
      '[JarSpider] Created:',
      key,
      'class:',
      className,
      'jar:',
      jarUrl,
    );
  }

  /**
   * Initialize spider
   */
  async init(extend: string): Promise<void> {
    this.ext = extend || this.ext;

    console.log('[JarSpider] init called:', {
      key: this.key,
      className: this.className,
      jarUrl: this.jarUrl,
      extPreview: this.ext.substring(0, 80),
    });

    const ipc = getIPC();
    console.log('[JarSpider] IPC available:', !!ipc);
    if (!ipc) {
      throw new Error('[JarSpider] IPC not available');
    }

    // Show loading progress
    const loading = useLoading();
    const taskId = `jar-${this.key}`;
    loading.start(taskId, `加载爬虫: ${this.className}`);

    // Listen for progress events
    if (ipc.on) {
      this.progressUnsub = ipc.on('jar:progress', (data: any) => {
        if (data && typeof data === 'object') {
          loading.update(taskId, data.stage, data.message, data.percent);
        }
      });
    }

    try {
      // Step 1: Load JAR
      console.log('[JarSpider] Step 1: Loading JAR...');
      console.log('[JarSpider] jarUrl:', this.jarUrl);
      const loadResult = await ipc.invoke('jar:load', this.jarUrl, '', false);
      console.log('[JarSpider] jar:load result:', loadResult);
      if (!loadResult?.success) {
        const errorMsg =
          loadResult?.error || `Failed to load JAR: ${this.jarUrl}`;
        console.error('[JarSpider] JAR load failed:', errorMsg);
        loading.fail(taskId, errorMsg);
        throw new Error(`[JarSpider] ${errorMsg}`);
      }

      // Step 2: Get Spider instance
      console.log('[JarSpider] Step 2: Getting spider:', this.className);
      const spiderResult = await ipc.invoke(
        'jar:getSpider',
        this.key,
        this.className,
        this.ext,
        this.jarUrl,
      );
      console.log('[JarSpider] jar:getSpider result:', spiderResult);
      if (!spiderResult?.success) {
        const errorMsg =
          spiderResult?.error || `Failed to get spider: ${this.className}`;
        console.error('[JarSpider] Spider get failed:', errorMsg);
        loading.fail(taskId, errorMsg);
        throw new Error(`[JarSpider] ${errorMsg}`);
      }

      // Step 3: Initialize spider with ext config
      console.log(
        '[JarSpider] Step 3: Initializing spider with ext:',
        this.ext.substring(0, 80),
      );
      await ipc.invoke('jar:initSpider', this.key, this.ext);

      this.initialized = true;
      console.log('[JarSpider] Initialized successfully:', this.key);

      // Debug: list all methods
      try {
        const methods = await this.listMethods();
        console.log(
          `[JarSpider] ${this.key} methods (${methods.length}):`,
          methods.join(', '),
        );
      } catch (e) {
        console.warn('[JarSpider] Failed to list methods:', e);
      }

      loading.finish(taskId, true);
    } catch (e) {
      console.error('[JarSpider] Init failed:', this.key, e);
      loading.fail(taskId, e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      if (this.progressUnsub) {
        this.progressUnsub();
        this.progressUnsub = null;
      }
    }
  }

  /**
   * Call spider method via IPC
   */
  private async callMethod(method: string, args: any[]): Promise<string> {
    if (method === 'playerContent') {
      console.log('[JarSpider] callMethod playerContent ENTER', {
        initialized: this.initialized,
        key: this.key,
        argsPreview: args.map((a) =>
          typeof a === 'string' ? a.substring(0, 80) : typeof a,
        ),
      });
    }
    if (!this.initialized) {
      console.warn(
        `[JarSpider] callMethod ${method}: not initialized, returning {}`,
      );
      return '{}';
    }

    const ipc = getIPC();
    if (!ipc) {
      console.warn(`[JarSpider] callMethod ${method}: no IPC, returning {}`);
      return '{}';
    }

    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    try {
      let extraCookies: Record<string, string> | undefined;
      if (method === 'playerContent' && args.length > 0) {
        const panTypes = ['quark', 'uc', 'aliyun', 'baidu', 'bili'];
        extraCookies = {};
        for (const pt of panTypes) {
          try {
            const saved = localStorage.getItem(`pan_login_${pt}`);
            if (saved) {
              const parsed = JSON.parse(saved);
              if (parsed.cookie) {
                extraCookies[pt] = parsed.cookie;
              }
            }
          } catch {}
        }
        console.log(
          '[JarSpider] playerContent extraCookies keys:',
          Object.keys(extraCookies),
        );
      }

      const timeoutPromise = new Promise<string>((_, reject) => {
        setTimeout(() => {
          if (this.abortController) {
            this.abortController.abort();
          }
          reject(new Error(`${method} timed out`));
        }, 30000);
      });

      if (method === 'playerContent') {
        console.log('[JarSpider] invoking jar:callMethod for playerContent...');
      }
      const resultPromise = ipc.invoke(
        'jar:callMethod',
        this.key,
        method,
        args,
        extraCookies,
      );

      const result = await Promise.race([resultPromise, timeoutPromise]);
      const resultStr = result || '{}';
      if (method === 'playerContent') {
        console.log('[JarSpider] playerContent result:', {
          resultLength: resultStr.length,
          resultPreview: resultStr.substring(0, 200),
          isEmpty: resultStr === '{}',
        });
      }
      return resultStr;
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        console.warn(`[JarSpider] callMethod ${method} failed:`, e.message);
      } else {
        console.warn(`[JarSpider] callMethod ${method} aborted`);
      }
      return '{}';
    }
  }

  async homeContent(filter: boolean): Promise<string> {
    return this.callMethod('homeContent', [filter]);
  }

  async homeVideoContent(): Promise<string> {
    return this.callMethod('homeVideoContent', []);
  }

  async categoryContent(
    tid: string,
    pg: string,
    filter: boolean,
    extend: Record<string, string>,
  ): Promise<string> {
    return this.callMethod('categoryContent', [tid, pg, filter, extend]);
  }

  async detailContent(ids: string[]): Promise<string> {
    return this.callMethod('detailContent', [ids]);
  }

  async searchContent(
    key: string,
    quick: boolean,
    pg?: string,
  ): Promise<string> {
    if (pg !== undefined) {
      return this.callMethod('searchContent', [key, quick, pg]);
    }
    return this.callMethod('searchContent', [key, quick]);
  }

  async playerContent(
    flag: string,
    id: string,
    vipFlags: string[],
  ): Promise<string> {
    const raw = await this.callMethod('playerContent', [flag, id, vipFlags]);
    // Post-process: if the spider failed to extract a URL but the input id
    // already contains a playable URL with a parser-suffix (e.g. "...m3u8|lzm3u8"),
    // strip the suffix and return the URL directly. This fixes csp_Wwys and
    // similar sources where the upstream parser page format changed and the
    // JAR regex no longer extracts a stream URL.
    try {
      const parsed = JSON.parse(raw);
      const url: string = parsed?.url || '';
      if (!url && id && id.includes('|')) {
        const [realUrl, suffix] = id.split('|');
        // Only treat as playable URL if it ends with a known media format
        // and the suffix is a known parser tag (lzm3u8, lzmp4, etc.).
        if (
          realUrl &&
          /\.(m3u8|mp4|flv|ts)(\?|$)/i.test(realUrl) &&
          /^(lz)?m3u8$|^(lz)?mp4$|^flv$/i.test(suffix || '')
        ) {
          console.log(
            '[JarSpider] playerContent fallback: spider returned empty url, using id directly:',
            { suffix, urlPreview: realUrl.substring(0, 100) },
          );
          const fallback = {
            ...parsed,
            url: realUrl,
            parse: 0,
            jx: 0,
            header: parsed.header || JSON.stringify({
              'User-Agent':
                'Mozilla/5.0 (Linux; Android 13; SM-A037U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36  uacq',
            }),
          };
          return JSON.stringify(fallback);
        }
      }
    } catch {
      // Not JSON or no url field — return raw result as-is.
    }
    return raw;
  }

  async listMethods(): Promise<string[]> {
    try {
      const ipc = getIPC();
      if (!ipc) return [];
      const result = await ipc.invoke('jar:listSpiderMethods', this.key);
      const parsed = JSON.parse(result);
      return parsed.methods || [];
    } catch (e) {
      console.error('[JarSpider] listMethods failed:', e);
      return [];
    }
  }

  async isVideoFormat(url: string): Promise<boolean> {
    try {
      const result = await this.callMethod('isVideoFormat', [url]);
      const parsed = JSON.parse(result);
      return parsed === true;
    } catch {
      return false;
    }
  }

  async manualVideoCheck(): Promise<boolean> {
    try {
      const result = await this.callMethod('manualVideoCheck', []);
      const parsed = JSON.parse(result);
      return parsed === true;
    } catch {
      return false;
    }
  }

  async action(actionId: string, actionData: any): Promise<string> {
    return this.callMethod('action', [actionId, actionData]);
  }

  destroy(): void {
    this.initialized = false;
    if (this.progressUnsub) {
      this.progressUnsub();
      this.progressUnsub = null;
    }
    console.log('[JarSpider] Destroyed:', this.key);
  }
}
