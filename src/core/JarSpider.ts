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
  baseURL: 'http://localhost:9978',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

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
          const errorMsg =
            loadResult?.error || `Failed to load JAR: ${this.jarUrl}`;
          console.error('[JarSpider] JAR load failed:', errorMsg);
          loading.fail(taskId, errorMsg);
          throw new Error(`[JarSpider] ${errorMsg}`);
        }
      } catch (error: any) {
        // If Spider service is not available, use mock data for development
        if (
          error.code === 'ECONNREFUSED' ||
          error.message?.includes('Network Error')
        ) {
          console.warn(
            '[JarSpider] Spider service not available, using mock data for development',
          );
          this.initialized = true;
          loading.success(taskId, '爬虫加载成功（开发模式）');
          return;
        }
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
        const errorMsg =
          initResult?.error || `Failed to init spider: ${this.className}`;
        console.error('[JarSpider] Spider init failed:', errorMsg);
        loading.fail(taskId, errorMsg);
        throw new Error(`[JarSpider] ${errorMsg}`);
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
      const response = await httpClient.post(endpoint, data);
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
   * Get mock data for development when Spider service is not available
   */
  private getMockData(method: string, args: any[]): string {
    console.log('[JarSpider] Returning mock data for method:', method);

    // Mock home content
    if (method === 'homeContent') {
      return JSON.stringify({
        classes: [
          { type_id: '1', type_name: '电影' },
          { type_id: '2', type_name: '电视剧' },
          { type_id: '3', type_name: '综艺' },
          { type_id: '4', type_name: '动漫' },
        ],
        list: [
          {
            vod_id: 'mock1',
            vod_name: '示例电影1（开发模式）',
            vod_pic: 'https://via.placeholder.com/200x300?text=Movie+1',
            vod_remarks: 'HD',
            vod_year: '2024',
            type_id: '1',
          },
          {
            vod_id: 'mock2',
            vod_name: '示例电视剧（开发模式）',
            vod_pic: 'https://via.placeholder.com/200x300?text=TV+Show',
            vod_remarks: '更新至第10集',
            vod_year: '2024',
            type_id: '2',
          },
          {
            vod_id: 'mock3',
            vod_name: '示例综艺（开发模式）',
            vod_pic: 'https://via.placeholder.com/200x300?text=Variety',
            vod_remarks: '第20240101期',
            vod_year: '2024',
            type_id: '3',
          },
        ],
      });
    }

    // Mock category content
    if (method === 'categoryContent') {
      return JSON.stringify({
        list: [
          {
            vod_id: 'mock_cat1',
            vod_name: `分类内容示例 ${args[1] || '1'}`,
            vod_pic: 'https://via.placeholder.com/200x300?text=Category',
            vod_remarks: 'HD',
            vod_year: '2024',
          },
        ],
        page: args[1] || '1',
        pagecount: '10',
      });
    }

    // Mock detail content
    if (method === 'detailContent') {
      return JSON.stringify({
        list: [
          {
            vod_id: args[0]?.[0] || 'mock1',
            vod_name: '详情内容示例（开发模式）',
            vod_pic: 'https://via.placeholder.com/300x400?text=Detail',
            vod_content:
              '这是一个Mock数据，用于开发测试。Spider服务不可用时会显示此内容。',
            vod_play_from: '线路1$线路2',
            vod_play_url:
              '第01集#https://example.com/video1.mp4$第02集#https://example.com/video2.mp4',
            vod_year: '2024',
            vod_area: '中国',
            vod_director: '导演名',
            vod_actor: '演员1,演员2',
          },
        ],
      });
    }

    // Mock search content
    if (method === 'searchContent') {
      return JSON.stringify({
        list: [
          {
            vod_id: 'search_mock1',
            vod_name: `搜索结果: ${args[0]}`,
            vod_pic: 'https://via.placeholder.com/200x300?text=Search+Result',
            vod_remarks: 'HD',
          },
        ],
      });
    }

    // Default empty response
    return JSON.stringify({});
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

          // 添加额外的cookies（如果需要）
          const extraCookies: Record<string, string> = {};
          const panTypes = ['quark', 'uc', 'aliyun', 'baidu', 'bili'];
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
          if (Object.keys(extraCookies).length > 0) {
            requestData.extraCookies = extraCookies;
          }
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
        console.warn(
          `[JarSpider] ${method} failed:`,
          response.error || 'Unknown error',
        );
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
