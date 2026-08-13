/**
 * Spider HTTP API Client
 * 负责与Android容器内的SpiderHttpServer通信
 */

import axios, { AxiosInstance } from 'axios';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';

export interface SpiderConfig {
  spiderList: SpiderItem[];
}

export interface SpiderItem {
  key: string;
  name: string;
  api: string;
  ext?: string;
  type?: string;
  searchable?: number;
  quickSearch?: number;
  filterable?: number;
}

export interface HomeContentResult {
  classes: Array<{
    type_id: string;
    type_name: string;
  }>;
  list: any[];
  filters?: Record<string, any>;
}

export interface CategoryContentResult {
  list: any[];
  page: number;
  pagecount: number;
  total?: number;
}

export interface DetailContentResult {
  list: any[];
}

export interface PlayerContentResult {
  parse: number;
  url: string;
  header?: string;
  flags?: string[];
}

export class SpiderAPIClient {
  private axiosInstance: AxiosInstance;
  private baseURL: string;

  constructor(baseURL: string = 'http://127.0.0.1:19978') {
    this.setBaseURL(baseURL);
    console.log(`[SpiderAPIClient] Initialized with baseURL: ${baseURL}`);
  }

  getBaseUrl(): string {
    return this.baseURL;
  }

  setBaseURL(baseURL: string): void {
    if (this.baseURL === baseURL && this.axiosInstance) return;
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.axiosInstance = axios.create({
      baseURL: this.baseURL,
      timeout: 120000,
      headers: {
        'Content-Type': 'application/json',
        // NanoHTTPD can drop keep-alive connections; force close to avoid
        // ECONNRESET when the server reaps idle sockets between requests.
        Connection: 'close',
      },
    });
    console.log(`[SpiderAPIClient] baseURL updated: ${this.baseURL}`);
  }

  /**
   * 测试Spider服务健康状态
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.axiosInstance.get('/health');
      console.log('[SpiderAPIClient] Health check response:', response.data);
      return response.data && response.data.success;
    } catch (error: any) {
      console.error('[SpiderAPIClient] Health check failed:', error.message);
      return false;
    }
  }

  /**
   * 获取分类内容
   */
  async categoryContent(
    key: string,
    tid: string,
    pg: string = '1',
    filter: boolean = true,
    extend: Record<string, string> = {},
  ): Promise<CategoryContentResult> {
    try {
      console.log(
        `[SpiderAPIClient] Getting category content: ${key}, tid=${tid}, pg=${pg}`,
      );

      const response = await this.axiosInstance.post(
        '/spider/categoryContent',
        {
          key,
          tid,
          pg,
          filter,
          extend,
        },
      );

      console.log(
        '[SpiderAPIClient] Category content response:',
        response.data,
      );

      if (response.data && response.data.success && response.data.data) {
        return response.data.data;
      }

      throw new Error('Invalid category content response');
    } catch (error: any) {
      console.error(
        '[SpiderAPIClient] Failed to get category content:',
        error.message,
      );
      throw error;
    }
  }

  /**
   * 获取详情内容
   */
  async detailContent(
    key: string,
    ids: string[],
  ): Promise<DetailContentResult> {
    try {
      console.log(
        `[SpiderAPIClient] Getting detail content: ${key}, ids=${ids.join(',')}`,
      );

      const response = await this.axiosInstance.post('/spider/detailContent', {
        key,
        ids,
      });

      console.log('[SpiderAPIClient] Detail content response:', response.data);

      if (response.data && response.data.success && response.data.data) {
        return response.data.data;
      }

      throw new Error('Invalid detail content response');
    } catch (error: any) {
      console.error(
        '[SpiderAPIClient] Failed to get detail content:',
        error.message,
      );
      throw error;
    }
  }

  /**
   * 获取播放内容
   */
  async playerContent(
    key: string,
    flag: string,
    id: string,
    vipFlags: string[] = [],
  ): Promise<PlayerContentResult> {
    try {
      console.log(
        `[SpiderAPIClient] Getting player content: ${key}, flag=${flag}, id=${id}`,
      );

      const response = await this.axiosInstance.post('/spider/playerContent', {
        key,
        flag,
        id,
        vipFlags,
      });

      console.log('[SpiderAPIClient] Player content response:', response.data);

      if (response.data && response.data.success && response.data.data) {
        return response.data.data;
      }

      throw new Error('Invalid player content response');
    } catch (error: any) {
      console.error(
        '[SpiderAPIClient] Failed to get player content:',
        error.message,
      );
      throw error;
    }
  }

  /**
   * 搜索内容
   */
  async searchContent(
    key: string,
    keyword: string,
    quick: boolean = false,
    pg?: string,
  ): Promise<any> {
    try {
      console.log(
        `[SpiderAPIClient] Searching content: ${key}, keyword=${keyword}`,
      );

      const requestData: any = {
        key,
        keyword,
        quick,
      };

      if (pg) {
        requestData.pg = pg;
      }

      const response = await this.axiosInstance.post(
        '/spider/searchContent',
        requestData,
      );

      console.log('[SpiderAPIClient] Search content response:', response.data);

      if (response.data && response.data.success && response.data.data) {
        return response.data.data;
      }

      throw new Error('Invalid search content response');
    } catch (error: any) {
      console.error(
        '[SpiderAPIClient] Failed to search content:',
        error.message,
      );
      throw error;
    }
  }

  /**
   * 销毁Spider实例
   */
  async destroy(key: string): Promise<any> {
    try {
      console.log(`[SpiderAPIClient] Destroying spider: ${key}`);

      const response = await this.axiosInstance.post('/spider/destroy', {
        key,
      });

      console.log('[SpiderAPIClient] Spider destroyed:', response.data);

      return response.data;
    } catch (error: any) {
      console.error(
        '[SpiderAPIClient] Failed to destroy spider:',
        error.message,
      );
      throw error;
    }
  }

  /**
   * 同步播放偏好到 Android SharedPreferences。
   * SpiderHttpServer 收到后会写入 JAR spiders 可读的 SharedPreferences
   * (例如硬解码、播放速度等)，确保 PC 端设置的播放参数对 JAR 播放器同样生效。
   * 失败不影响 PC 端播放，只打印警告。
   */
  async setPref(key: string, value: string): Promise<boolean> {
    try {
      const response = await this.axiosInstance.post('/spider/setPref', {
        key,
        value,
      });
      return response.data && response.data.success;
    } catch (error: any) {
      console.warn(
        `[SpiderAPIClient] setPref(${key}) failed: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Resolve a proxy stream to concrete playback info (Android-side).
   *
   * The Android SpiderHttpServer executes the JAR spider's proxy() with the
   * given `do` action and params, captures the final HTTP request (via an
   * OkHttp interceptor) and returns:
   *   { url, headers, mime, type, body }
   * - body is present when the JAR returns an m3u8/ts manifest (decrypted /
   *   rewritten to absolute segment URLs so the PC player can fetch directly).
   * - url+headers+type are used for direct streaming playback.
   */
  async resolve(params: {
    do: string;
    [key: string]: string | number;
  }): Promise<{
    success: boolean;
    data?: {
      url?: string;
      headers?: Record<string, string>;
      mime?: string;
      type?: string;
      body?: string;
      error?: string;
    };
    error?: string;
  }> {
    try {
      const response = await this.axiosInstance.post('/spider/resolve', params, {
        timeout: 60000,
      });
      return {
        success: !!(response.data && response.data.success),
        data: response.data?.data,
      };
    } catch (error: any) {
      console.warn(
        `[SpiderAPIClient] setPref(${key}) failed: ${error.message}`,
      );
      return false;
    }
  }
}

// 导出单例
export const spiderAPIClient = new SpiderAPIClient();

// Apply configured spider API address (Mac/Linux users set their own
// Android runtime address; Windows defaults to the MuMu adb forward).
export function applyConfiguredSpiderBaseUrl(): void {
  try {
    const { loadConfigFromFile } = require('./ConfigPersistence');
    const config = loadConfigFromFile();
    const configured = config['spiderApiBaseUrl'];
    if (configured && configured.trim()) {
      spiderAPIClient.setBaseURL(configured.trim());
    } else {
      spiderAPIClient.setBaseURL('http://127.0.0.1:19978');
    }
  } catch (e: any) {
    console.warn(
      '[SpiderAPIClient] Failed to apply configured base URL:',
      e?.message,
    );
  }
}
