/**
 * PanLogin - 网盘扫码登录统一封装（渲染进程）
 *
 * Division of labor between PC and JAR:
 *   - PC: generates the QR code image locally from the scan URL returned
 *     by the JAR (via the `qrcode` npm package in PanLoginService) and
 *     displays it to the user. For Baidu, the JAR returns a server-rendered
 *     QR image URL which the PC displays directly.
 *   - JAR: handles the login process — fetches the QR token from the
 *     netdisk API, polls the login status, extracts credentials, and
 *     persists them to SharedPreferences via SpiderManager.saveLogin.
 *
 * The PC never touches credentials. Login status queries
 * (/spider/loginStatus) and logout (/spider/logout) also go through the
 * JAR. The PC keeps a small in-memory cache of {loggedIn, userId,
 * nickname} for synchronous UI access; this cache contains no credentials
 * and is refreshed from the JAR.
 */

export type PanType =
  | 'quark'
  | 'uc'
  | 'aliyun'
  | 'baidu'
  | 'bili'
  // Extended panTypes — these don't support QR scan on PC, but the user
  // can paste a cookie/token manually via the input login dialog. The
  // JAR's SpiderManager.saveLogin persists them under Wex_<pan>_* keys.
  | 'tianyi'
  | 'pan123'
  | '115'
  | '115safe'
  | 'ydyun'
  | 'guangya'
  | 'leijing';

export interface PanLoginInfo {
  panType: PanType;
  cookie: string;
  refreshToken?: string;
  accessToken?: string;
  userId?: string;
  nickname?: string;
  loginTime: number;
}

/** In-memory login status cache (NO credentials — safe to keep in memory). */
export interface PanLoginStatus {
  loggedIn: boolean;
  userId?: string;
  nickname?: string;
  loginTime?: number;
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

const DISPLAY_NAMES: Record<PanType, string> = {
  quark: '夸克网盘',
  uc: 'UC网盘',
  aliyun: '阿里云盘',
  baidu: '百度网盘',
  bili: 'B站',
  tianyi: '天翼网盘',
  pan123: '123网盘',
  '115': '115网盘',
  '115safe': '115安全码',
  ydyun: '移动网盘',
  guangya: '光鸭网盘',
  leijing: '雷鲸网盘',
};

/** PanTypes that support QR scan login on PC (via JAR PanLoginManager). */
const QR_SUPPORTED_PANS: ReadonlySet<PanType> = new Set([
  'quark',
  'uc',
  'aliyun',
  'baidu',
  'bili',
]);

/** Whether the given panType supports QR scan login (vs. input-only). */
export function isQrSupportedPan(panType: PanType): boolean {
  return QR_SUPPORTED_PANS.has(panType);
}

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

// In-memory login status cache (no credentials).
// Refreshed from JAR on startup, after QR success, and after logout.
const statusCache: Partial<Record<PanType, PanLoginStatus>> = {};

export class PanLogin {
  static getDisplayName(panType: PanType): string {
    return DISPLAY_NAMES[panType] || panType;
  }

  /**
   * Synchronous check against the in-memory cache. The cache is refreshed
   * from the JAR via refreshStatus(). For an authoritative answer, call
   * refreshStatus() first.
   */
  static isLoggedIn(panType: PanType): boolean {
    return !!statusCache[panType]?.loggedIn;
  }

  static getStatus(panType: PanType): PanLoginStatus | null {
    return statusCache[panType] || null;
  }

  /**
   * Refresh the in-memory status cache for a single panType by querying
   * the JAR (/spider/loginStatus). The JAR reads SharedPreferences — the
   * PC never sees the cookie itself.
   */
  static async refreshStatus(panType: PanType): Promise<PanLoginStatus> {
    const ipc = getIPC();
    if (!ipc) {
      return { loggedIn: false };
    }
    try {
      const result = await ipc.invoke('spider:loginStatus', panType);
      const status: PanLoginStatus = {
        loggedIn: !!result?.data?.loggedIn,
        userId: result?.data?.info?.userId,
        nickname: result?.data?.info?.nickname,
        loginTime: result?.data?.info?.loginTime,
      };
      statusCache[panType] = status;
      console.log(`[PanLogin] refreshStatus ${panType}:`, status);
      return status;
    } catch (e: any) {
      console.warn(
        `[PanLogin] refreshStatus failed for ${panType}:`,
        e.message,
      );
      return { loggedIn: false };
    }
  }

  /**
   * Refresh status for all supported panTypes. Called on app startup and
   * after login/logout to keep the UI in sync.
   */
  static async refreshAllStatuses(): Promise<void> {
    const pans: PanType[] = [
      'quark',
      'uc',
      'aliyun',
      'baidu',
      'bili',
      'tianyi',
      'pan123',
      '115',
      '115safe',
      'ydyun',
      'guangya',
      'leijing',
    ];
    await Promise.all(pans.map((p) => this.refreshStatus(p)));
  }

  /**
   * Save a cookie/token entered manually by the user (for panTypes that
   * don't support QR scan). The JAR persists it via /spider/saveLogin,
   * storing under Wex_<pan>_* SharedPreferences keys. The PC never
   * persists the credential locally.
   */
  static async saveLoginInput(
    panType: PanType,
    cookie: string,
    extra?: { userId?: string; nickname?: string },
  ): Promise<void> {
    const ipc = getIPC();
    if (!ipc) {
      throw new Error('IPC not available');
    }
    await ipc.invoke('spider:saveLogin', {
      panType,
      cookie,
      refreshToken: '',
      accessToken: '',
      userId: extra?.userId || '',
      nickname: extra?.nickname || '',
    });
    // Refresh in-memory cache after save
    await this.refreshStatus(panType);
  }

  /**
   * Logout — clears credentials from JAR SharedPreferences via
   * /spider/logout. Also clears the PC-side in-memory caches (e.g.
   * AliyunPanService.accessToken) via pan:logout, and the local status cache.
   * The PC never persisted anything to disk, so this only clears memory.
   */
  static async logout(panType: PanType): Promise<void> {
    const ipc = getIPC();
    if (!ipc) {
      delete statusCache[panType];
      return;
    }
    try {
      await ipc.invoke('spider:logout', panType);
      console.log(`[PanLogin] logout ${panType}: JAR credentials cleared`);
    } catch (e: any) {
      console.warn(
        `[PanLogin] spider:logout failed for ${panType}:`,
        e.message,
      );
    }
    // Clear PC-side in-memory state (e.g. AliyunPanService access tokens).
    try {
      await ipc.invoke('pan:logout', panType);
    } catch (e: any) {
      console.warn(`[PanLogin] pan:logout failed for ${panType}:`, e.message);
    }
    delete statusCache[panType];
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
   *
   * On confirmed, the JAR auto-saves the credentials to SharedPreferences
   * (via SpiderManager.saveLogin inside PanLoginManager.pollQRLogin). The PC
   * never sees the cookie — the small loginInfo echoed back contains only
   * userId/nickname for UI display.
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
      // JAR has already persisted credentials. Update in-memory status cache.
      statusCache[panType] = {
        loggedIn: true,
        userId: result.loginInfo.userId,
        nickname: result.loginInfo.nickname,
        loginTime: Date.now(),
      };
      console.log(`[PanLogin] ${panType} login status cached in memory:`, {
        nickname: result.loginInfo.nickname,
        userId: result.loginInfo.userId,
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
}
