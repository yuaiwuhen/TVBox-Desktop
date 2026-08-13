/**
 * SpiderProxyService - HTTP客户端服务
 *
 * 通过HTTP与Docker容器中的Spider服务器通信
 * 替代原有的基于IPC的Java调用方式
 */

import axios, { AxiosInstance, AxiosError } from 'axios';

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

interface LoadRequest {
  jarUrl: string;
  jarPath?: string;
}

interface InitRequest {
  key: string;
  className: string;
  ext: string;
  jarUrl: string;
}

interface HomeContentRequest {
  key: string;
  filter: boolean;
}

interface CategoryContentRequest {
  key: string;
  tid: string;
  pg: string;
  filter: boolean;
  extend: Record<string, string>;
}

interface DetailContentRequest {
  key: string;
  ids: string[];
}

interface PlayerContentRequest {
  key: string;
  flag: string;
  id: string;
  vipFlags: string[];
}

interface SearchContentRequest {
  key: string;
  keyword: string;
  quick: boolean;
  pg?: string;
}

export class SpiderProxyService {
  private client: AxiosInstance;
  private baseUrl: string;
  private maxRetries: number = 3;
  private retryDelay: number = 1000;

  constructor(baseUrl: string = 'http://127.0.0.1:19978') {
    this.baseUrl = baseUrl;
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    console.log('[SpiderProxyService] Initialized with baseUrl:', baseUrl);
  }

  /**
   * 检查服务健康状态
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get<ApiResponse>('/health');
      return response.data.success;
    } catch (error) {
      console.error('[SpiderProxyService] Health check failed:', error);
      return false;
    }
  }

  /**
   * 加载JAR文件
   */
  async loadJar(jarUrl: string, jarPath?: string): Promise<ApiResponse> {
    const request: LoadRequest = { jarUrl, jarPath };
    return await this.postRequest('/spider/load', request);
  }

  /**
   * 初始化Spider
   */
  async initSpider(
    key: string,
    className: string,
    ext: string,
    jarUrl: string,
  ): Promise<ApiResponse> {
    const request: InitRequest = { key, className, ext, jarUrl };
    return await this.postRequest('/spider/init', request);
  }

  /**
   * 获取首页内容
   */
  async homeContent(key: string, filter: boolean): Promise<string> {
    const request: HomeContentRequest = { key, filter };
    const response = await this.postRequest<string>('/spider/homeContent', request);
    return response.data || '{}';
  }

  /**
   * 获取分类内容
   */
  async categoryContent(
    key: string,
    tid: string,
    pg: string,
    filter: boolean,
    extend: Record<string, string>,
  ): Promise<string> {
    const request: CategoryContentRequest = { key, tid, pg, filter, extend };
    const response = await this.postRequest<string>(
      '/spider/categoryContent',
      request,
    );
    return response.data || '{}';
  }

  /**
   * 获取详情内容
   */
  async detailContent(key: string, ids: string[]): Promise<string> {
    const request: DetailContentRequest = { key, ids };
    const response = await this.postRequest<string>(
      '/spider/detailContent',
      request,
    );
    return response.data || '{}';
  }

  /**
   * 获取播放链接
   */
  async playerContent(
    key: string,
    flag: string,
    id: string,
    vipFlags: string[],
  ): Promise<string> {
    const request: PlayerContentRequest = { key, flag, id, vipFlags };
    const response = await this.postRequest<string>(
      '/spider/playerContent',
      request,
    );
    return response.data || '{}';
  }

  /**
   * 搜索内容
   */
  async searchContent(
    key: string,
    keyword: string,
    quick: boolean,
    pg?: string,
  ): Promise<string> {
    const request: SearchContentRequest = { key, keyword, quick, pg };
    const response = await this.postRequest<string>(
      '/spider/searchContent',
      request,
    );
    return response.data || '{}';
  }

  /**
   * 销毁Spider
   */
  async destroySpider(key: string): Promise<void> {
    try {
      await this.postRequest('/spider/destroy', { key });
    } catch (error) {
      console.error('[SpiderProxyService] Failed to destroy spider:', error);
    }
  }

  /**
   * 发送POST请求（带重试机制）
   */
  private async postRequest<T = any>(
    endpoint: string,
    data: any,
  ): Promise<ApiResponse<T>> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(
          `[SpiderProxyService] POST ${endpoint} (attempt ${attempt}/${this.maxRetries})`,
        );

        const response = await this.client.post<ApiResponse<T>>(
          endpoint,
          data,
        );

        if (!response.data.success) {
          throw new Error(response.data.error || 'Request failed');
        }

        console.log(`[SpiderProxyService] POST ${endpoint} success`);
        return response.data;
      } catch (error) {
        lastError = error as Error;

        if (this.isNetworkError(error)) {
          console.warn(
            `[SpiderProxyService] Network error on attempt ${attempt}, retrying...`,
          );
          if (attempt < this.maxRetries) {
            await this.delay(this.retryDelay);
            continue;
          }
        }

        console.error(
          `[SpiderProxyService] POST ${endpoint} failed:`,
          lastError.message,
        );
        break;
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Unknown error',
    };
  }

  /**
   * 判断是否为网络错误
   */
  private isNetworkError(error: any): boolean {
    if (error instanceof AxiosError) {
      return (
        error.code === 'ECONNREFUSED' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNABORTED'
      );
    }
    return false;
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 设置基础URL
   */
  setBaseUrl(url: string): void {
    this.baseUrl = url;
    this.client.defaults.baseURL = url;
    console.log('[SpiderProxyService] BaseUrl updated to:', url);
  }

  /**
   * 获取基础URL
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }
}

// 单例实例
export const spiderProxyService = new SpiderProxyService();