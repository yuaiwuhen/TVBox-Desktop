/**
 * PanLogin - 网盘扫码登录统一封装（渲染进程）
 *
 * 通过 IPC 调用主进程的 PanLoginService，管理 localStorage 中的 token/cookie。
 * 支持夸克、UC、阿里云盘、百度网盘、B站 的扫码登录。
 */

export type PanType = 'quark' | 'uc' | 'aliyun' | 'baidu' | 'bili';

export interface PanLoginInfo {
  panType: PanType;
  cookie: string;
  refreshToken?: string;
  accessToken?: string;
  userId?: string;
  nickname?: string;
  loginTime: number;
}

export interface QrCodeResult {
  success: boolean;
  qrCodeUrl?: string;
  qrToken?: string;
  extra?: Record<string, string>;
  error?: string;
  rawData?: string;
}

export interface PollResult {
  success: boolean;
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';
  loginInfo?: PanLoginInfo;
  error?: string;
  rawData?: string;
}

const STORAGE_KEYS: Record<PanType, string> = {
  quark: 'pan_login_quark',
  uc: 'pan_login_uc',
  aliyun: 'pan_login_aliyun',
  baidu: 'pan_login_baidu',
  bili: 'pan_login_bili',
};

const DISPLAY_NAMES: Record<PanType, string> = {
  quark: '夸克网盘',
  uc: 'UC网盘',
  aliyun: '阿里云盘',
  baidu: '百度网盘',
  bili: 'B站',
};

function getIPC(): any {
  if ((window as any).electronIPC) {
    return (window as any).electronIPC;
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
    console.warn('[PanLogin] Electron IPC not available');
    return null;
  }
}

export class PanLogin {
  static getDisplayName(panType: PanType): string {
    return DISPLAY_NAMES[panType] || panType;
  }

  static isLoggedIn(panType: PanType): boolean {
    const info = this.getLoginInfo(panType);
    return !!(info?.cookie || info?.refreshToken || info?.accessToken);
  }

  /**
   * Check if the saved login token is actually still valid by calling
   * the main process API.
   */
  static async checkTokenValid(panType: PanType): Promise<boolean> {
    const info = this.getLoginInfo(panType);
    if (!info) {
      return false;
    }
    // Only Quark has token validation implemented for now
    if (panType !== 'quark') {
      return true;
    }
    const ipc = getIPC();
    if (!ipc) {
      return true; // assume valid if IPC is not available
    }
    try {
      const result = await ipc.invoke('quark:checkTokenValid');
      return result.valid;
    } catch (e) {
      console.warn(`[PanLogin] checkTokenValid failed for ${panType}:`, e);
      return true; // assume valid on network error
    }
  }

  static getLoginInfo(panType: PanType): PanLoginInfo | null {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS[panType]);
      if (!saved) return null;
      return JSON.parse(saved) as PanLoginInfo;
    } catch (e) {
      console.warn(`[PanLogin] Failed to load ${panType} login info:`, e);
      return null;
    }
  }

  static saveLoginInfo(info: PanLoginInfo): void {
    localStorage.setItem(STORAGE_KEYS[info.panType], JSON.stringify(info));
    console.log(`[PanLogin] Saved login info for ${info.panType}:`, {
      panType: info.panType,
      nickname: info.nickname,
      userId: info.userId,
      cookieLength: info.cookie?.length || 0,
      refreshToken: info.refreshToken ? '***' : undefined,
      accessToken: info.accessToken ? '***' : undefined,
      loginTime: info.loginTime,
    });
  }

  static logout(panType: PanType): void {
    const key = STORAGE_KEYS[panType];
    const beforeRemove = localStorage.getItem(key);
    console.log(`[PanLogin] logout ${panType}, key=${key}, hadData=${!!beforeRemove}`);
    localStorage.removeItem(key);
    const afterRemove = localStorage.getItem(key);
    console.log(`[PanLogin] logout ${panType}, after remove: ${!!afterRemove}`);
    const ipc = getIPC();
    if (ipc) {
      ipc.invoke('pan:logout', panType).catch((e) => {
        console.warn(`[PanLogin] logout IPC failed for ${panType}:`, e);
      });
    }
    console.log(`[PanLogin] Logged out ${panType}`);
  }

  static async generateQRCode(panType: PanType): Promise<{
    qrCodeUrl: string;
    qrToken: string;
    extra?: Record<string, string>;
  }> {
    console.log(`[PanLogin] Generating QR code for ${panType}...`);
    const ipc = getIPC();
    if (!ipc) {
      throw new Error('IPC not available');
    }

    try {
      const result: QrCodeResult = await ipc.invoke(
        'pan:generateQRCode',
        panType,
      );
      console.log(`[PanLogin] generateQRCode result for ${panType}:`, {
        success: result.success,
        hasUrl: !!result.qrCodeUrl,
        hasToken: !!result.qrToken,
        error: result.error,
      });

      if (result.success && result.qrCodeUrl && result.qrToken) {
        return {
          qrCodeUrl: result.qrCodeUrl,
          qrToken: result.qrToken,
          extra: result.extra,
        };
      }
      throw new Error(result.error || 'Failed to generate QR code');
    } catch (e: any) {
      console.error(
        `[PanLogin] generateQRCode for ${panType} failed:`,
        e.message,
      );
      throw e;
    }
  }

  /**
   * 轮询二维码扫码状态
   * status: waiting=等待扫码, scanned=已扫码待确认, confirmed=已确认登录成功, expired=已过期
   */
  static async pollQRCode(
    panType: PanType,
    qrToken: string,
    extra?: Record<string, string>,
  ): Promise<PollResult> {
    const ipc = getIPC();
    if (!ipc) {
      throw new Error('IPC not available');
    }

    console.log(`[PanLogin] pollQRCode IPC invoke:`, {
      channel: 'pan:pollQRCode',
      panType,
      qrToken: qrToken.slice(0, 20) + '...',
      qrTokenLen: qrToken.length,
      extra,
    });

    // Vue Proxy 对象不能被 Electron IPC 序列化，先转为普通对象
    const plainExtra = extra ? JSON.parse(JSON.stringify(extra)) : undefined;
    const result: PollResult = await ipc.invoke(
      'pan:pollQRCode',
      panType,
      qrToken,
      plainExtra,
    );

    if (result.success && result.status === 'confirmed' && result.loginInfo) {
      this.saveLoginInfo(result.loginInfo);
      console.log(`[PanLogin] ${panType} login status saved to localStorage:`, {
        nickname: result.loginInfo.nickname,
        userId: result.loginInfo.userId,
        cookieLength: result.loginInfo.cookie?.length || 0,
      });
    } else if (result.status === 'confirmed') {
      console.error(
        `[PanLogin] ${panType} confirmed but no loginInfo from main process`,
        result,
      );
    }

    return result;
  }

  /**
   * 从 action 名识别网盘类型
   * addQuark/delQuark → quark
   * addUc/delUc → uc
   * addUctv/delUctv → uctv
   * addAli/delAli/addAliyun/delAliyun → aliyun
   * addBaidu/delBaidu → baidu
   * addBili/delBili → bili
   */
  static detectPanTypeFromAction(action: string): PanType | null {
    const lower = action.toLowerCase();
    if (lower.includes('quark')) return 'quark';
    if (lower.includes('bili')) return 'bili';
    if (lower.includes('uc')) return 'uc';
    if (lower.includes('ali')) return 'aliyun';
    if (lower.includes('baidu')) return 'baidu';
    return null;
  }

  static isAddAction(action: string): boolean {
    return action.toLowerCase().startsWith('add');
  }

  static isDelAction(action: string): boolean {
    return action.toLowerCase().startsWith('del');
  }

  /**
   * Sync all saved pan login info from localStorage to the main process.
   *
   * Different pans need different auth:
   *   - Quark/UC/Baidu: cookie string (Cookie header value)
   *   - Aliyun: refreshToken + accessToken (Bearer auth)
   *
   * On app restart, the main process is fresh and has no cached auth — the
   * user would have to log in again to play any pan video. This method is
   * called on app startup to re-sync all saved login info, so previously
   * logged-in pans continue to work after restart.
   */
  static async syncAllToJVM(): Promise<{
    success: boolean;
    synced: PanType[];
    error?: string;
  }> {
    const ipc = getIPC();
    if (!ipc) {
      console.warn('[PanLogin] syncAllToJVM: IPC not available');
      return { success: false, synced: [], error: 'IPC not available' };
    }

    // Send full loginInfo objects keyed by panType. The main process extracts
    // the fields each pan service needs.
    const loginInfoData: Record<string, PanLoginInfo> = {};
    const synced: PanType[] = [];
    for (const panType of Object.keys(STORAGE_KEYS) as PanType[]) {
      const info = this.getLoginInfo(panType);
      if (info && (info.cookie || info.refreshToken || info.accessToken)) {
        loginInfoData[panType] = info;
        synced.push(panType);
      }
    }

    if (synced.length === 0) {
      console.log('[PanLogin] syncAllToJVM: no saved login info to sync');
      return { success: true, synced: [] };
    }

    console.log('[PanLogin] syncAllToJVM: syncing pans:', synced);
    try {
      const result = await ipc.invoke('pan:syncAllCookies', loginInfoData);
      console.log('[PanLogin] syncAllToJVM result:', result);
      return {
        success: result?.success !== false,
        synced,
        error: result?.error,
      };
    } catch (e: any) {
      console.error('[PanLogin] syncAllToJVM failed:', e.message);
      return { success: false, synced, error: e.message };
    }
  }
}
