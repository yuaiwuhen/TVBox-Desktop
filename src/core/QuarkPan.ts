/**
 * QuarkPan - 夸克网盘解析模块（渲染进程）
 *
 * 登录状态委托给 PanLogin 统一管理（localStorage key: pan_login_quark）。
 * 视频解析方法保留在此处供 Detail.vue / PanResolver 使用。
 */

import { PanLogin } from './PanLogin';

export interface QuarkLoginInfo {
  cookie: string;
  userId: string;
  nickname: string;
  loginTime: number;
}

const LEGACY_STORAGE_KEY = 'quark_login_info';

export class QuarkPan {
  static isLoggedIn(): boolean {
    return PanLogin.isLoggedIn('quark');
  }

  static getLoginInfo(): QuarkLoginInfo | null {
    const info = PanLogin.getLoginInfo('quark');
    if (!info) return null;
    return {
      cookie: info.cookie,
      userId: info.userId || '',
      nickname: info.nickname || '',
      loginTime: info.loginTime,
    };
  }

  static saveLoginInfo(info: QuarkLoginInfo): void {
    PanLogin.saveLoginInfo({
      panType: 'quark',
      cookie: info.cookie,
      userId: info.userId,
      nickname: info.nickname,
      loginTime: info.loginTime,
    });
    // 清理旧的 storage key，避免数据冗余
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {}
  }

  static logout(): void {
    PanLogin.logout('quark');
  }

  static isQuarkUrl(url: string): boolean {
    return /quark\.cn/i.test(url) || /夸克/i.test(url);
  }

  static async parseShareUrl(url: string): Promise<
    Array<{
      fileName?: string;
      fileType?: string;
      fileId?: string;
    }>
  > {
    console.log('[QuarkPan] Parsing share URL:', url);
    return [];
  }

  static async getPlayUrl(file: {
    fileName?: string;
    fileType?: string;
    fileId?: string;
  }): Promise<{
    url: string;
    quality?: string;
    headers?: Record<string, string>;
  }> {
    console.log('[QuarkPan] Getting play URL for:', file.fileName);
    throw new Error('夸克网盘分享链接解析功能暂未实现');
  }
}
