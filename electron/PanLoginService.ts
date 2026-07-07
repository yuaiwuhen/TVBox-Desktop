import axios from 'axios';
import { ipcMain } from 'electron';
import QRCode from 'qrcode';
import { QuarkPanService } from './QuarkPanService';
import { UCPanService } from './UCPanService';
import { AliyunPanService } from './AliyunPanService';
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

// JAR L415: token generation UA
const UA_QUARK =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.0.1 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch';
// JAR L242: polling UA
const UA_QUARK_POLL =
  'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/38.0.2125.122 Safari/537.36 SE 2.X MetaSr 1.0';
// JAR L432: UC token/poll UA
const UA_UC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
// JAR L460: Bili UA
const UA_BILI =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
const UA_ALI =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
const UA_BAIDU =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';

function safeStringify(obj: any): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

function log(panType: PanType, ...args: any[]) {
  console.log(`[PanLogin:${panType}]`, ...args);
}

async function generateQrDataUrl(content: string): Promise<string> {
  return await QRCode.toDataURL(content, {
    width: 300,
    margin: 1,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

export class PanLoginService {
  static init() {
    ipcMain.handle('pan:generateQRCode', async (_event, panType: PanType) => {
      log(panType, 'generateQRCode invoked');
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
        switch (panType) {
          case 'quark':
            QuarkPanService.clearLoginState();
            break;
          case 'uc':
            UCPanService.setSyncedCookie(null);
            break;
          case 'aliyun':
            AliyunPanService.setLoginInfo({
              refreshToken: '',
              accessToken: '',
            });
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

    // 新增：同步 localStorage 中保存的所有网盘 cookie 到 JVM
    // 接受完整 loginInfo 对象（不只是 cookie 字符串），因为阿里云盘需要 refreshToken/accessToken
    ipcMain.handle(
      'pan:syncAllCookies',
      async (_event, loginInfoData: Record<string, any>) => {
        console.log(
          '[PanLoginService] syncAllCookies called with pans:',
          Object.keys(loginInfoData),
        );
        try {
          for (const [panType, info] of Object.entries(loginInfoData)) {
            const cookie: string = info?.cookie || '';
            if (panType === 'quark' && cookie) {
              console.log(
                '[PanLoginService] Syncing quark cookie to JVM, length:',
                cookie.length,
              );
              await QuarkPanService.syncCookieToJVM(cookie);
            } else if (panType === 'uc' && cookie) {
              console.log(
                '[PanLoginService] Syncing uc cookie, length:',
                cookie.length,
              );
              UCPanService.setSyncedCookie(cookie);
            } else if (panType === 'aliyun') {
              const refreshToken: string = info?.refreshToken || '';
              const accessToken: string = info?.accessToken || '';
              if (refreshToken || accessToken) {
                console.log(
                  '[PanLoginService] Syncing aliyun tokens: refreshToken len=',
                  refreshToken.length,
                  'accessToken len=',
                  accessToken.length,
                );
                AliyunPanService.setLoginInfo({ refreshToken, accessToken });
              }
            } else if (panType === 'baidu' && cookie) {
              console.log(
                '[PanLoginService] Syncing baidu cookie, length:',
                cookie.length,
              );
              BaiduPanService.setSyncedCookie(cookie);
            }
          }
          return { success: true };
        } catch (e: any) {
          console.error('[PanLoginService] syncAllCookies error:', e.message);
          return { success: false, error: e.message };
        }
      },
    );

    console.log(
      '[PanLoginService] Initialized with 5 pan types: quark, uc, aliyun, baidu, bili',
    );
  }

  static async generateQRCode(panType: PanType): Promise<QrCodeResult> {
    switch (panType) {
      case 'quark':
        return this.generateQuarkQrCode();
      case 'uc':
        return this.generateUCQrCode();
      case 'aliyun':
        return this.generateAliyunQrCode();
      case 'baidu':
        return this.generateBaiduQrCode();
      case 'bili':
        return this.generateBiliQrCode();
      default:
        return { success: false, error: `Unsupported pan type: ${panType}` };
    }
  }

  static async pollQRCode(
    panType: PanType,
    qrToken: string,
    extra?: Record<string, string>,
  ): Promise<PollResult> {
    switch (panType) {
      case 'quark':
        return this.pollQuarkQrCode(qrToken);
      case 'uc':
        return this.pollUCQrCode(qrToken);
      case 'aliyun':
        return this.pollAliyunQrCode(qrToken, extra?.ck || '');
      case 'baidu':
        return this.pollBaiduQrCode(qrToken);
      case 'bili':
        return this.pollBiliQrCode(qrToken);
      default:
        return {
          success: false,
          status: 'error',
          error: `Unsupported pan type: ${panType}`,
        };
    }
  }

  /**
   * Quark 扫码登录（从 JAR X.java 反编译提取）
   * Token API:  GET https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2
   *             UA: quark-cloud-drive/3.0.1
   * Scan URL:   https://su.quark.cn/4_eMHBJ?token=<token>&client_id=532&ssb=weblogin&uc_param_str=&uc_biz_str=...
   * Poll API:   GET https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=532&v=1.2&token=<token>
   *             UA: Chrome/38.0.2125.122...SE 2.X MetaSr 1.0
   *             Accept: application/json, text/plain, *\/*
   *             Referer: https://pan.quark.cn/
   * Status:     message === "ok" → confirmed
   * Cookie API: GET https://pan.quark.cn/account/info?st=<service_ticket>&lw=scan
   * Cookie:     从 set-cookie 中提取 __pus
   */
  private static async generateQuarkQrCode(): Promise<QrCodeResult> {
    log('quark', 'Requesting token from uop.quark.cn');
    try {
      const tokenUrl =
        'https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2';
      log('quark', 'Token gen URL:', tokenUrl);
      const response = await axios.get(tokenUrl, {
        timeout: 15000,
        headers: { 'User-Agent': UA_QUARK },
      });
      log('quark', 'Token gen status:', response.status);
      log('quark', 'Token response:', safeStringify(response.data));

      const token = response.data?.data?.members?.token;
      if (!token || typeof token !== 'string') {
        return {
          success: false,
          error: `No valid token in response (got: ${typeof token} ${JSON.stringify(token)})`,
          rawData: safeStringify(response.data),
        };
      }

      const scanUrl = `https://su.quark.cn/4_eMHBJ?token=${token}&client_id=532&ssb=weblogin&uc_param_str=&uc_biz_str=S%3Acustom%7COPT%3ASAREA%400%7COPT%3AIMMERSIVE%401%7COPT%3ABACK_BTN_STYLE%400`;
      const qrCodeUrl = await generateQrDataUrl(scanUrl);
      log('quark', 'Got token:', token, 'scanUrl:', scanUrl);
      return { success: true, qrCodeUrl, qrToken: token };
    } catch (e: any) {
      log(
        'quark',
        'generateQRCode failed:',
        e.message,
        e.response?.status,
        e.response?.data,
      );
      return {
        success: false,
        error: `${e.message} (status: ${e.response?.status || 'unknown'})`,
      };
    }
  }

  private static async pollQuarkQrCode(qrToken: string): Promise<PollResult> {
    log(
      'quark',
      'Polling, token:',
      qrToken?.slice(0, 20),
      'len:',
      qrToken?.length,
    );
    try {
      const pollUrl = `https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=532&v=1.2&token=${qrToken}`;
      log('quark', 'Poll URL:', pollUrl);
      const response = await axios.get(pollUrl, {
        headers: {
          'User-Agent': UA_QUARK_POLL,
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://pan.quark.cn/',
        },
        timeout: 15000,
      });

      const data = response.data;
      const rawDataStr = safeStringify(data);
      log('quark', 'Poll response:', rawDataStr);

      const message = data?.message;
      const serviceTicket =
        data?.data?.members?.service_ticket ||
        data?.members?.service_ticket ||
        data?.data?.service_ticket;

      log('quark', 'Poll parsed:', {
        message,
        status: data?.status,
        serviceTicket: serviceTicket
          ? `(len=${String(serviceTicket).length})`
          : 'null',
      });

      // JAR: message === "ok" means confirmed
      if (message === 'ok' && serviceTicket) {
        log('quark', 'Got service ticket, pulling login info...');

        const accountResponse = await axios.get(
          `https://pan.quark.cn/account/info?st=${serviceTicket}&lw=scan`,
          {
            headers: {
              'User-Agent': UA_QUARK_POLL,
              Referer: 'https://pan.quark.cn/',
            },
            timeout: 15000,
            validateStatus: () => true,
          },
        );

        log('quark', 'Account info status:', accountResponse.status);
        log(
          'quark',
          'Account info set-cookie:',
          accountResponse.headers['set-cookie'],
        );

        // JAR: extract __pus from set-cookie headers
        const rawSetCookies = accountResponse.headers['set-cookie'];
        let cookieStr = '';
        if (rawSetCookies) {
          const cookieList = Array.isArray(rawSetCookies)
            ? rawSetCookies
            : [rawSetCookies];
          cookieStr = cookieList.map((c: string) => c.split(';')[0]).join('; ');
        }

        const userId = accountResponse.data?.data?.userId || '';
        const nickname = accountResponse.data?.data?.nickname || '';

        log('quark', 'Login success:', {
          userId,
          nickname,
          cookieLen: cookieStr.length,
          hasPus: cookieStr.includes('__pus'),
        });

        // 补全 __puus cookie（参考 UC 流程）
        // account/info 返回的 cookie 缺少 __puus，必须额外请求 clouddrive/file/sort 触发服务端下发
        // 否则 spider 调用 CDN 下载时会返回 412 Precondition Failed
        try {
          const beforeLen = cookieStr.length;
          cookieStr = await QuarkPanService.fetchPuusCookie(cookieStr);
          log(
            'quark',
            'After fetchPuusCookie: length',
            beforeLen,
            '→',
            cookieStr.length,
            'hasPuus:',
            cookieStr.includes('__puus'),
          );
        } catch (e: any) {
          log('quark', 'fetchPuusCookie error:', e.message);
        }

        // 同步 cookie 到 JVM SharedPreferences
        log(
          'quark',
          'Calling syncCookieToJVM with cookie length:',
          cookieStr.length,
        );
        try {
          await QuarkPanService.syncCookieToJVM(cookieStr);
          log('quark', 'syncCookieToJVM completed');
        } catch (syncErr: any) {
          log('quark', 'syncCookieToJVM error:', syncErr.message);
        }

        return {
          success: true,
          status: 'confirmed',
          loginInfo: {
            panType: 'quark',
            cookie: cookieStr,
            userId,
            nickname,
            loginTime: Date.now(),
          },
          rawData: rawDataStr,
        };
      }

      // JAR: check for expired (the JAR doesn't explicitly check, but 50004002 means expired)
      if (data?.status === 50004002) {
        return { success: true, status: 'expired', rawData: rawDataStr };
      }

      return { success: true, status: 'waiting', rawData: rawDataStr };
    } catch (e: any) {
      log('quark', 'pollQRCode failed:', e.message);
      return { success: false, status: 'error', error: e.message };
    }
  }

  /**
   * UC 网盘扫码登录（从 JAR 解码）
   * Token API:  POST https://api.open.uc.cn/cas/ajax/getTokenForQrcodeLogin?__dt=641254&__t=<ts>
   *             body: client_id=381&v=1.2&request_id=<id>
   * Scan URL:   https://su.uc.cn/1_n0ZCv?uc_param_str=dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt&token=<token>&client_id=381&uc_biz_str=S%3Acustom%7CC%3Atitlebar_fix
   * Poll API:   POST https://api.open.uc.cn/cas/ajax/getServiceTicketByQrcodeToken?__dt=18884&__t=<ts>
   *             body: client_id=381&v=1.2&token=<token>
   * Cookie API: GET https://drive.uc.cn/account/info?st=<service_ticket>
   * Referer: https://broccoli.uc.cn/
   */
  private static async generateUCQrCode(): Promise<QrCodeResult> {
    const ts = Date.now();
    const requestId = `${ts}${Math.floor(Math.random() * 1000)}`;
    log('uc', 'Requesting token from api.open.uc.cn');
    try {
      const response = await axios.post(
        `https://api.open.uc.cn/cas/ajax/getTokenForQrcodeLogin?__dt=641254&__t=${ts}`,
        `client_id=381&v=1.2&request_id=${requestId}`,
        {
          headers: {
            'User-Agent': UA_UC,
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: 'https://broccoli.uc.cn/',
          },
          timeout: 15000,
        },
      );

      log('uc', 'Token response:', safeStringify(response.data));
      const token = response.data?.data?.members?.token;
      if (!token) {
        return {
          success: false,
          error: 'No token in response',
          rawData: safeStringify(response.data),
        };
      }

      const scanUrl = `https://su.uc.cn/1_n0ZCv?uc_param_str=dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt&token=${token}&client_id=381&uc_biz_str=S%3Acustom%7CC%3Atitlebar_fix`;
      const qrCodeUrl = await generateQrDataUrl(scanUrl);
      log('uc', 'Got token:', token, 'scanUrl:', scanUrl);
      return { success: true, qrCodeUrl, qrToken: token };
    } catch (e: any) {
      log(
        'uc',
        'generateQRCode failed:',
        e.message,
        e.response?.status,
        e.response?.data,
      );
      return {
        success: false,
        error: `${e.message} (status: ${e.response?.status || 'unknown'})`,
      };
    }
  }

  private static async pollUCQrCode(qrToken: string): Promise<PollResult> {
    const ts = Date.now();
    try {
      const response = await axios.post(
        `https://api.open.uc.cn/cas/ajax/getServiceTicketByQrcodeToken?__dt=18884&__t=${ts}`,
        `client_id=381&v=1.2&token=${qrToken}`,
        {
          headers: {
            'User-Agent': UA_UC,
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: 'https://broccoli.uc.cn/',
          },
          timeout: 15000,
        },
      );

      const data = response.data;
      const rawDataStr = safeStringify(data);
      log('uc', 'Poll response:', rawDataStr);
      log('uc', 'Poll response top keys:', Object.keys(data || {}));
      if (data?.data) {
        log('uc', 'Poll data.data keys:', Object.keys(data.data));
      }

      const message = data?.message;
      const rawStatus = data?.status;
      const serviceTicket =
        data?.data?.members?.service_ticket ||
        data?.members?.service_ticket ||
        data?.data?.service_ticket ||
        data?.service_ticket ||
        data?.data?.data?.members?.service_ticket;

      // service_ticket 是登录确认的唯一可靠信号
      let status: PollResult['status'] = 'waiting';
      if (serviceTicket) {
        status = 'confirmed';
      }

      log('uc', 'Poll parsed:', {
        rawStatus,
        message,
        serviceTicketValue: serviceTicket
          ? `(len=${String(serviceTicket).length})`
          : 'null',
        hasServiceTicket: !!serviceTicket,
        status,
      });

      if (status !== 'confirmed') {
        return { success: true, status, rawData: rawDataStr };
      }

      log('uc', 'Got service ticket, pulling login status...');

      const accountResponse = await axios.get(
        `https://drive.uc.cn/account/info?st=${serviceTicket}`,
        {
          headers: {
            'User-Agent': UA_UC,
            Referer: 'https://broccoli.uc.cn/',
          },
          timeout: 15000,
          validateStatus: () => true,
        },
      );

      log('uc', 'Account info response:', safeStringify(accountResponse.data));

      const rawSetCookies = accountResponse.headers['set-cookie'];
      const setCookies: string[] = !rawSetCookies
        ? []
        : Array.isArray(rawSetCookies)
          ? rawSetCookies
          : [String(rawSetCookies)];
      let cookie = setCookies.map((c: string) => c.split(';')[0]).join('; ');
      const accountData = accountResponse.data?.data || {};
      const userId = accountData.userId || '';
      const nickname = accountData.nickname || '';

      log('uc', 'Account info set-cookie count:', setCookies.length);

      if (!cookie) {
        log('uc', 'No cookie in set-cookie headers');
        return {
          success: false,
          status: 'error',
          error: 'Login succeeded but no cookie received',
        };
      }

      // 补全 __puus cookie（参考 xiaoya-alist uc_cookie.py L152-178）
      // account/info 返回的 cookie 缺少 __puus，必须额外请求 clouddrive/file/sort 触发服务端下发
      try {
        const sortResp = await axios.get(
          'https://pc-api.uc.cn/1/clouddrive/file/sort?pr=UCBrowser&fr=pc&pdir_fid=0&_page=1&_size=50&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,updated_at:desc',
          {
            headers: {
              'User-Agent': UA_UC,
              Referer: 'https://drive.uc.cn/',
              Cookie: cookie,
            },
            timeout: 15000,
            validateStatus: () => true,
          },
        );
        const extraCookiesRaw = sortResp.headers['set-cookie'];
        const extraCookies: string[] = !extraCookiesRaw
          ? []
          : Array.isArray(extraCookiesRaw)
            ? extraCookiesRaw
            : [String(extraCookiesRaw)];
        if (extraCookies.length > 0) {
          const extraCookieStr = extraCookies
            .map((c: string) => c.split(';')[0])
            .join('; ');
          cookie = `${cookie}; ${extraCookieStr}`;
          log('uc', 'Appended __puus cookie, total length:', cookie.length);
        } else {
          log('uc', 'No extra cookies from clouddrive/file/sort');
        }
      } catch (e: any) {
        log('uc', 'Failed to fetch __puus cookie:', e.message);
      }

      const loginInfo: PanLoginInfo = {
        panType: 'uc',
        cookie,
        userId,
        nickname,
        loginTime: Date.now(),
      };
      log(
        'uc',
        'Login status pulled successfully:',
        nickname || userId,
        'cookie length:',
        cookie.length,
      );
      // Sync cookie to UCPanService so resolveShareToFiles/resolveDownloadUrl
      // can use it immediately (without requiring app restart).
      UCPanService.setSyncedCookie(cookie);
      return { success: true, status: 'confirmed', loginInfo };
    } catch (e: any) {
      log('uc', 'pollQRCode failed:', e.message);
      return { success: false, status: 'error', error: e.message };
    }
  }

  /**
   * 阿里云盘扫码登录（从 JAR 解码）
   * Token API: POST https://passport.aliyundrive.com/newlogin/qrcode/generate.do?appName=aliyun_drive&fromSite=52&appName=aliyun_drive&appEntrance=web&isMobile=false&lang=zh_CN&returnUrl=&bizParams=&_bx-v=2.2.3
   * Poll API:  POST https://passport.aliyundrive.com/newlogin/qrcode/query.do?appName=aliyun_drive&fromSite=52&_bx-v=2.2.3
   * Response.data.codeContent is the scan URL to encode in the QR code.
   */
  private static async generateAliyunQrCode(): Promise<QrCodeResult> {
    log('aliyun', 'Requesting QR token from passport.aliyundrive.com');
    try {
      const response = await axios.post(
        'https://passport.aliyundrive.com/newlogin/qrcode/generate.do?appName=aliyun_drive&fromSite=52&appName=aliyun_drive&appEntrance=web&isMobile=false&lang=zh_CN&returnUrl=&bizParams=&_bx-v=2.2.3',
        '',
        {
          headers: {
            'User-Agent': UA_ALI,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json, text/plain, */*',
          },
          timeout: 15000,
        },
      );

      log('aliyun', 'Token response:', safeStringify(response.data));
      // Response is nested: { content: { data: { t, codeContent, ck, ... }, success, status } }
      const content = response.data?.content;
      const innerData = content?.data;
      if (!content?.success || !innerData?.codeContent) {
        return {
          success: false,
          error: 'No QR code in response',
          rawData: safeStringify(response.data),
        };
      }

      // codeContent is the scan URL, generate QR image from it
      const qrCodeUrl = await generateQrDataUrl(innerData.codeContent);
      return {
        success: true,
        qrCodeUrl,
        qrToken: String(innerData.t),
        extra: { ck: innerData.ck },
      };
    } catch (e: any) {
      log('aliyun', 'generateQRCode failed:', e.message, e.response?.data);
      return {
        success: false,
        error: `${e.message} (status: ${e.response?.status || 'unknown'})`,
      };
    }
  }

  private static async pollAliyunQrCode(
    t: string,
    ck: string,
  ): Promise<PollResult> {
    try {
      const body = `t=${encodeURIComponent(t)}&ck=${encodeURIComponent(ck)}`;
      const response = await axios.post(
        'https://passport.aliyundrive.com/newlogin/qrcode/query.do?appName=aliyun_drive&fromSite=52&_bx-v=2.2.3',
        body,
        {
          headers: {
            'User-Agent': UA_ALI,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json, text/plain, */*',
          },
          timeout: 15000,
        },
      );

      // Response is nested: { content: { data: { qrCodeStatus, bizExt, ... }, success } }
      const content = response.data?.content;
      const innerData = content?.data;
      log('aliyun', 'Poll response:', safeStringify(response.data));

      const statusStr = innerData?.qrCodeStatus;
      let status: PollResult['status'] = 'waiting';
      if (statusStr === 'SCANED') status = 'scanned';
      else if (statusStr === 'CONFIRMED') status = 'confirmed';
      else if (statusStr === 'EXPIRED') status = 'expired';

      if (status !== 'confirmed') {
        return { success: true, status, rawData: safeStringify(response.data) };
      }

      // Try multiple paths to get auth data after confirmation
      const bizExt = innerData?.bizExt;
      const loginResult = innerData?.loginResult;
      let refreshToken = '';
      let accessToken = '';
      let cookie = '';
      let userId = '';
      let nickname = '';

      if (bizExt) {
        try {
          const bizExtStr = Buffer.from(bizExt, 'base64').toString('latin1');
          log('aliyun', 'Decoded bizExt:', bizExtStr);
          const bizExtJson = JSON.parse(bizExtStr);
          const loginData = bizExtJson?.pds_login_result || bizExtJson || {};
          refreshToken =
            loginData.refreshToken || loginData.refresh_token || '';
          accessToken = loginData.accessToken || loginData.access_token || '';
          userId = loginData.userId || loginData.user_id || '';
          // nickName 可能包含中文，需要从 latin1 转 utf-8
          const rawNickName = loginData.nickName || loginData.nickname || '';
          if (rawNickName) {
            try {
              nickname = Buffer.from(rawNickName, 'latin1').toString('utf-8');
            } catch {
              nickname = rawNickName;
            }
          }
          cookie = loginData.cookie || '';
        } catch (e) {
          log('aliyun', 'Failed to decode bizExt:', e);
        }
      }

      if (loginResult && !refreshToken) {
        try {
          log('aliyun', 'loginResult:', safeStringify(loginResult));
          refreshToken =
            loginResult.refreshToken || loginResult.refresh_token || '';
          accessToken =
            loginResult.accessToken || loginResult.access_token || '';
          userId = loginResult.userId || loginResult.user_id || '';
          nickname = loginResult.nickName || loginResult.nickname || '';
        } catch (e) {
          log('aliyun', 'Failed to parse loginResult:', e);
        }
      }

      if (!refreshToken && !accessToken && !cookie) {
        return {
          success: false,
          status: 'error',
          error: `Login confirmed but no token received. rawData: ${safeStringify(response.data).substring(0, 500)}`,
          rawData: safeStringify(response.data),
        };
      }

      // 通过 API 获取正确的用户昵称（bizExt 中的中文可能编码异常）
      if (accessToken) {
        try {
          const userInfoRes = await axios.post(
            'https://api.aliyundrive.com/v2/user/get',
            {},
            {
              headers: {
                'User-Agent': UA_ALI,
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
              },
              timeout: 10000,
            },
          );
          log('aliyun', 'User info response:', safeStringify(userInfoRes.data));
          const userData = userInfoRes.data;
          if (userData?.nick_name || userData?.name) {
            nickname = userData.nick_name || userData.name || '';
          }
          if (!userId && userData?.user_id) {
            userId = userData.user_id;
          }
        } catch (e) {
          log('aliyun', 'Failed to get user info:', e);
        }
      }

      const loginInfo: PanLoginInfo = {
        panType: 'aliyun',
        cookie,
        refreshToken,
        accessToken,
        userId,
        nickname,
        loginTime: Date.now(),
      };
      log('aliyun', 'Login success:', nickname || userId);
      // Sync tokens to AliyunPanService so resolveShareToFiles/resolveDownloadUrl
      // can use them immediately (without requiring app restart).
      AliyunPanService.setLoginInfo({ refreshToken, accessToken });
      return { success: true, status: 'confirmed', loginInfo };
    } catch (e: any) {
      log('aliyun', 'pollQRCode failed:', e.message);
      return { success: false, status: 'error', error: e.message };
    }
  }

  /**
   * 百度网盘扫码登录
   * API: passport.baidu.com/v2/api/getqrcode + v2/channel/unevent
   */
  private static async generateBaiduQrCode(): Promise<QrCodeResult> {
    log('baidu', 'Requesting QR token from passport.baidu.com');
    try {
      const tt = Date.now();
      const response = await axios.get(
        'https://passport.baidu.com/v2/api/getqrcode',
        {
          params: {
            lp: 'pc',
            qrloginfrom: 'pc',
            qrloginrule: '1',
            gid: `7E6C1F8-${tt}-0x${(Math.random() * 0xffff).toString(16)}`,
            apiver: 'v3',
            tt: String(tt),
            logLogin: 'pc',
            isphone: '0',
            authSite: 'partner',
            action: 'login',
          },
          headers: {
            'User-Agent': UA_BAIDU,
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://pan.baidu.com/',
          },
          timeout: 15000,
        },
      );

      log('baidu', 'Token response:', safeStringify(response.data));
      const imgurl = response.data?.imgurl;
      const sign = response.data?.sign;
      if (!imgurl || !sign) {
        return {
          success: false,
          error: response.data?.msg || 'No imgurl/sign in response',
          rawData: safeStringify(response.data),
        };
      }

      // imgurl may be protocol-relative (//passport.baidu.com/...) or plain domain
      const normalizedImgurl = imgurl.startsWith('//')
        ? `https:${imgurl}`
        : imgurl.startsWith('http')
          ? imgurl
          : `https://${imgurl}`;

      return {
        success: true,
        qrCodeUrl: normalizedImgurl,
        qrToken: sign,
      };
    } catch (e: any) {
      log('baidu', 'generateQRCode failed:', e.message, e.response?.data);
      return {
        success: false,
        error: `${e.message} (status: ${e.response?.status || 'unknown'})`,
      };
    }
  }

  private static async pollBaiduQrCode(sign: string): Promise<PollResult> {
    try {
      const tt = Date.now();
      const response = await axios.get(
        'https://passport.baidu.com/channel/unicast',
        {
          params: {
            channel_id: sign,
            lp: 'pc',
            qrloginfrom: 'pc',
            apiver: 'v3',
            tt: String(tt),
            tpl: 'pp',
            _: String(tt),
          },
          headers: {
            'User-Agent': UA_BAIDU,
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://passport.baidu.com/',
          },
          timeout: 30000,
          validateStatus: () => true,
        },
      );

      const data = response.data;
      log('baidu', 'Poll response:', safeStringify(data));

      // Baidu unicast returns -1 for invalid sign, hold for events otherwise
      if (data?.errno === -1) {
        return { success: true, status: 'waiting', hasLoginInfo: false };
      }

      if (data?.errno !== 0) {
        return { success: true, status: 'waiting' };
      }

      // Parse channel_v (JSON string) for status
      let channelV: any = null;
      try {
        channelV =
          typeof data?.channel_v === 'string'
            ? JSON.parse(data.channel_v)
            : data?.channel_v;
      } catch {
        return { success: true, status: 'waiting' };
      }

      if (!channelV) {
        return { success: true, status: 'waiting' };
      }

      // status 0 = confirmed (with v token), status 1 = scanned
      if (channelV.status === 0 && channelV.v) {
        // Login confirmed, authenticate to get bduss
        const v = channelV.v;
        const u = channelV.u || 'https://pan.baidu.com/disk/main';
        const authUrl = `https://passport.baidu.com/v3/login/main/qrbdusslogin?bduss=${v}&u=${encodeURIComponent(u)}&apiver=v3&tt=${Date.now()}`;
        log(
          'baidu',
          'Authenticating with v token:',
          v.substring(0, 20) + '...',
        );

        const authResp = await axios.get(authUrl, {
          headers: {
            'User-Agent': UA_BAIDU,
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://passport.baidu.com/',
          },
          maxRedirects: 0,
          timeout: 15000,
          validateStatus: () => true,
        });

        const setCookie = authResp.headers['set-cookie'];
        const cookies: string[] = Array.isArray(setCookie)
          ? setCookie
          : setCookie
            ? [setCookie]
            : [];
        log('baidu', 'Auth cookies:', cookies);

        const loginInfo = PanLoginService.parseBaiduCookies(cookies);
        if (loginInfo) {
          loginInfo.panType = 'baidu';
          loginInfo.loginTime = Date.now();

          // Fetch user info
          try {
            const userInfoResp = await axios.get(
              'https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo',
              {
                headers: {
                  'User-Agent': UA_BAIDU,
                  Cookie: loginInfo.cookie,
                  Accept: 'application/json',
                  Referer: 'https://pan.baidu.com/',
                },
                timeout: 10000,
                validateStatus: () => true,
              },
            );
            const uData = userInfoResp.data;
            log('baidu', 'User info:', safeStringify(uData));
            if (uData?.errno === 0) {
              loginInfo.nickname = uData.baidu_name || uData.netdisk_name || '';
              loginInfo.userId = String(uData.uk || '');
            }
          } catch {
            // User info fetch failed, proceed with basic login
          }
          log(
            'baidu',
            'Login success:',
            loginInfo.nickname || loginInfo.userId,
          );
          // Sync cookie to BaiduPanService so resolveShareToFiles/resolveDownloadUrl
          // can use it immediately (without requiring app restart).
          BaiduPanService.setSyncedCookie(loginInfo.cookie || '');
          return { success: true, status: 'confirmed', loginInfo };
        }

        // Fallback: use v as BDUSS
        BaiduPanService.setSyncedCookie(`BDUSS=${v}`);
        return {
          success: true,
          status: 'confirmed',
          loginInfo: {
            panType: 'baidu',
            cookie: `BDUSS=${v}`,
            userId: '',
            nickname: '',
            loginTime: Date.now(),
          },
        };
      }

      if (channelV.status === 1) {
        return { success: true, status: 'scanned' };
      }

      return { success: true, status: 'waiting' };
    } catch (e: any) {
      log('baidu', 'pollQRCode failed:', e.message);
      // Baidu long polling times out when no event occurs (user hasn't scanned)
      if (e.code === 'ECONNABORTED' || e.message?.includes('timeout')) {
        return { success: true, status: 'waiting', hasLoginInfo: false };
      }
      return { success: false, status: 'error', error: e.message };
    }
  }

  private static parseBaiduCookies(
    cookies: string[],
  ): Partial<PanLoginInfo> | null {
    const bduss = cookies
      .find((c) => /BDUSS=([^;]+)/.test(c))
      ?.match(/BDUSS=([^;]+)/)?.[1];
    const stoken = cookies
      .find((c) => /STOKEN=([^;]+)/.test(c))
      ?.match(/STOKEN=([^;]+)/)?.[1];
    if (!bduss) return null;
    const cookieParts = [`BDUSS=${bduss}`];
    if (stoken) cookieParts.push(`STOKEN=${stoken}`);
    return { cookie: cookieParts.join('; '), userId: '', nickname: '' };
  }

  /**
   * B站扫码登录（从 JAR 解码）
   * Generate: GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-mini
   * Poll:     GET https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=<key>&source=main_mini
   */
  private static async generateBiliQrCode(): Promise<QrCodeResult> {
    log('bili', 'Requesting QR token from passport.bilibili.com');
    try {
      const response = await axios.get(
        'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-mini',
        {
          headers: {
            'User-Agent': UA_BILI,
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://www.bilibili.com/',
          },
          timeout: 15000,
        },
      );

      log('bili', 'Token response:', safeStringify(response.data));
      const data = response.data?.data;
      if (response.data?.code !== 0 || !data?.url || !data?.qrcode_key) {
        return {
          success: false,
          error: response.data?.message || 'No url/qrcode_key in response',
          rawData: safeStringify(response.data),
        };
      }

      // data.url is the scan URL, generate QR image from it
      const qrCodeUrl = await generateQrDataUrl(data.url);
      return {
        success: true,
        qrCodeUrl,
        qrToken: data.qrcode_key,
      };
    } catch (e: any) {
      log('bili', 'generateQRCode failed:', e.message, e.response?.data);
      return {
        success: false,
        error: `${e.message} (status: ${e.response?.status || 'unknown'})`,
      };
    }
  }

  private static async pollBiliQrCode(qrcodeKey: string): Promise<PollResult> {
    try {
      const response = await axios.get(
        'https://passport.bilibili.com/x/passport-login/web/qrcode/poll',
        {
          params: {
            qrcode_key: qrcodeKey,
            source: 'main_mini',
          },
          headers: {
            'User-Agent': UA_BILI,
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://www.bilibili.com/',
          },
          timeout: 15000,
          validateStatus: () => true,
        },
      );

      const data = response.data?.data;
      log('bili', 'Poll response:', safeStringify(response.data));

      // Bili code: 86101=not scanned, 86090=scanned, 86038=expired, 0=confirmed
      const code = data?.code;
      let status: PollResult['status'] = 'waiting';

      if (code === 86090) {
        status = 'scanned';
      } else if (code === 86038) {
        status = 'expired';
      } else if (code === 0) {
        status = 'confirmed';
      }

      if (status !== 'confirmed') {
        return { success: true, status };
      }

      // Login confirmed. JAR logic (from X.java decode):
      // Parse query params from data.url (crossDomain URL) and join with ';'
      // The URL contains: DedeUserID, DedeUserID__ckMd5, SESSDATA, bili_jct, sid
      const crossDomainUrl = data?.url || '';
      log('bili', 'CrossDomain URL:', crossDomainUrl);

      let cookie = '';
      let userId = '';
      try {
        const urlObj = new URL(crossDomainUrl);
        const params = urlObj.searchParams;
        const cookieParts: string[] = [];
        // Bili cookie keys (from crossDomain URL query params)
        const cookieKeys = [
          'SESSDATA',
          'bili_jct',
          'DedeUserID',
          'DedeUserID__ckMd5',
          'sid',
        ];
        for (const key of cookieKeys) {
          const val = params.get(key);
          if (val) {
            cookieParts.push(`${key}=${val}`);
            if (key === 'DedeUserID') userId = val;
          }
        }
        cookie = cookieParts.join('; ');
      } catch (e: any) {
        log('bili', 'Failed to parse crossDomain URL:', e.message);
      }

      // Fallback: also check set-cookie headers
      if (!cookie) {
        const setCookies = response.headers['set-cookie'] || [];
        cookie = setCookies.map((c: string) => c.split(';')[0]).join('; ');
      }

      if (!cookie) {
        return {
          success: false,
          status: 'error',
          error: 'Login confirmed but no cookie received',
        };
      }

      const loginInfo: PanLoginInfo = {
        panType: 'bili',
        cookie,
        userId,
        loginTime: Date.now(),
      };

      // Fetch user info to get nickname
      try {
        const navResp = await axios.get(
          'https://api.bilibili.com/x/web-interface/nav',
          {
            headers: {
              'User-Agent': UA_BILI,
              Cookie: cookie,
              Accept: 'application/json',
              Referer: 'https://www.bilibili.com/',
            },
            timeout: 10000,
            validateStatus: () => true,
          },
        );
        const navData = navResp.data?.data;
        log('bili', 'Nav info:', safeStringify(navData));
        if (navData?.uname) {
          loginInfo.nickname = navData.uname;
        }
        if (navData?.mid) {
          loginInfo.userId = String(navData.mid);
        }
      } catch {
        // User info fetch failed, proceed with basic login
      }
      log(
        'bili',
        'Login success, uid:',
        userId,
        'cookie length:',
        cookie.length,
      );
      return { success: true, status: 'confirmed', loginInfo };
    } catch (e: any) {
      log('bili', 'pollQRCode failed:', e.message);
      return { success: false, status: 'error', error: e.message };
    }
  }
}
