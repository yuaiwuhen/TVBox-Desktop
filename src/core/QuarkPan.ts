/**
 * QuarkPan - 夸克网盘解析模块（渲染进程）
 *
 * 登录状态委托给 PanLogin 统一管理。凭证保存在 JAR/Docker 的
 * SharedPreferences 中，PC 不再保存任何夸克 cookie。
 * 实际的夸克分享解析由 JAR 端的 spider（csp_Duopan 等）完成，
 * spider 直接从 SharedPreferences 读取登录态。
 */

import { PanLogin } from './PanLogin';

export class QuarkPan {
  /** 同步检查内存中的登录状态缓存（由 PanLogin.refreshStatus 刷新）。 */
  static isLoggedIn(): boolean {
    return PanLogin.isLoggedIn('quark');
  }

  static isQuarkUrl(url: string): boolean {
    return /quark\.cn/i.test(url) || /夸克/i.test(url);
  }
}
