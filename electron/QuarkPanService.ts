import axios from 'axios';
import { ipcMain } from 'electron';
import { jarLoader } from './JarLoader';

export interface QuarkLoginInfo {
  cookie: string;
  userId: string;
  nickname: string;
  loginTime: number;
}

export class QuarkPanService {
  private static loginInfo: QuarkLoginInfo | null = null;
  // Last cookie synced to JVM SharedPreferences. Kept in memory so the
  // ProxyServer can inject it into spider params, bypassing the spider's
  // SharedPreferences read path (which fails to send __puus to the CDN).
  private static syncedCookie: string | null = null;

  static init() {
    ipcMain.handle('quark:generateQRCode', async () => {
      return this.generateQRCode();
    });

    ipcMain.handle('quark:pollQRCode', async (_event, qrToken: string) => {
      return this.pollQRCode(qrToken);
    });

    ipcMain.handle('quark:isLoggedIn', async () => {
      return { isLoggedIn: !!this.loginInfo?.cookie };
    });

    ipcMain.handle('quark:getLoginInfo', async () => {
      return this.loginInfo;
    });

    ipcMain.handle('quark:logout', async () => {
      this.loginInfo = null;
      this.syncedCookie = null;
      return { success: true };
    });

    console.log('[QuarkPanService] Initialized');
  }

  /**
   * Get the last cookie synced to JVM SharedPreferences.
   * Used by ProxyServer to inject into spider params, bypassing
   * the spider's SharedPreferences read path.
   */
  static getSyncedCookie(): string | null {
    return this.syncedCookie;
  }

  static async generateQRCode(): Promise<{
    success: boolean;
    qrCodeUrl?: string;
    qrToken?: string;
    error?: string;
    rawData?: string;
  }> {
    console.log('[QuarkPanService] Generating QR code...');
    try {
      const response = await axios.get(
        'https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin',
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Quark/6.5.1.1453 Chrome/122.0.6261.112 Electron/28.2.1 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            Origin: 'https://pan.quark.cn',
            Referer: 'https://pan.quark.cn/',
          },
          timeout: 15000,
        },
      );

      console.log('[QuarkPanService] Response status:', response.status);
      console.log(
        '[QuarkPanService] Response data:',
        JSON.stringify(response.data).substring(0, 500),
      );

      const data = response.data;
      const token = data?.data?.members?.token;
      if (token) {
        const qrCodeUrl = `https://uop.quark.cn/cas/qrcodeLogin?token=${token}`;
        console.log(
          '[QuarkPanService] QR code generated successfully, token:',
          token,
        );
        return {
          success: true,
          qrCodeUrl,
          qrToken: token,
        };
      }

      console.log(
        '[QuarkPanService] QR code generation failed, no token in response',
      );
      return {
        success: false,
        error: 'No token in response',
        rawData: JSON.stringify(data),
      };
    } catch (e: any) {
      console.error('[QuarkPanService] Generate QR code failed:', e.message);
      console.error(
        '[QuarkPanService] Error details:',
        e.response?.status,
        e.response?.data,
      );
      return {
        success: false,
        error: `${e.message} (status: ${e.response?.status || 'unknown'})`,
      };
    }
  }

  static async pollQRCode(qrToken: string): Promise<{
    success: boolean;
    status?: number;
    cookie?: string;
    userId?: string;
    nickname?: string;
    error?: string;
  }> {
    try {
      const response = await axios.get(
        `https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?token=${qrToken}`,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Quark/6.5.1.1453 Chrome/122.0.6261.112 Electron/28.2.1 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
            Origin: 'https://pan.quark.cn',
            Referer: 'https://pan.quark.cn/',
          },
          timeout: 15000,
        },
      );

      const data = response.data;
      console.log(
        '[QuarkPanService] Poll response:',
        JSON.stringify(data).substring(0, 300),
      );

      const status = data?.status || 0;
      console.log('[QuarkPanService] QR poll status:', status);

      if (status === 2 && data?.serviceTicket) {
        const serviceTicket = data.serviceTicket;
        console.log('[QuarkPanService] Got service ticket:', serviceTicket);

        const accountResponse = await axios.get(
          `https://drive.quark.cn/account/info?serviceTicket=${serviceTicket}`,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Quark/6.5.1.1453 Chrome/122.0.6261.112 Electron/28.2.1 Safari/537.36',
              Origin: 'https://pan.quark.cn',
              Referer: 'https://pan.quark.cn/',
            },
            timeout: 15000,
          },
        );

        const accountData = accountResponse.data;
        console.log(
          '[QuarkPanService] Account info:',
          JSON.stringify(accountData).substring(0, 300),
        );

        const baseCookie =
          accountResponse.headers['set-cookie']?.join('; ') || '';
        const userId = accountData?.data?.userId || '';
        const nickname = accountData?.data?.nickname || '';

        // Fetch __puus cookie (required for CDN download access).
        // The base cookie from account/info lacks __puus; calling
        // /1/clouddrive/file/sort triggers the server to set __puus.
        const cookie = await this.fetchPuusCookie(baseCookie);

        this.loginInfo = {
          cookie,
          userId,
          nickname,
          loginTime: Date.now(),
        };

        console.log('[QuarkPanService] Login success:', nickname);

        this.syncCookieToJVM(cookie);

        return {
          success: true,
          status: 2,
          cookie,
          userId,
          nickname,
        };
      }

      return { success: true, status };
    } catch (e: any) {
      console.error('[QuarkPanService] Poll QR code failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * Fetch __puus cookie by calling Quark clouddrive endpoint.
   * The base cookie from account/info lacks __puus, which is required
   * for CDN download access. Calling /1/clouddrive/file/sort triggers
   * the server to set __puus in the response set-cookie headers.
   * Mirrors the UC flow in PanLoginService.ts.
   */
  public static async fetchPuusCookie(baseCookie: string): Promise<string> {
    if (!baseCookie) return '';
    try {
      const response = await axios.get(
        'https://drive-pc.quark.cn/1/clouddrive/file/sort',
        {
          params: {
            pr: 'ucpro',
            fr: 'pc',
            pdir_fid: 0,
            _page: 1,
            _size: 50,
            _fetch_total: 1,
            _fetch_sub_dirs: 0,
            _sort: 'file_type:asc,updated_at:desc',
          },
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.0.1 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch',
            Referer: 'https://pan.quark.cn/',
            Cookie: baseCookie,
            Accept: 'application/json, text/plain, */*',
          },
          timeout: 15000,
        },
      );

      const setCookie = response.headers?.['set-cookie'];
      if (!setCookie) {
        console.warn(
          '[QuarkPanService] No set-cookie from clouddrive/file/sort, using base cookie only',
        );
        return baseCookie;
      }

      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      const puusEntry = cookies.find((c: string) => c.startsWith('__puus='));
      if (!puusEntry) {
        console.warn(
          '[QuarkPanService] __puus not in set-cookie, using base cookie only',
        );
        return baseCookie;
      }
      const puus = puusEntry.split(';')[0];
      console.log('[QuarkPanService] Fetched __puus cookie');
      return `${baseCookie}; ${puus}`;
    } catch (e: any) {
      console.warn(
        '[QuarkPanService] Failed to fetch __puus, using base cookie:',
        e.message,
      );
      return baseCookie;
    }
  }

  // 改为 public static，允许 PanLoginService 调用
  public static async syncCookieToJVM(cookie: string): Promise<void> {
    console.log(
      '[QuarkPanService] syncCookieToJVM called, cookie length:',
      cookie?.length || 0,
    );
    console.log(
      '[QuarkPanService] syncCookieToJVM cookie preview:',
      cookie?.substring(0, 100) || 'empty',
    );
    console.log(
      '[QuarkPanService] syncCookieToJVM has __puus:',
      cookie?.includes('__puus') || false,
    );
    console.log(
      '[QuarkPanService] syncCookieToJVM has __pus:',
      cookie?.includes('__pus') || false,
    );
    // Cache for ProxyServer to inject into spider params
    this.syncedCookie = cookie || null;
    try {
      if (!jarLoader || !jarLoader.java) {
        console.warn('[QuarkPanService] JVM not ready, skipping cookie sync');
        return;
      }

      // Spider 期望的 SharedPreferences 名字 = <packageName>_preferences
      // packageName 来自 Context.getPackageName() = "com.github.catvod.tvbox"
      const PREFS_NAME = 'com.github.catvod.tvbox_preferences';
      const XOR_KEY = 'miwudi';

      // 加密 cookie：每个字符 XOR "miwudi"（循环）→ UTF-8 bytes → Base64
      // 对应 e_1.g() 方法的加密逻辑（key: "miwudi" 来自 e_1 类的静态字段 a）
      const encryptedCookie = this.encryptQuarkCookie(cookie, XOR_KEY);
      console.log(
        '[QuarkPanService] Encrypted cookie length:',
        encryptedCookie.length,
      );

      // 通过 Init.context() 获取 Application Context
      const InitClass = jarLoader.java.importClass(
        'com.github.catvod.spider.Init',
      );
      const ctx = InitClass.contextSync();
      if (!ctx) {
        console.warn('[QuarkPanService] Init.context() returned null');
        return;
      }

      // 获取 SharedPreferences（不存在则创建）
      const prefs = ctx.getSharedPreferencesSync(PREFS_NAME, 0);
      if (!prefs) {
        console.warn(
          `[QuarkPanService] Failed to get SharedPreferences: ${PREFS_NAME}`,
        );
        return;
      }

      // 写入：
      // - mi.quark = 加密后的 cookie（spider 优先读取，e_1.b() 会解密）
      // - .quark   = 明文 cookie（fallback，e_1.b() 在解密失败时使用）
      const editor = prefs.editSync();
      editor.putStringSync('mi.quark', encryptedCookie);
      editor.putStringSync('.quark', cookie);
      editor.applySync();

      console.log(
        `[QuarkPanService] Synced cookie to ${PREFS_NAME} (mi.quark encrypted + .quark plain)`,
      );
    } catch (e: any) {
      console.warn(
        '[QuarkPanService] Failed to sync cookie to JVM:',
        e.message,
      );
    }
  }

  // 夸克 cookie 加密：XOR "miwudi" + Base64
  // 对应 JAR 中 e_1 类的加密逻辑
  private static encryptQuarkCookie(cookie: string, xorKey: string): string {
    const keyChars = xorKey.split('');
    const out: string[] = [];
    for (let i = 0; i < cookie.length; i++) {
      const c = cookie.charCodeAt(i);
      const k = keyChars[i % keyChars.length].charCodeAt(0);
      out.push(String.fromCharCode(c ^ k));
    }
    const xoredStr = out.join('');
    const buf = Buffer.from(xoredStr, 'utf8');
    return buf.toString('base64');
  }
}
