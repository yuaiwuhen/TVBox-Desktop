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
  private loadedSpiders: Map<string, any> = new Map();

  constructor(baseURL: string = 'http://127.0.0.1:19978') {
    this.baseURL = baseURL;
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

    console.log(`[SpiderAPIClient] Initialized with baseURL: ${baseURL}`);
  }

  /**
   * Retry wrapper — NanoHTTPD occasionally resets connections when the
   * Android process is busy (e.g. loading DEX classes). Retry up to 3 times
   * with a short delay to ride through transient ECONNRESET errors.
   */
  private async requestWithRetry<T>(
    fn: () => Promise<T>,
    label: string,
    retries = 3,
  ): Promise<T> {
    let lastError: any;
    for (let i = 1; i <= retries; i++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        const isConnReset =
          error.code === 'ECONNRESET' ||
          error.message?.includes('ECONNRESET') ||
          error.message?.includes('socket hang up');
        if (!isConnReset || i === retries) {
          throw error;
        }
        console.warn(
          `[SpiderAPIClient] ${label} attempt ${i} failed (ECONNRESET), retrying...`,
        );
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw lastError;
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
   * 加载Spider JAR文件
   *
   * Multi-JAR handling: libwexguard.so can only be loaded ONCE per process.
   * When the JAR URL changes, the spider server returns "RESTARTING" and
   * kills itself. Android restarts the service automatically. We wait for
   * the server to come back up, then retry the loadJar request.
   *
   * Restart detection: We use the `startedAt` timestamp in /health to verify
   * the process actually restarted (instead of just checking /health succeeds,
   * which would falsely detect the OLD server as restarted).
   */
  async loadJar(jarUrl: string, jarPath?: string): Promise<any> {
    const maxAttempts = 4;
    let lastError: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(
          `[SpiderAPIClient] Loading JAR (attempt ${attempt}): ${jarUrl}`,
        );

        // Capture current startedAt BEFORE calling /spider/load so we can
        // detect when the process has actually restarted.
        const prevStartedAt = await this.getServerStartedAt();

        const response = await this.requestWithRetry(
          () =>
            this.axiosInstance.post('/spider/load', {
              jarUrl,
              jarPath,
            }),
          `loadJar(${jarUrl})`,
        );

        const data = response.data;
        // Check for restart signal — server is killing itself for JAR reload.
        if (
          data &&
          !data.success &&
          typeof data.error === 'string' &&
          data.error.startsWith('RESTARTING')
        ) {
          console.warn(
            `[SpiderAPIClient] Server restarting for JAR reload. Waiting for new process...`,
          );
          const restarted = await this.waitForServerRestart(
            prevStartedAt,
            90000,
          );
          if (!restarted) {
            console.warn(
              `[SpiderAPIClient] Server did not restart within timeout, retrying...`,
            );
            continue;
          }
          console.log(
            `[SpiderAPIClient] Server restarted (new startedAt detected), retrying loadJar...`,
          );
          continue; // retry
        }

        console.log('[SpiderAPIClient] JAR loaded:', data);
        return data;
      } catch (error: any) {
        lastError = error;
        // If connection refused, server might be restarting — wait and retry.
        if (
          error.code === 'ECONNRESET' ||
          error.code === 'ECONNREFUSED' ||
          error.message?.includes('socket hang up')
        ) {
          console.warn(
            `[SpiderAPIClient] loadJar connection error, waiting for server...`,
          );
          await this.waitForServer(30000);
          continue;
        }
        console.error('[SpiderAPIClient] Failed to load JAR:', error.message);
        throw error;
      }
    }
    throw lastError || new Error('loadJar failed after retries');
  }

  /**
   * Get the current server's startedAt timestamp.
   * Returns 0 if the server is unreachable or the field is missing.
   */
  private async getServerStartedAt(): Promise<number> {
    try {
      const r = await this.axiosInstance.get('/health', { timeout: 3000 });
      if (r.data && r.data.success && r.data.data) {
        const d =
          typeof r.data.data === 'string'
            ? JSON.parse(r.data.data)
            : r.data.data;
        return d.startedAt || 0;
      }
    } catch {
      // ignore
    }
    return 0;
  }

  /**
   * Wait for the spider server to respond to /health.
   * Used after a process restart to know when the server is back up.
   */
  async waitForServer(timeoutMs: number = 30000): Promise<void> {
    const start = Date.now();
    const pollInterval = 1000;
    while (Date.now() - start < timeoutMs) {
      try {
        await this.axiosInstance.get('/health', { timeout: 2000 });
        console.log('[SpiderAPIClient] Server is back up');
        // Give the server a moment to fully initialize before accepting requests.
        await new Promise((r) => setTimeout(r, 1000));
        return;
      } catch {
        await new Promise((r) => setTimeout(r, pollInterval));
      }
    }
    console.warn(
      '[SpiderAPIClient] Server did not come back up within timeout',
    );
  }

  /**
   * Wait for the spider server to restart (process actually restarted,
   * not just /health succeeding on the OLD server).
   *
   * Phases:
   *   1. Wait for OLD server to die (max 12s — scheduleProcessRestart delay is 1.5s)
   *   2. Wait for NEW server with different startedAt (max 90s)
   */
  private async waitForServerRestart(
    prevStartedAt: number,
    timeoutMs: number = 90000,
  ): Promise<boolean> {
    // Phase 1: Wait for old server to die
    const dieStart = Date.now();
    while (Date.now() - dieStart < 12000) {
      const cur = await this.getServerStartedAt();
      if (cur === 0) break; // Server dead
      await new Promise((r) => setTimeout(r, 500));
    }
    // Phase 2: Wait for new server with different startedAt
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const cur = await this.getServerStartedAt();
      if (cur !== 0 && cur !== prevStartedAt) {
        // Server restarted — give it a moment to fully initialize
        await new Promise((r) => setTimeout(r, 2000));
        return true;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }

  /**
   * Explicitly restart the spider server. Useful when switching configs.
   */
  async restartServer(): Promise<void> {
    try {
      console.log('[SpiderAPIClient] Restarting spider server...');
      await this.axiosInstance.post('/spider/restart', {}, { timeout: 5000 });
    } catch {
      // Connection will be reset as the process dies — that's expected.
    }
    await this.waitForServer(30000);
  }

  /**
   * 初始化Spider实例
   */
  async initSpider(
    key: string,
    className: string,
    ext: string,
    jarUrl: string,
  ): Promise<any> {
    try {
      console.log(`[SpiderAPIClient] Initializing spider: ${key}`);

      const response = await this.requestWithRetry(
        () =>
          this.axiosInstance.post('/spider/init', {
            key,
            className,
            ext,
            jarUrl,
          }),
        `initSpider(${key})`,
      );

      console.log('[SpiderAPIClient] Spider initialized:', response.data);

      if (response.data && response.data.success) {
        this.loadedSpiders.set(key, response.data.data);
      }

      return response.data;
    } catch (error: any) {
      console.error('[SpiderAPIClient] Failed to init spider:', error.message);
      throw error;
    }
  }

  /**
   * 获取首页内容
   */
  async homeContent(
    key: string,
    filter: boolean = true,
  ): Promise<HomeContentResult> {
    try {
      console.log(`[SpiderAPIClient] Getting home content for: ${key}`);

      const response = await this.requestWithRetry(
        () =>
          this.axiosInstance.post('/spider/homeContent', {
            key,
            filter,
          }),
        `homeContent(${key})`,
      );

      console.log('[SpiderAPIClient] Home content response:', response.data);

      if (response.data && response.data.success && response.data.data) {
        return response.data.data;
      }

      throw new Error('Invalid home content response');
    } catch (error: any) {
      console.error(
        '[SpiderAPIClient] Failed to get home content:',
        error.message,
      );
      throw error;
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

      this.loadedSpiders.delete(key);

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
   * (例如 Quark/UC/Baidu pan spider 在 playerContent 中读取的硬解码、
   * 播放速度等)，确保 PC 端设置的播放参数对 JAR 播放器同样生效。
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
   * Push netdisk login credentials to the JAR. The JAR stores them in
   * SharedPreferences — the PC never persists credentials locally.
   *
   * panType: "quark" | "uc" | "baidu" | "bili" | "aliyun"
   * cookie:  cookie string (quark/uc/baidu/bili)
   * refreshToken / accessToken: aliyun-specific
   */
  async saveLogin(params: {
    panType: string;
    cookie?: string;
    refreshToken?: string;
    accessToken?: string;
    userId?: string;
    nickname?: string;
  }): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      const response = await this.axiosInstance.post('/spider/saveLogin', {
        panType: params.panType,
        cookie: params.cookie || '',
        refreshToken: params.refreshToken || '',
        accessToken: params.accessToken || '',
        userId: params.userId || '',
        nickname: params.nickname || '',
      });
      return {
        success: !!(response.data && response.data.success),
        data: response.data?.data,
      };
    } catch (error: any) {
      console.warn(
        `[SpiderAPIClient] saveLogin(${params.panType}) failed: ${error.message}`,
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Query whether a panType is logged in. Returns loggedIn + display info
   * (userId/nickname). Does NOT return the cookie itself.
   */
  async loginStatus(panType: string): Promise<{
    success: boolean;
    data?: { loggedIn: boolean; info?: any };
    error?: string;
  }> {
    try {
      const response = await this.axiosInstance.post('/spider/loginStatus', {
        panType,
      });
      return {
        success: !!(response.data && response.data.success),
        data: response.data?.data,
      };
    } catch (error: any) {
      console.warn(
        `[SpiderAPIClient] loginStatus(${panType}) failed: ${error.message}`,
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Clear all stored credentials for a panType. Used by the PC's logout
   * button — the PC never touches SharedPreferences directly.
   */
  async logout(panType: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.axiosInstance.post('/spider/logout', {
        panType,
      });
      return { success: !!(response.data && response.data.success) };
    } catch (error: any) {
      console.warn(
        `[SpiderAPIClient] logout(${panType}) failed: ${error.message}`,
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Retrieve credentials for a panType from the JAR.
   *
   * Only aliyun returns actual tokens (refreshToken/accessToken) — the PC-side
   * AliyunPanService needs them for share resolution since there is no JAR-side
   * Aliyun spider. For quark/uc/baidu/bili, the JAR's spiders read
   * SharedPreferences directly and the PC never needs the cookie.
   */
  async getLogin(panType: string): Promise<{
    success: boolean;
    data?: { loggedIn: boolean; refreshToken?: string; accessToken?: string };
    error?: string;
  }> {
    try {
      const response = await this.axiosInstance.post('/spider/getLogin', {
        panType,
      });
      return {
        success: !!(response.data && response.data.success),
        data: response.data?.data,
      };
    } catch (error: any) {
      console.warn(
        `[SpiderAPIClient] getLogin(${panType}) failed: ${error.message}`,
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate a QR code for netdisk login. The JAR fetches the QR token
   * from the netdisk API and returns the scan URL (or, for Baidu, an
   * already-rendered QR image URL). The PC generates the QR image
   * locally from `scanUrl` (or displays `imageUrl` directly for Baidu).
   *
   * panType: "quark" | "uc" | "aliyun" | "baidu" | "bili"
   *
   * Returns:
   *   { success, data: { scanUrl?, imageUrl?, qrToken, extra } }
   *   - scanUrl:  content to encode as a QR code (Quark/UC/Aliyun/Bili)
   *   - imageUrl: URL to a server-rendered QR image (Baidu)
   */
  async generateQRCode(panType: string): Promise<{
    success: boolean;
    data?: {
      scanUrl?: string;
      imageUrl?: string;
      qrToken: string;
      extra?: Record<string, string>;
    };
    error?: string;
  }> {
    try {
      const response = await this.axiosInstance.post(
        '/spider/generateQRCode',
        { panType },
        { timeout: 30000 },
      );
      return {
        success: !!(response.data && response.data.success),
        data: response.data?.data,
      };
    } catch (error: any) {
      console.warn(
        `[SpiderAPIClient] generateQRCode(${panType}) failed: ${error.message}`,
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Poll the netdisk QR login status. On confirmed, the JAR auto-saves
   * the credentials to SharedPreferences — the PC never sees the cookie.
   *
   * Returns:
   *   { success, data: { status, loginInfo? } }
   *   status: "waiting" | "scanned" | "confirmed" | "expired" | "error"
   */
  async pollQRLogin(
    panType: string,
    qrToken: string,
    extra?: Record<string, string>,
  ): Promise<{
    success: boolean;
    data?: {
      status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';
      loginInfo?: {
        cookie?: string;
        refreshToken?: string;
        accessToken?: string;
        userId?: string;
        nickname?: string;
      };
    };
    error?: string;
  }> {
    try {
      const response = await this.axiosInstance.post(
        '/spider/pollQRLogin',
        { panType, qrToken, extra: extra || {} },
        { timeout: 30000 },
      );
      return {
        success: !!(response.data && response.data.success),
        data: response.data?.data,
      };
    } catch (error: any) {
      console.warn(
        `[SpiderAPIClient] pollQRLogin(${panType}) failed: ${error.message}`,
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取已加载的Spider列表
   */
  getLoadedSpiders(): Map<string, any> {
    return this.loadedSpiders;
  }

  /**
   * 从配置文件加载并初始化所有Spider
   */
  async loadSpidersFromConfig(configUrl: string): Promise<void> {
    try {
      console.log(`[SpiderAPIClient] Loading config from: ${configUrl}`);

      // 获取配置文件
      const response = await axios.get(configUrl, {
        headers: {
          'User-Agent': 'okhttp/4.9.3',
        },
        timeout: 30000,
      });

      const config = response.data;
      console.log(
        '[SpiderAPIClient] Config loaded, fields:',
        Object.keys(config),
      );

      // 提取JAR URL（格式：url;md5;hash）
      let jarUrl = config.spider || '';
      if (jarUrl.includes(';')) {
        jarUrl = jarUrl.split(';')[0];
      }
      console.log('[SpiderAPIClient] JAR URL:', jarUrl);

      if (!jarUrl) {
        throw new Error('No spider JAR URL found in config');
      }

      // 获取sites列表（实际Spider列表）
      const sites = config.sites || config.spiderList || [];
      console.log('[SpiderAPIClient] Sites count:', sites.length);

      if (!sites || sites.length === 0) {
        throw new Error('No sites found in config');
      }

      // 加载JAR文件
      await this.loadJar(jarUrl);

      // 初始化Spider — 只需要成功加载第一个即可显示首页数据。
      // 配置中可能包含大量site（此配置88个），逐个初始化会非常慢且
      // 容易触发NanoHTTPD连接问题。首页数据来自第一个可用的spider。
      let successCount = 0;
      for (const site of sites) {
        if (!site.api || !site.api.startsWith('csp_')) {
          continue;
        }
        try {
          console.log(
            `[SpiderAPIClient] Processing site: ${site.key} (${site.name}), api: ${site.api}`,
          );

          const ext = site.ext || '';
          await this.initSpider(site.key, site.api, ext, jarUrl);

          console.log(`[SpiderAPIClient] Site ${site.key} loaded successfully`);
          successCount++;

          // 首页只需要一个可用的spider即可
          break;
        } catch (error: any) {
          console.error(
            `[SpiderAPIClient] Failed to load site ${site.key}:`,
            error.message,
          );
          // 继续尝试下一个site
        }
      }

      console.log(
        `[SpiderAPIClient] Spiders loaded: ${successCount}/${sites.length}`,
      );
    } catch (error: any) {
      console.error('[SpiderAPIClient] Failed to load config:', error.message);
      throw error;
    }
  }
}

// 导出单例
export const spiderAPIClient = new SpiderAPIClient();
