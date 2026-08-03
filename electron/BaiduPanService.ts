import axios from 'axios';
import { ipcMain } from 'electron';
import { jarLoader } from './JarLoader';

/**
 * BaiduPanService - 百度网盘 share resolver.
 *
 * Baidu's API is the most restrictive among the supported pans:
 *   - BDUSS cookie-based auth
 *   - Share files require transfer to user's netdisk before streaming
 *   - Streaming endpoint /xpan/file/streaming returns HLS m3u8
 *   - Free accounts have a 100MB direct-download limit (streaming bypasses)
 *
 * Flow:
 *   1. resolveShareToFiles: scrape share page HTML → extract share info +
 *      file list (surl, sign, timestamp, bdstoken, shareid, uk, fsidlist).
 *   2. resolveDownloadUrl: transfer share to user's netdisk via
 *      /share/transfer, then call /xpan/file/streaming on the transferred
 *      file. Returns a streaming m3u8 URL.
 */
export class BaiduPanService {
  private static syncedCookie: string | null = null;
  private static bdstoken: string | null = null;
  // Cache: (surl:fsid) → { streamUrl, expiresAt, transferredFsid }
  private static streamUrlCache = new Map<
    string,
    { streamUrl: string; expiresAt: number }
  >();
  // Cache: surl → share page scrape result (sign, timestamp, shareid, uk,
  // bdstoken). Needed because playerContent only receives surl+fsid; we look
  // up the rest from this cache. Baidu's SIGN/TIMESTAMP are session-bound
  // and valid for a few hours.
  private static shareInfoCache = new Map<
    string,
    {
      sign: string;
      timestamp: string;
      shareId: string;
      uk: string;
      bdstoken: string;
      expiresAt: number;
    }
  >();

  static init(): void {
    ipcMain.handle('baidu:setCookie', async (_event, cookie: string) => {
      this.syncedCookie = cookie;
      this.bdstoken = this.extractCookieValue(cookie, 'BDSTOKEN');
      console.log(
        '[BaiduPanService] setCookie: length=',
        cookie?.length,
        'bdstoken=',
        this.bdstoken,
      );
      return { success: true };
    });
    ipcMain.handle('baidu:getCookie', async () => {
      return { cookie: this.syncedCookie };
    });
    console.log('[BaiduPanService] Initialized');
  }

  static setSyncedCookie(cookie: string | null): void {
    this.syncedCookie = cookie;
    if (cookie) {
      this.bdstoken = this.extractCookieValue(cookie, 'BDSTOKEN');
    }
  }
  /**
   * Get the last cookie synced from renderer (or JVM SharedPreferences).
   *
   * If the in-memory syncedCookie is null (e.g., user logged in via wexconfig
   * iframe during this session — that path writes to SharedPreferences but
   * never calls setSyncedCookie), fall back to reading directly from JVM
   * SharedPreferences. This makes the config center the single source of
   * truth for login state.
   */
  static getSyncedCookie(): string | null {
    if (this.syncedCookie) return this.syncedCookie;
    const jvmCookie = jarLoader.readBaiduCookieFromJVM();
    if (jvmCookie) {
      this.syncedCookie = jvmCookie;
      this.bdstoken = this.extractCookieValue(jvmCookie, 'BDSTOKEN');
      console.log(
        '[BaiduPanService] getSyncedCookie: syncedCookie was null, read from JVM SharedPreferences (len=',
        jvmCookie.length,
        ')',
      );
    }
    return jvmCookie;
  }

  private static encryptBaiduCookie(cookie: string, xorKey: string): string {
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

  /**
   * Sync Baidu cookie to JVM SharedPreferences so the spider can read it.
   *
   * The spider reads Baidu cookie from:
   *   1. com.github.catvod.tvbox_preferences — key "mi.baidu" (XOR-encrypted with "miwudi")
   *      or ".baidu" (plaintext fallback) — via e_1.a() -> e_1.b("mi.baidu", ".baidu")
   *   2. NewWexFnw_preferences — key "Wex_baidu_cookie" — used by guard spider static field
   *
   * Mirrors QuarkPanService.syncCookieToJVM which writes both prefs for Quark.
   */
  static async syncToGuardPrefs(cookie: string): Promise<void> {
    if (!cookie) return;
    try {
      if (!jarLoader || !jarLoader.java) {
        console.warn(
          '[BaiduPanService] JVM not ready, skipping guard prefs sync',
        );
        return;
      }
      const InitClass = jarLoader.java.importClass(
        'com.github.catvod.spider.Init',
      );
      const ctx = InitClass.contextSync();
      if (!ctx) {
        console.warn('[BaiduPanService] Init.context() returned null');
        return;
      }

      // Write to main spider preferences (com.github.catvod.tvbox_preferences)
      // — key "mi.baidu" (XOR-encrypted with "miwudi") for e_1.a()
      // — also plaintext ".baidu" as fallback
      const XOR_KEY = 'miwudi';
      const PREFS_NAME = 'com.github.catvod.tvbox_preferences';
      const encryptedCookie = this.encryptBaiduCookie(cookie, XOR_KEY);
      const prefs = ctx.getSharedPreferencesSync(PREFS_NAME, 0);
      if (prefs) {
        const editor = prefs.editSync();
        editor.putStringSync('mi.baidu', encryptedCookie);
        editor.putStringSync('.baidu', cookie);
        editor.applySync();
        console.log(
          `[BaiduPanService] Synced cookie to ${PREFS_NAME} (mi.baidu encrypted + .baidu plain), length: ${cookie.length}`,
        );
      }

      // Write to guard spider preferences (NewWexFnw_preferences)
      const GUARD_PREFS = 'NewWexFnw_preferences';
      const guardPrefs = ctx.getSharedPreferencesSync(GUARD_PREFS, 0);
      const editor = guardPrefs.editSync();
      editor.putStringSync('Wex_baidu_cookie', cookie);
      editor.applySync();
      console.log(
        `[BaiduPanService] Synced cookie to ${GUARD_PREFS} (Wex_baidu_cookie), length: ${cookie.length}`,
      );
    } catch (e: any) {
      console.warn(
        '[BaiduPanService] Failed to sync to guard prefs:',
        e?.message || e,
      );
    }
  }

  private static extractCookieValue(
    cookie: string,
    key: string,
  ): string | null {
    const match = cookie.match(new RegExp(`\\b${key}=([^;]+)`));
    return match ? match[1] : null;
  }

  private static buildHeaders(): Record<string, string> {
    const UA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    return {
      Cookie: this.syncedCookie || '',
      'User-Agent': UA,
      Referer: 'https://pan.baidu.com/',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
  }

  /**
   * Resolve a Baidu share link to a list of video files.
   *
   * Baidu doesn't expose a clean JSON API for share listing — we scrape the
   * share page HTML and extract the embedded file list JSON.
   */
  static async resolveShareToFiles(shareUrl: string): Promise<{
    success: boolean;
    title?: string;
    files?: Array<{
      fsId: string;
      fileName: string;
      size: number;
      surl: string;
      shareId: string;
      uk: string;
      sign: string;
      timestamp: string;
      bdstoken: string;
    }>;
    error?: string;
  }> {
    if (!this.syncedCookie) {
      return {
        success: false,
        error: 'Baidu cookie not synced. Please login first.',
      };
    }
    // Extract surl from URL like https://pan.baidu.com/s/1abc-def
    const match = shareUrl.match(/\/s\/([a-zA-Z0-9_-]+)/);
    if (!match) {
      return { success: false, error: 'Invalid share URL: ' + shareUrl };
    }
    const surl = match[1];
    // Baidu's /share/verify API expects the SHORT surl (without the leading
    // "1" prefix). The share page URL uses the full surl (with "1").
    const shortSurl = surl.replace(/^1/, '');
    // Extract optional ?pwd=xxx (added by JarLoader when scanning detail HTML).
    const pwdMatch = shareUrl.match(/[?&]pwd=([a-zA-Z0-9]+)/);
    const pwd = pwdMatch?.[1] || '';

    // If a password is present, call /share/verify to obtain the BDCLND
    // cookie that grants access to the share page. The verify endpoint
    // returns JSON with errno=0 on success and sets BDCLND via Set-Cookie.
    let extraCookie = '';
    if (pwd) {
      try {
        const verifyUrl = `https://pan.baidu.com/share/verify?surl=${shortSurl}&pwd=${pwd}&bdstoken=${this.bdstoken || ''}&clienttype=0&channel=chunmi`;
        const verifyResp = await axios.get(verifyUrl, {
          headers: this.buildHeaders(),
          timeout: 15000,
          validateStatus: () => true,
        });
        const setCookieHeader: string =
          (verifyResp.headers?.['set-cookie'] as any) || '';
        const bdclndMatch = Array.isArray(setCookieHeader)
          ? setCookieHeader.find((c: string) => c.startsWith('BDCLND='))
          : (setCookieHeader as string).match(/BDCLND=([^;]+)/);
        const bdclnd = bdclndMatch
          ? Array.isArray(setCookieHeader)
            ? bdclndMatch.split(';')[0].split('=')[1]
            : bdclndMatch[1]
          : '';
        if (bdclnd) {
          extraCookie = `BDCLND=${bdclnd}`;
          console.log(
            '[BaiduPanService] resolveShareToFiles: verified pwd, got BDCLND cookie',
          );
        } else {
          console.warn(
            '[BaiduPanService] resolveShareToFiles: pwd verify returned no BDCLND, errno=',
            verifyResp.data?.errno,
          );
        }
      } catch (e: any) {
        console.warn(
          '[BaiduPanService] resolveShareToFiles: pwd verify failed:',
          e.message,
        );
      }
    }

    const headers = extraCookie
      ? {
          ...this.buildHeaders(),
          Cookie: `${this.syncedCookie}; ${extraCookie}`,
        }
      : this.buildHeaders();

    try {
      // Fetch share page HTML (strip the pwd query param — share page URL
      // must be /s/<surl>, not /s/<surl>?pwd=xxx, otherwise Baidu returns
      // a redirect loop).
      const cleanShareUrl = `https://pan.baidu.com/s/${surl}`;
      const resp = await axios.get(cleanShareUrl, {
        headers,
        timeout: 20000,
        responseType: 'text',
        validateStatus: () => true,
        maxRedirects: 5,
      });
      const html: string = typeof resp.data === 'string' ? resp.data : '';
      if (!html) {
        return { success: false, error: 'Empty HTML from share page' };
      }

      // Extract sign + timestamp from HTML
      // Page contains: window.yunData = { SIGN: "...", TIMESTAMP: "..." };
      const signMatch = html.match(/["']SIGN["']\s*:\s*["']([^"']+)["']/);
      const tsMatch = html.match(/["']TIMESTAMP["']\s*:\s*["']?(\d+)["']?/);
      const shareIdMatch = html.match(/["']shareid["']\s*:\s*["']?(\d+)["']?/);
      const ukMatch = html.match(/["']share_uk["']\s*:\s*["']?(\d+)["']?/);
      const bdstokenMatch = html.match(
        /["']bdstoken["']\s*:\s*["']?(\d+)["']?/,
      );

      const sign = signMatch?.[1] || '';
      const timestamp = tsMatch?.[1] || '';
      const shareId = shareIdMatch?.[1] || '';
      const uk = ukMatch?.[1] || '';
      const bdstoken = bdstokenMatch?.[1] || this.bdstoken || '';

      if (!sign || !timestamp) {
        console.warn(
          '[BaiduPanService] resolveShareToFiles: failed to extract SIGN/TIMESTAMP from HTML (length=',
          html.length,
          ')',
        );
        return {
          success: false,
          error:
            '无法解析分享页面（可能需要登录或分享已失效）。请先在浏览器中登录百度网盘并打开此分享链接确认其有效性。',
        };
      }

      // Cache share-page scrape result so playerContent (which only receives
      // surl+fsid) can look up sign/timestamp/shareid/uk/bdstoken later.
      this.shareInfoCache.set(surl, {
        sign,
        timestamp,
        shareId,
        uk,
        bdstoken,
        // Baidu session SIGN is valid ~4 hours; refresh 30 min before.
        expiresAt: Date.now() + (4 * 3600 - 1800) * 1000,
      });

      // Try to extract file list from embedded JSON
      const fileListMatch = html.match(
        /["']fileList["']\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
      );
      let fileList: any[] = [];
      if (fileListMatch) {
        try {
          fileList = JSON.parse(fileListMatch[1]);
        } catch {
          // ignore parse error
        }
      }

      // If fileList not in HTML, fetch via API
      if (fileList.length === 0 && shareId && uk) {
        const wxlistUrl =
          `https://pan.baidu.com/share/wxlist?channel=weixin&version=2.2.2&clienttype=25&web=1` +
          `&_=${Date.now()}&shareid=${shareId}&uk=${uk}` +
          `&sign=${encodeURIComponent(sign)}&timestamp=${timestamp}` +
          `&bdstoken=${bdstoken}`;
        const wxResp = await axios.get(wxlistUrl, {
          headers: {
            ...headers,
            Accept: 'application/json, text/plain, */*',
          },
          timeout: 15000,
          validateStatus: () => true,
        });
        if (wxResp.data?.errno === 0 && wxResp.data?.data?.list) {
          fileList = wxResp.data.data.list;
        }
      }

      const videoExtRegex =
        /\.(mp4|mkv|ts|avi|mov|flv|webm|m4v|mpg|mpeg|3gp|m3u8|rmvb)$/i;
      const files = fileList
        .filter(
          (f: any) =>
            f.isdir === 0 &&
            videoExtRegex.test(f.server_filename || f.filename || ''),
        )
        .map((f: any) => ({
          fsId: String(f.fs_id),
          fileName: f.server_filename || f.filename || '',
          size: f.size || 0,
          surl,
          shareId,
          uk,
          sign,
          timestamp,
          bdstoken,
        }));

      console.log(
        '[BaiduPanService] resolveShareToFiles: surl=',
        surl,
        'files=',
        files.length,
        '(total fileList=',
        fileList.length,
        ')',
      );

      if (files.length === 0) {
        return {
          success: false,
          error: '分享中没有找到视频文件',
        };
      }

      return {
        success: true,
        title: 'Baidu-' + surl,
        files,
      };
    } catch (e: any) {
      console.error(
        '[BaiduPanService] resolveShareToFiles error:',
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
   * Resolve a Baidu share file to a streaming URL.
   *
   * Transfers the share file to user's netdisk, then calls
   * /xpan/file/streaming to get an HLS m3u8 URL.
   *
   * shareInfo (sign/timestamp/shareid/uk/bdstoken) is looked up from the cache
   * populated by resolveShareToFiles. If missing/expired, we re-scrape the
   * share page.
   */
  static async resolveDownloadUrl(
    surl: string,
    fsId: string,
  ): Promise<string | null> {
    if (!this.syncedCookie) {
      console.warn('[BaiduPanService] resolveDownloadUrl: no synced cookie');
      return null;
    }

    const cacheKey = `${surl}:${fsId}`;
    const cached = this.streamUrlCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.log('[BaiduPanService] resolveDownloadUrl: cache hit');
      return cached.streamUrl;
    }

    // Look up shareInfo from cache; re-scrape if missing/expired.
    let shareInfo = this.shareInfoCache.get(surl);
    if (!shareInfo || shareInfo.expiresAt < Date.now()) {
      const reScraped = await this.scrapeShareInfo(surl);
      if (!reScraped) {
        console.warn(
          '[BaiduPanService] resolveDownloadUrl: no shareInfo for surl=',
          surl,
        );
        return null;
      }
      shareInfo = reScraped;
    }

    const headers = this.buildHeaders();

    try {
      // Step 1: Transfer share file to user's netdisk.
      const transferUrl =
        `https://pan.baidu.com/share/transfer?shareid=${shareInfo.shareId}` +
        `&from=${shareInfo.uk}&sekey=${encodeURIComponent(shareInfo.sign)}` +
        `&bdstoken=${shareInfo.bdstoken || this.bdstoken || ''}`;
      const transferResp = await axios.post(
        transferUrl,
        `fsidlist=${encodeURIComponent(`[${fsId}]`)}`,
        {
          headers: {
            ...headers,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 15000,
          validateStatus: () => true,
        },
      );
      if (transferResp.data?.errno !== 0) {
        console.warn(
          '[BaiduPanService] transfer failed: errno=',
          transferResp.data?.errno,
          transferResp.data?.errmsg,
        );
        // errno 12: file already exists — proceed to find it
        if (transferResp.data?.errno !== 12) {
          return null;
        }
      }
      const transferredFsid: string =
        transferResp.data?.data?.fsid_list?.[0] || fsId;
      console.log(
        '[BaiduPanService] resolveDownloadUrl: transferred, fsid=',
        transferredFsid,
      );

      // Step 2: Get file path in user's netdisk (we need the path for streaming)
      const pathResp = await axios.get(
        `https://pan.baidu.com/api/filemetas?app_id=250528&method=streaming&fs_id=${transferredFsid}`,
        {
          headers: {
            ...headers,
            Accept: 'application/json',
          },
          timeout: 15000,
          validateStatus: () => true,
        },
      );
      if (pathResp.data?.errno !== 0) {
        console.warn(
          '[BaiduPanService] filemetas failed: errno=',
          pathResp.data?.errno,
        );
        return null;
      }
      const filePath: string = pathResp.data?.list?.[0]?.path || '';
      if (!filePath) {
        console.warn('[BaiduPanService] no file path returned');
        return null;
      }
      console.log('[BaiduPanService] resolveDownloadUrl: file path=', filePath);

      // Step 3: Get streaming URL (HLS m3u8).
      // Use the file's basename from the path for the name param.
      const fileName = filePath.split('/').pop() || 'video';
      const streamUrl =
        `https://pan.baidu.com/rest/2.0/xpan/file/streaming?app_id=250528` +
        `&method=streaming&path=${encodeURIComponent(filePath)}` +
        `&type=M3U8_AUTO_480&name=${encodeURIComponent(fileName)}`;
      // Verify the URL returns 200 with m3u8 content
      const verifyResp = await axios.get(streamUrl, {
        headers: {
          ...headers,
          Accept: 'application/vnd.apple.mpegurl, */*',
        },
        timeout: 15000,
        validateStatus: () => true,
        responseType: 'text',
      });
      if (verifyResp.status !== 200) {
        console.warn(
          '[BaiduPanService] streaming verify failed: status=',
          verifyResp.status,
        );
        return null;
      }
      // Cache for 30 minutes (m3u8 URLs typically valid for 1-12 hours).
      this.streamUrlCache.set(cacheKey, {
        streamUrl,
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      console.log(
        '[BaiduPanService] resolveDownloadUrl: got streaming URL, length=',
        streamUrl.length,
      );

      // Schedule cleanup (delete transferred file after 1 hour).
      setTimeout(
        () => {
          void this.deleteFile(headers, transferredFsid);
          this.streamUrlCache.delete(cacheKey);
        },
        60 * 60 * 1000,
      );

      return streamUrl;
    } catch (e: any) {
      console.error('[BaiduPanService] resolveDownloadUrl error:', e.message);
      return null;
    }
  }

  private static async deleteFile(
    headers: Record<string, string>,
    fsid: string,
  ): Promise<void> {
    try {
      await axios.post(
        `https://pan.baidu.com/api/filemanager?app_id=250528&method=delete&bdstoken=${this.bdstoken || ''}`,
        `fidlist=${encodeURIComponent(`[${fsid}]`)}`,
        {
          headers: {
            ...headers,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 15000,
          validateStatus: () => true,
        },
      );
      console.log('[BaiduPanService] deleted file fsid=', fsid);
    } catch (e: any) {
      console.warn('[BaiduPanService] deleteFile error:', e.message);
    }
  }

  /**
   * Re-scrape a Baidu share page to refresh sign/timestamp/shareid/uk/bdstoken.
   * Used by resolveDownloadUrl when the cached shareInfo has expired.
   */
  private static async scrapeShareInfo(surl: string): Promise<{
    sign: string;
    timestamp: string;
    shareId: string;
    uk: string;
    bdstoken: string;
    expiresAt: number;
  } | null> {
    if (!this.syncedCookie) return null;
    const shareUrl = 'https://pan.baidu.com/s/' + surl;
    const headers = this.buildHeaders();
    try {
      const resp = await axios.get(shareUrl, {
        headers,
        timeout: 20000,
        responseType: 'text',
        validateStatus: () => true,
        maxRedirects: 5,
      });
      const html: string = typeof resp.data === 'string' ? resp.data : '';
      if (!html) return null;
      const sign = html.match(/["']SIGN["']\s*:\s*["']([^"']+)["']/)?.[1] || '';
      const timestamp =
        html.match(/["']TIMESTAMP["']\s*:\s*["']?(\d+)["']?/)?.[1] || '';
      const shareId =
        html.match(/["']shareid["']\s*:\s*["']?(\d+)["']?/)?.[1] || '';
      const uk =
        html.match(/["']share_uk["']\s*:\s*["']?(\d+)["']?/)?.[1] || '';
      const bdstoken =
        html.match(/["']bdstoken["']\s*:\s*["']?(\d+)["']?/)?.[1] ||
        this.bdstoken ||
        '';
      if (!sign || !timestamp) return null;
      const info = {
        sign,
        timestamp,
        shareId,
        uk,
        bdstoken,
        expiresAt: Date.now() + (4 * 3600 - 1800) * 1000,
      };
      this.shareInfoCache.set(surl, info);
      return info;
    } catch {
      return null;
    }
  }
}
