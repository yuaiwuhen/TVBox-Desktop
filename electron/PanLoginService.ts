import { ipcMain } from 'electron';
import QRCode from 'qrcode';
import { spiderAPIClient } from './SpiderAPIClient';
import { QuarkPanService } from './QuarkPanService';
import { UCPanService } from './UCPanService';
import { BaiduPanService } from './BaiduPanService';

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

function log(panType: PanType, ...args: any[]) {
  console.log(`[PanLogin:${panType}]`, ...args);
}

/**
 * PanLoginService — PC side QR login helper.
 *
 * Division of labor with the JAR:
 *   - PC: generates the QR code image locally from `scanUrl` (using the
 *     `qrcode` npm package) and displays it to the user. For Baidu, the
 *     QR image is server-rendered, so the PC just forwards `imageUrl`.
 *   - JAR: handles the login process — fetches the QR token, polls the
 *     login status, extracts credentials, and persists them to
 *     SharedPreferences via SpiderManager.saveLogin.
 *
 * The PC never touches credentials or performs netdisk HTTP requests.
 */
export class PanLoginService {
  static init() {
    ipcMain.handle('pan:generateQRCode', async (_event, panType: PanType) => {
      log(panType, 'generateQRCode (proxy to JAR + local QR render)');
      try {
        return await this.generateQRCode(panType);
      } catch (e: any) {
        log(panType, 'generateQRCode error:', e.message);
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle(
      'pan:pollQRCode',
      async (
        _event,
        panType: PanType,
        qrToken: string,
        extra?: Record<string, string>,
      ) => {
        try {
          return await this.pollQRCode(panType, qrToken, extra);
        } catch (e: any) {
          log(panType, 'pollQRCode error:', e.message);
          return { success: false, status: 'error', error: e.message };
        }
      },
    );

    ipcMain.handle('pan:logout', async (_event, panType: PanType) => {
      log(panType, 'logout');
      try {
        // Clear in-memory caches only. The JAR-side credentials are cleared
        // via spider:logout (handled by the renderer). The PC never persists
        // anything to disk, so clearing the volatile cache is enough.
        switch (panType) {
          case 'quark':
            QuarkPanService.clearLoginState();
            break;
          case 'uc':
            UCPanService.setSyncedCookie(null);
            break;
          case 'aliyun':
            // AliyunPanService no longer stores tokens locally — it fetches
            // them from the JAR on demand. Nothing to clear here.
            break;
          case 'baidu':
            BaiduPanService.setSyncedCookie(null);
            break;
          case 'bili':
            // Bili has no persisted login state in this service
            break;
        }
      } catch (e: any) {
        log(panType, 'logout error:', e.message || e);
      }
      return { success: true };
    });

    console.log(
      '[PanLoginService] Initialized — PC renders QR image locally, JAR handles login polling/saving',
    );
  }

  /**
   * Proxy to JAR /spider/generateQRCode, then render the QR image locally.
   *
   * The JAR returns `scanUrl` (content to encode) for Quark/UC/Aliyun/Bili,
   * or `imageUrl` (URL to a server-rendered QR image) for Baidu. The PC
   * encodes `scanUrl` as a base64 PNG data URL using the `qrcode` package;
   * for Baidu it forwards `imageUrl` directly.
   */
  static async generateQRCode(panType: PanType): Promise<QrCodeResult> {
    const result = await spiderAPIClient.generateQRCode(panType);
    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error || 'JAR generateQRCode failed',
      };
    }
    const { scanUrl, imageUrl, qrToken, extra } = result.data;

    // Baidu: JAR returns a server-rendered QR image URL — use it directly.
    if (imageUrl) {
      return { success: true, qrCodeUrl: imageUrl, qrToken, extra };
    }

    // Quark/UC/Aliyun/Bili: render the QR image locally from scanUrl.
    if (!scanUrl) {
      return {
        success: false,
        error: 'JAR returned neither scanUrl nor imageUrl',
      };
    }
    try {
      const dataUrl = await QRCode.toDataURL(scanUrl, {
        margin: 1,
        width: 300,
        errorCorrectionLevel: 'M',
      });
      return { success: true, qrCodeUrl: dataUrl, qrToken, extra };
    } catch (e: any) {
      log(panType, 'local QR render failed:', e.message);
      return { success: false, error: `QR render failed: ${e.message}` };
    }
  }

  /**
   * Proxy to JAR /spider/pollQRLogin. On confirmed, the JAR auto-saves the
   * credentials to SharedPreferences — the PC never sees them.
   *
   * We mirror a minimal loginInfo (panType + userId/nickname from the JAR
   * response) so the renderer can show a "login successful" toast.
   */
  static async pollQRCode(
    panType: PanType,
    qrToken: string,
    extra?: Record<string, string>,
  ): Promise<PollResult> {
    const result = await spiderAPIClient.pollQRLogin(panType, qrToken, extra);
    if (!result.success) {
      return {
        success: false,
        status: 'error',
        error: result.error || 'JAR pollQRLogin failed',
      };
    }
    const data = result.data;
    if (!data) {
      return { success: true, status: 'waiting' };
    }

    let loginInfo: PanLoginInfo | undefined;
    if (data.status === 'confirmed' && data.loginInfo) {
      const info = data.loginInfo;
      loginInfo = {
        panType,
        cookie: info.cookie || '',
        refreshToken: info.refreshToken,
        accessToken: info.accessToken,
        userId: info.userId,
        nickname: info.nickname,
        loginTime: Date.now(),
      };
      // Cache the cookie in-memory for the ProxyServer fallback (Quark/UC/Baidu).
      // The JAR has already persisted it to SharedPreferences via saveLogin.
      try {
        if (loginInfo.cookie) {
          switch (panType) {
            case 'quark':
              QuarkPanService.setSyncedCookie(loginInfo.cookie);
              break;
            case 'uc':
              UCPanService.setSyncedCookie(loginInfo.cookie);
              break;
            case 'baidu':
              BaiduPanService.setSyncedCookie(loginInfo.cookie);
              break;
          }
        }
      } catch (e: any) {
        log(panType, 'in-memory cache set failed:', e.message);
      }
    }

    return {
      success: true,
      status: data.status,
      loginInfo,
    };
  }
}
