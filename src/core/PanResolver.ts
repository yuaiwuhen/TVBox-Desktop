import { QuarkPan } from './QuarkPan';
import { PanLogin } from './PanLogin';

/**
 * PanResolver - 网盘解析管理器
 *
 * 功能：
 * 1. 识别网盘类型（夸克、UC、阿里、百度等）
 * 2. 检查登录状态
 * 3. 触发登录流程
 * 4. 解析播放地址
 */

export type PanType =
  | 'quark'
  | 'uc'
  | 'aliyun'
  | 'baidu'
  | 'bili'
  | '115'
  | 'unknown';

export interface PanVideoInfo {
  panType: PanType;
  shareUrl?: string;
  fileId?: string;
  fileName?: string;
  rawUrl: string;
  rawFlag: string;
}

export interface PanPlayResult {
  url: string;
  quality?: string;
  headers?: Record<string, string>;
}

export class PanResolver {
  /**
   * 从 flag 和 url 中识别网盘类型
   */
  static detectPanType(flag: string, url: string): PanType {
    const text = `${flag} ${url}`.toLowerCase();

    if (
      text.includes('quark') ||
      text.includes('夸克') ||
      text.includes('pan.quark')
    ) {
      return 'quark';
    }
    if (
      text.includes('bili') ||
      text.includes('b站') ||
      text.includes('bilibili')
    ) {
      return 'bili';
    }
    if (
      text.includes('uc') ||
      text.includes('uc网盘') ||
      text.includes('yun.uc')
    ) {
      return 'uc';
    }
    if (
      text.includes('aliyun') ||
      text.includes('阿里') ||
      text.includes('alipan') ||
      text.includes('aliyundrive')
    ) {
      return 'aliyun';
    }
    if (text.includes('115')) {
      return '115';
    }
    if (
      text.includes('baidu') ||
      text.includes('百度') ||
      text.includes('pan.baidu')
    ) {
      return 'baidu';
    }

    return 'unknown';
  }

  /**
   * 检查网盘是否已登录
   */
  static isLoggedIn(panType: PanType): boolean {
    // 'unknown' 和 '115' 不支持登录检查
    if (panType === 'unknown' || panType === '115') {
      return false;
    }
    return PanLogin.isLoggedIn(panType as import('./PanLogin').PanType);
  }

  /**
   * 解析网盘视频，返回播放地址
   * 如果未登录，抛出错误提示需要登录
   */
  static async resolveVideo(info: PanVideoInfo): Promise<PanPlayResult> {
    console.log('[PanResolver] Resolving video:', info.panType, info.rawFlag);

    switch (info.panType) {
      case 'quark':
        return this.resolveQuark(info);
      case 'uc':
        throw new Error('UC网盘解析暂未实现');
      case 'aliyun':
        throw new Error('阿里云盘解析暂未实现');
      case 'baidu':
        throw new Error('百度网盘解析暂未实现');
      default:
        throw new Error('未知网盘类型');
    }
  }

  private static async resolveQuark(
    info: PanVideoInfo,
  ): Promise<PanPlayResult> {
    if (!QuarkPan.isLoggedIn()) {
      throw new Error('夸克网盘未登录，请先扫码登录');
    }

    if (info.shareUrl) {
      const files = await QuarkPan.parseShareUrl(info.shareUrl);
      if (files.length === 0) {
        throw new Error('分享链接中没有找到文件');
      }

      const videoFile =
        files.find(
          (f: { fileName?: string; fileType?: string }) =>
            f.fileName?.match(/\.(mp4|mkv|avi|mov|flv|wmv|m4v|ts)$/i) ||
            f.fileType === 'video',
        ) || files[0];

      return await QuarkPan.getPlayUrl(videoFile);
    }

    throw new Error('无法解析夸克网盘链接：缺少分享链接');
  }

  /**
   * 判断 playerContent 返回的结果是否是网盘链接
   */
  static isPanUrl(result: string): boolean {
    return /pan\.quark|quark\.cn|yun\.uc|alipan|aliyundrive|pan\.baidu/i.test(
      result,
    );
  }

  /**
   * 从 playerContent 结果中提取分享链接
   */
  static extractShareUrl(result: string): string | null {
    const patterns = [
      /https?:\/\/pan\.quark\.cn\/s\/[a-zA-Z0-9]+/g,
      /https?::\/\/[^\s]*?quark\.cn[^\s]*/g,
    ];

    for (const pattern of patterns) {
      const match = result.match(pattern);
      if (match && match.length > 0) {
        return match[0];
      }
    }

    return null;
  }
}
