import axios from 'axios';
import { ipcMain } from 'electron';

/**
 * Pan139Service - 移动云盘 (China Mobile 139 Cloud) share resolver.
 *
 * Based on Android spider NewPan139.java decompiled flow:
 *
 *   1. Parse share URL to extract linkID (contentId assumed equal to linkID
 *      for quick-play; full list needs login via getOutLinkInfoV6).
 *   2. POST getContentInfoFromOutLink to get a direct presentURL — this is
 *      the quick-play API that works WITHOUT login. It returns ONE video
 *      (the first/main file in the share).
 *   3. For full file list, getOutLinkInfoV6 requires Wex_139_cookie login.
 *      Not implemented here; quick-play covers single-file shares which are
 *      the common case for TV episodes.
 *
 * The presentURL is a direct CDN link (no Cookie/Referer needed), so the
 * player can stream it directly without going through ProxyServer.
 */
export class Pan139Service {
  private static syncedCookie: string | null = null;
  private static syncedUser: string | null = null;
  // Cache: linkID → { presentURL, expiresAt, fileName }
  private static quickPlayCache = new Map<
    string,
    { presentURL: string; expiresAt: number; fileName: string }
  >();

  static init(): void {
    ipcMain.handle('pan139:setCookie', async (_event, cookie: string, user?: string) => {
      this.syncedCookie = cookie;
      this.syncedUser = user || null;
      return { success: true };
    });
    ipcMain.handle('pan139:getCookie', async () => {
      return { cookie: this.syncedCookie, user: this.syncedUser };
    });
    console.log('[Pan139Service] Initialized');
  }

  static setSyncedCookie(cookie: string | null, user?: string | null): void {
    this.syncedCookie = cookie;
    if (user !== undefined) this.syncedUser = user;
  }
  static getSyncedCookie(): string | null {
    return this.syncedCookie;
  }

  private static buildHeaders(): Record<string, string> {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36  115Browser/26.0.7.2',
      'Content-Type': 'application/json;charset=UTF-8',
      Referer: 'https://yun.139.com/',
    };
  }

  /**
   * Parse a 139 pan share URL to extract linkID.
   * URL formats:
   *   https://yun.139.com/shareweb/#/w/i/<linkID>
   *   https://yun.139.com/w/i/<linkID>
   *   https://caiyun.139.com/m/i?<linkID>
   *   https://caiyun.139.com/m/i?linkID=<linkID>
   */
  private static parseShareUrl(shareUrl: string): string | null {
    try {
      let decoded = shareUrl;
      try {
        decoded = decodeURIComponent(shareUrl);
      } catch {
        // ignore
      }
      // Format: yun.139.com/shareweb/#/w/i/<linkID> or yun.139.com/w/i/<linkID>
      let match = decoded.match(
        /https?:\/\/(?:yun\.|caiyun\.)?139\.com\/(?:shareweb\/#\/w\/i\/|w\/i\/|m\/i\?(?:linkID=)?)([a-zA-Z0-9]+)/,
      );
      if (match) {
        return match[1];
      }
      // Fallback: any 139.com link with an ID-like token
      match = decoded.match(/139\.com.*?([a-zA-Z0-9]{12,})/);
      if (match) {
        return match[1];
      }
      console.warn('[Pan139Service] parseShareUrl: no match for', shareUrl);
      return null;
    } catch (e: any) {
      console.warn('[Pan139Service] parseShareUrl error:', e.message);
      return null;
    }
  }

  /**
   * Resolve a 139 pan share link via quick-play API (no login).
   * Returns the single presentURL from getContentInfoFromOutLink.
   * For multi-file shares, only the first/main video is returned.
   */
  static async resolveShareToFiles(shareUrl: string): Promise<{
    success: boolean;
    title?: string;
    files?: Array<{
      fileId: string;
      fileName: string;
      size: number;
      directUrl?: string;
    }>;
    error?: string;
  }> {
    const linkID = this.parseShareUrl(shareUrl);
    if (!linkID) {
      return {
        success: false,
        error: 'Invalid 139 pan share URL: ' + shareUrl,
      };
    }
    console.log('[Pan139Service] resolveShareToFiles: linkID=', linkID);

    // Check cache
    const cached = this.quickPlayCache.get(linkID);
    if (cached && cached.expiresAt > Date.now()) {
      console.log('[Pan139Service] resolveShareToFiles: cache hit for', linkID);
      return {
        success: true,
        title: '139-' + linkID,
        files: [
          {
            fileId: linkID,
            fileName: cached.fileName || `139-${linkID}`,
            size: 0,
            directUrl: cached.presentURL,
          },
        ],
      };
    }

    try {
      // Quick-play API: contentId = linkID (assumed; full list needs login)
      const body = {
        getContentInfoFromOutLinkReq: {
          contentId: linkID,
          linkID: linkID,
          account: '',
        },
        commonAccountInfo: {
          account: '',
          accountType: 1,
        },
      };
      const resp = await axios.post(
        'https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/getContentInfoFromOutLink',
        body,
        {
          headers: this.buildHeaders(),
          timeout: 15000,
          validateStatus: () => true,
        },
      );
      const data = resp.data;
      if (!data || !data.data || !data.data.contentInfo) {
        console.warn(
          '[Pan139Service] resolveShareToFiles: no contentInfo in response, resp=',
          JSON.stringify(data).slice(0, 500),
        );
        return {
          success: false,
          error: '139网盘分享解析失败：响应中无contentInfo',
        };
      }
      const contentInfo = data.data.contentInfo;
      const presentURL = contentInfo.presentURL || contentInfo.playUrl || '';
      if (!presentURL) {
        console.warn(
          '[Pan139Service] resolveShareToFiles: no presentURL, contentInfo=',
          JSON.stringify(contentInfo).slice(0, 500),
        );
        return {
          success: false,
          error: '139网盘分享解析失败：无法获取播放链接',
        };
      }
      // Try to extract a file name from contentInfo
      let fileName =
        contentInfo.fileName ||
        contentInfo.name ||
        contentInfo.title ||
        `139-${linkID}`;
      // If fileName has no extension, try to get from presentURL
      if (!/\.[^.]+$/.test(fileName) && presentURL) {
        const urlExt = presentURL.match(/\.(mp4|mkv|ts|m3u8|flv|avi|mov|webm)(\?|$)/i);
        if (urlExt) {
          fileName = fileName + '.' + urlExt[1].toLowerCase();
        }
      }
      // Cache for 50 minutes
      this.quickPlayCache.set(linkID, {
        presentURL,
        expiresAt: Date.now() + 50 * 60 * 1000,
        fileName,
      });
      console.log(
        '[Pan139Service] resolveShareToFiles: got presentURL for',
        linkID,
        '(len=',
        presentURL.length,
        ')',
      );
      return {
        success: true,
        title: '139-' + linkID,
        files: [
          {
            fileId: linkID,
            fileName,
            size: Number(contentInfo.fileSize || contentInfo.size || 0),
            directUrl: presentURL,
          },
        ],
      };
    } catch (e: any) {
      console.error(
        '[Pan139Service] resolveShareToFiles error:',
        e.message,
        e.response?.status,
      );
      return {
        success: false,
        error: `${e.message} (status: ${e.response?.status || 'unknown'})`,
      };
    }
  }

  /**
   * Resolve a 139 pan file to a direct play URL.
   * For quick-play mode, the directUrl is already available from
   * resolveShareToFiles. This method re-fetches if cache expired.
   */
  static async resolveDownloadUrl(
    linkID: string,
    _fileId: string,
  ): Promise<string | null> {
    const cached = this.quickPlayCache.get(linkID);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.presentURL;
    }
    // Re-fetch via quick-play
    const result = await this.resolveShareToFiles(
      `https://yun.139.com/w/i/${linkID}`,
    );
    if (result.success && result.files && result.files.length > 0) {
      return result.files[0].directUrl || null;
    }
    return null;
  }
}
