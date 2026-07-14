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
  | '189'
  | '139'
  | '123'
  | 'guangyapan'
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
   * 从 URL 中检测网盘类型（基于域名）
   *
   * 这是最准确的方式，因为播放 URL 中直接包含网盘域名。
   * 优先级高于名称检测。
   */
  static detectPanTypeFromUrl(url: string): PanType {
    if (!url) return 'unknown';
    const lower = url.toLowerCase();

    // 按域名精确匹配，顺序从最特异的到最通用的
    if (lower.includes('pan.quark.cn') || lower.includes('quark.cn')) return 'quark';
    if (lower.includes('pan.baidu.com') || lower.includes('baidupcs.com') || lower.includes('baidu.com/share')) return 'baidu';
    if (lower.includes('drive.uc.cn') || lower.includes('yun.uc.cn') || lower.includes('uc.cn')) return 'uc';
    if (lower.includes('aliyundrive.com') || lower.includes('alipan.com') || lower.includes('aliyun.com')) return 'aliyun';
    if (lower.includes('bilibili.com') || lower.includes('bilivideo.com')) return 'bili';
    if (lower.includes('115.com')) return '115';
    if (lower.includes('cloud.189.cn')) return '189';
    if (lower.includes('yun.139.com')) return '139';
    if (lower.includes('123pan.com')) return '123';

    return 'unknown';
  }

  /**
   * 从 flag 和 url 中识别网盘类型
   *
   * 注意：检测顺序很重要。'UC' 必须在 'baidu' 之前（避免"百度"误匹配），
   * '123' 必须在 'uc' 之后（避免"123"误匹配其他）。
   * 各类型关键词对应该 spider jar 中的 vod_play_from 命名（如 "天翼原画"）。
   *
   * 优先使用 URL 域名检测，回退到名称检测。
   */
  static detectPanType(flag: string, url: string): PanType {
    // 优先用 URL 域名检测（最准确）
    const typeByUrl = this.detectPanTypeFromUrl(url);
    if (typeByUrl !== 'unknown') return typeByUrl;

    // 回退到名称检测
    const text = `${flag} ${url}`;
    const lower = text.toLowerCase();

    // 光鸦（必须在其他之前，因为"光鸦"是独特关键词）
    if (text.includes('光鸦') || lower.includes('guangya')) {
      return 'guangyapan';
    }
    // 天翼 189
    if (text.includes('天翼') || text.includes('189') || lower.includes('cloud.189')) {
      return '189';
    }
    // 移动 139
    if (text.includes('移动') || text.includes('139') || lower.includes('yun.139')) {
      return '139';
    }
    // 115
    if (text.includes('115')) {
      return '115';
    }
    // 123
    if (text.includes('123') || lower.includes('123pan')) {
      return '123';
    }
    if (
      lower.includes('quark') ||
      text.includes('夸克') ||
      lower.includes('pan.quark')
    ) {
      return 'quark';
    }
    if (
      lower.includes('bili') ||
      text.includes('b站') ||
      lower.includes('bilibili')
    ) {
      return 'bili';
    }
    if (
      lower.includes('uc') ||
      text.includes('uc网盘') ||
      lower.includes('yun.uc')
    ) {
      return 'uc';
    }
    if (
      lower.includes('aliyun') ||
      text.includes('阿里') ||
      lower.includes('alipan') ||
      lower.includes('aliyundrive')
    ) {
      return 'aliyun';
    }
    if (
      lower.includes('baidu') ||
      text.includes('百度') ||
      text.includes('B度') ||
      text.includes('b度') ||
      lower.includes('pan.baidu')
    ) {
      return 'baidu';
    }

    return 'unknown';
  }

  /**
   * 检查网盘是否已登录
   *
   * - 123/139: 无需登录（匿名可播放），始终返回 true
   * - 115/189/guangyapan: 暂不支持登录，返回 false
   * - quark/uc/aliyun/baidu/bili: 查询 PanLogin 登录状态
   */
  static isLoggedIn(panType: PanType): boolean {
    if (panType === '123' || panType === '139') return true;
    if (
      panType === 'unknown' ||
      panType === '115' ||
      panType === '189' ||
      panType === 'guangyapan'
    ) {
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
