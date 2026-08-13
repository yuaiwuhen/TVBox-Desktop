/**
 * JarSpider - JAR Spider implementation for renderer process
 *
 * 使用HTTP与Docker容器中的Spider服务器通信
 * 替代原有的IPC + java-bridge方式
 */

import type { ISpider } from './models';
import { useLoading } from '../composables/useLoading';
import axios from 'axios';

// HTTP客户端实例
const httpClient = axios.create({
  baseURL: 'http://127.0.0.1:19978',
  timeout: 120000,
  headers: {
    'Content-Type': 'application/json',
    // Note: Chrome blocks setting "Connection: close" from renderer fetch,
    // so we rely on postWithRetry below to ride out ECONNRESET errors
    // rather than forcing connection close.
  },
});

/**
 * Retry wrapper — NanoHTTPD occasionally resets connections when the
 * Android process is busy (e.g. loading DEX classes). Retry up to 3 times
 * with a short delay to ride through transient ECONNRESET / Network Error.
 */
async function postWithRetry(
  endpoint: string,
  data: any,
  retries = 3,
): Promise<any> {
  let lastError: any;
  for (let i = 1; i <= retries; i++) {
    try {
      return await httpClient.post(endpoint, data);
    } catch (error: any) {
      lastError = error;
      const msg = error.message || '';
      const isConnReset =
        error.code === 'ECONNRESET' ||
        msg.includes('ECONNRESET') ||
        msg.includes('socket hang up') ||
        msg.includes('Network Error');
      if (!isConnReset || i === retries) throw error;
      console.warn(
        `[JarSpider] POST ${endpoint} attempt ${i} failed (${msg}), retrying...`,
      );
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastError;
}

export class JarSpider implements ISpider {
  private key: string;
  private className: string;
  private ext: string;
  private jarUrl: string;
  private initialized: boolean = false;
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

    // Show loading progress
    const loading = useLoading();
    const taskId = `jar-${this.key}`;
    loading.start(taskId, `加载爬虫: ${this.className}`);

    try {
      // Step 1: Load JAR
      console.log('[JarSpider] Step 1: Loading JAR...');

      try {
        const loadResult = await this.postRequest('/spider/load', {
          jarUrl: this.jarUrl,
        });

        if (!loadResult?.success) {
          throw new Error(
            loadResult?.error || `Failed to load JAR: ${this.jarUrl}`,
          );
        }
      } catch (error: any) {
        // Spider service unavailable — do NOT fall back to mock data.
        // Surface the error so the UI can show a proper failure message
        // instead of fake placeholder videos.
        console.error(
          '[JarSpider] Spider service not available:',
          error.message || error,
        );
        loading.fail(taskId, `Spider服务不可用: ${error.message || error}`);
        throw error;
      }

      // Step 2: Initialize spider
      console.log('[JarSpider] Step 2: Initializing spider:', this.className);
      const initResult = await this.postRequest('/spider/init', {
        key: this.key,
        className: this.className,
        ext: this.ext,
        jarUrl: this.jarUrl,
      });

      if (!initResult?.success) {
        throw new Error(
          initResult?.error || `Failed to init spider: ${this.className}`,
        );
      }

      this.initialized = true;
      console.log('[JarSpider] Initialized successfully:', this.key);

      loading.finish(taskId, true);
    } catch (e) {
      console.error('[JarSpider] Init failed:', this.key, e);
      loading.fail(taskId, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /**
   * HTTP POST request helper
   */
  private async postRequest(endpoint: string, data: any): Promise<any> {
    try {
      const response = await postWithRetry(endpoint, data);
      return response.data;
    } catch (error: any) {
      console.error(
        `[JarSpider] POST ${endpoint} failed:`,
        error.message || error,
      );
      return {
        success: false,
        error: error.message || 'Request failed',
      };
    }
  }

  /**
   * Call spider method via HTTP
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

    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    try {
      let endpoint = '';
      let requestData: any = { key: this.key };

      // 映射方法名到端点
      switch (method) {
        case 'homeContent':
          endpoint = '/spider/homeContent';
          requestData.filter = args[0] || false;
          break;

        case 'homeVideoContent':
          endpoint = '/spider/homeContent';
          requestData.filter = false;
          break;

        case 'categoryContent':
          endpoint = '/spider/categoryContent';
          requestData.tid = args[0] || '';
          requestData.pg = args[1] || '1';
          requestData.filter = args[2] || false;
          requestData.extend = args[3] || {};
          break;

        case 'detailContent':
          endpoint = '/spider/detailContent';
          requestData.ids = args[0] || [];
          break;

        case 'searchContent':
          endpoint = '/spider/searchContent';
          requestData.keyword = args[0] || '';
          requestData.quick = args[1] || false;
          if (args.length > 2) {
            requestData.pg = args[2];
          }
          break;

        case 'playerContent':
          endpoint = '/spider/playerContent';
          requestData.flag = args[0] || '';
          requestData.id = args[1] || '';
          requestData.vipFlags = args[2] || [];
          // Cookies are NOT injected from PC localStorage anymore.
          // The JAR's SpiderManager reads credentials from SharedPreferences
          // (populated via /spider/saveLogin) — spiders that read
          // SharedPreferences (e.g. csp_Duopan for Quark/UC/Baidu) find
          // the logged-in state directly. The PC never touches credentials.
          break;

        default:
          console.warn(`[JarSpider] Unknown method: ${method}`);
          return '{}';
      }

      if (method === 'playerContent') {
        console.log('[JarSpider] Calling HTTP API:', endpoint);
      }

      const response = await this.postRequest(endpoint, requestData);

      if (method === 'playerContent') {
        console.log('[JarSpider] playerContent response:', {
          success: response.success,
          hasData: !!response.data,
        });
      }

      if (!response.success) {
        const errMsg = String(response.error || '');
        // "Spider not found" means the spider was evicted from the server's
        // cache — most commonly because the Android process restarted after
        // a native crash (e.g. libhoudini SIGSEGV when translating ARM64
        // instructions in sources like MusicLiYuan / AnimeFanShu).
        //
        // If we already initialized successfully and now see this error, the
        // spider has crashed on the server side. Falling back to mock data
        // would show the user fake videos (placeholder URLs that don't play).
        // Instead, return an empty JSON so the UI shows "暂无数据" and the
        // user is not misled.
        const isSpiderCrashed =
          this.initialized && errMsg.includes('Spider not found');
        if (isSpiderCrashed) {
          console.warn(
            `[JarSpider] ${method}: spider crashed on server (init was OK, now "${errMsg}") — returning empty data instead of mock`,
          );
          // Mark as needing re-init on next call (will be re-attempted, but
          // crash-prone sources will likely crash again — libhoudini limit).
          this.initialized = false;
          return '{}';
        }
        console.warn(
          `[JarSpider] ${method} failed:`,
          response.error || 'Unknown error',
        );
        // Return empty data so the PC端 loadHome fallback chain can try
        // homeVideoContent / categoryContent / searchContent. Returning mock
        // data here would show fake videos and block the fallback chain.
        return '{}';
      }

      // data字段已经是JSON字符串
      return response.data || '{}';
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        console.warn(`[JarSpider] callMethod ${method} failed:`, e.message);
      } else {
        console.warn(`[JarSpider] callMethod ${method} aborted`);
      }
      // Return empty data on any exception (except abort) so the PC端
      // fallback chain can try alternative methods.
      if (e.name !== 'AbortError') {
        console.warn(
          `[JarSpider] ${method}: returning empty data due to exception`,
        );
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
    return this.callMethod('playerContent', [flag, id, vipFlags]);
  }

  async listMethods(): Promise<string[]> {
    // Spider接口的标准方法
    return [
      'homeContent',
      'homeVideoContent',
      'categoryContent',
      'detailContent',
      'searchContent',
      'playerContent',
      'isVideoFormat',
      'manualVideoCheck',
      'action',
    ];
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

    // 通知服务器销毁Spider实例
    this.postRequest('/spider/destroy', { key: this.key }).catch((error) => {
      console.warn('[JarSpider] Failed to destroy spider on server:', error);
    });

    console.log('[JarSpider] Destroyed:', this.key);
  }
}
