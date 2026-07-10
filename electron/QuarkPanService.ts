import axios from 'axios';
import { ipcMain, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
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
      this.clearLoginState();
      return { success: true };
    });

    // Check token validity by making a lightweight API call.
    // Used by config center to detect expired tokens on each open.
    ipcMain.handle('quark:checkTokenValid', async () => {
      return this.checkTokenValid();
    });

    // Diagnostic: test Quark share-link API with the synced cookie.
    // Used to verify the cookie is valid and the API endpoint is reachable.
    ipcMain.handle(
      'quark:diagnoseShareApi',
      async (_event, shareUrl: string) => {
        return this.diagnoseShareApi(shareUrl);
      },
    );

    console.log('[QuarkPanService] Initialized');
  }

  /**
   * Diagnose Quark share-link resolution by calling the API directly.
   * Tests whether the synced cookie can resolve a share link to file info.
   * Returns detailed status for each step.
   */
  static async diagnoseShareApi(shareUrl: string): Promise<any> {
    const cookie = this.syncedCookie;
    if (!cookie) {
      return { error: 'No synced cookie. Please login to Quark first.' };
    }
    // Extract share_id from URL like "https://pan.quark.cn/s/0e027826e13f"
    const match = shareUrl.match(/\/s\/([a-zA-Z0-9]+)/);
    if (!match) {
      return { error: 'Invalid share URL: ' + shareUrl };
    }
    const shareId = match[1];
    const UA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    const result: any = {
      cookieLength: cookie.length,
      hasPus: cookie.includes('__pus'),
      hasPuus: cookie.includes('__puus'),
      shareId,
      steps: [],
    };
    // Step 1: Get share token
    try {
      const tokenUrl =
        'https://drive-pc.quark.cn/1/clouddrive/file/share/sharepage/token?pr=ucpro&fr=pc';
      const tokenResp = await axios.post(
        tokenUrl,
        { share_id: shareId },
        {
          headers: {
            Cookie: cookie,
            'User-Agent': UA,
            'Content-Type': 'application/json',
            Referer: 'https://pan.quark.cn/',
          },
          timeout: 10000,
        },
      );
      result.steps.push({
        step: 'token',
        status: tokenResp.status,
        data: tokenResp.data,
      });
      // Step 2: Get share detail (file list)
      const pwdId = tokenResp.data?.data?.pwd_id || shareId;
      const detailUrl = `https://drive-pc.quark.cn/1/clouddrive/file/share/sharepage/detail?pr=ucpro&fr=pc&share_id=${shareId}&pwd_id=${pwdId}&stoken=${tokenResp.data?.data?.stoken || ''}&pdir_fid=0&_page=1&_size=50`;
      const detailResp = await axios.get(detailUrl, {
        headers: {
          Cookie: cookie,
          'User-Agent': UA,
          Referer: 'https://pan.quark.cn/',
        },
        timeout: 10000,
      });
      result.steps.push({
        step: 'detail',
        status: detailResp.status,
        fileListCount: detailResp.data?.data?.list?.length || 0,
        firstFile: detailResp.data?.data?.list?.[0] || null,
      });
    } catch (e: any) {
      result.steps.push({
        step: 'error',
        message: e.message,
        responseData: e.response?.data,
        status: e.response?.status,
      });
    }
    console.log(
      '[QuarkPanService] diagnoseShareApi result:',
      JSON.stringify(result, null, 2),
    );
    return result;
  }

  /**
   * Get the last cookie synced to JVM SharedPreferences.
   * Used by ProxyServer to inject into spider params, bypassing
   * the spider's SharedPreferences read path.
   */
  static getSyncedCookie(): string | null {
    return this.syncedCookie;
  }

  /**
   * Clear all in-memory login state. Called by PanLoginService.pan:logout.
   * Also clears the playUrlCache so a re-login doesn't reuse stale URLs
   * bound to the previous __puus.
   */
  static clearLoginState(): void {
    this.loginInfo = null;
    this.syncedCookie = null;
    this.playUrlCache.clear();
    this.shareFidTokenCache.clear();
    this.tvboxFolderFid = null;
    console.log(
      '[QuarkPanService] clearLoginState: loginInfo, syncedCookie, caches cleared',
    );
    // Also clear JVM SharedPreferences so spider no longer thinks user is logged in
    this.clearJvmCookie().catch((e) =>
      console.warn(
        '[QuarkPanService] clearLoginState: JVM clear failed:',
        e.message,
      ),
    );
  }

  /**
   * Check if the current Quark token/cookie is still valid.
   * Makes a lightweight API call to /clouddrive/auth/pc/flush to verify.
   * Returns { valid: true, nickname } if valid, { valid: false } if expired.
   */
  static async checkTokenValid(): Promise<{
    valid: boolean;
    nickname?: string;
  }> {
    const cookie = this.syncedCookie;
    if (!cookie) {
      return { valid: false };
    }
    try {
      const resp = await axios.post(
        'https://drive-pc.quark.cn/1/clouddrive/auth/pc/flush?pr=ucpro&fr=pc&uc_param_str=',
        null,
        {
          headers: {
            Cookie: cookie,
            'User-Agent': this.QUARK_DESKTOP_UA,
            'Content-Type': 'application/json;charset=UTF-8',
            Referer: 'https://pan.quark.cn/',
            Origin: 'https://pan.quark.cn',
          },
          timeout: 10000,
          validateStatus: () => true,
        },
      );
      const body = resp.data;
      if (
        body &&
        typeof body === 'object' &&
        typeof body.code === 'number' &&
        body.code !== 0
      ) {
        console.warn(
          '[QuarkPanService] checkTokenValid: token expired, code=',
          body.code,
        );
        return { valid: false };
      }
      console.log('[QuarkPanService] checkTokenValid: token valid');
      return { valid: true, nickname: this.loginInfo?.nickname };
    } catch (e: any) {
      console.warn('[QuarkPanService] checkTokenValid error:', e.message);
      return { valid: false };
    }
  }

  /**
   * Clear Quark cookie from JVM SharedPreferences.
   * Without this, spider continues to read stale cookie from SharedPreferences
   * after logout and returns "已登录" state in homeContent.
   */
  private static async clearJvmCookie(): Promise<void> {
    try {
      if (!jarLoader || !jarLoader.java) {
        console.warn(
          '[QuarkPanService] JVM not ready, skipping JVM cookie clear',
        );
        return;
      }
      const InitClass = jarLoader.java.importClass(
        'com.github.catvod.spider.Init',
      );
      const ctx = InitClass.contextSync();
      if (!ctx) {
        console.warn(
          '[QuarkPanService] Init.context() returned null, skipping JVM clear',
        );
        return;
      }
      const PREFS_NAME = 'com.github.catvod.tvbox_preferences';
      const prefs = ctx.getSharedPreferencesSync(PREFS_NAME, 0);
      if (prefs) {
        const editor = prefs.editSync();
        editor.removeSync('mi.quark');
        editor.removeSync('.quark');
        editor.applySync();
        console.log(
          `[QuarkPanService] Cleared quark cookie from ${PREFS_NAME}`,
        );
      }
      // Also clear from Guard spider's SharedPreferences
      const GUARD_PREFS = 'NewWexFnw_preferences';
      const guardPrefs = ctx.getSharedPreferencesSync(GUARD_PREFS, 0);
      if (guardPrefs) {
        const guardEditor = guardPrefs.editSync();
        guardEditor.removeSync('Wex_quark_cookie');
        guardEditor.applySync();
        console.log(
          `[QuarkPanService] Cleared quark cookie from ${GUARD_PREFS}`,
        );
      }
    } catch (e: any) {
      console.warn('[QuarkPanService] clearJvmCookie error:', e.message);
    }
  }

  /**
   * Get the spider's Quark desktop client User-Agent.
   * Used by ProxyServer to set the correct UA on CDN stream requests.
   * Mirrors NewQuark.java getHeaders() — the CDN validates the UA and
   * returns 412 for non-quark-cloud-drive UAs.
   */
  static getQuarkDesktopUA(): string {
    return this.QUARK_DESKTOP_UA;
  }

  /**
   * Resolve a Quark share link to a list of playable video files.
   *
   * Uses the correct API body format (pwd_id + passcode +
   * support_visit_limit_private_share) discovered from the Quark web app's
   * share.js. The spider's built-in pan resolver uses the legacy
   * {share_id: ...} format which the API now rejects with code 41006
   * "分享不存在", causing detailContent to return without vod_play_url.
   *
   * Flow:
   * 1. POST /share/sharepage/token with {pwd_id, passcode, ...} → stoken
   * 2. GET /share/sharepage/detail?pwd_id=...&stoken=...&pdir_fid=0
   * 3. If list contains directories, recurse into each (max depth 3)
   * 4. Return flat list of video files (mp4, mkv, ts, etc.)
   */
  static async resolveShareToFiles(shareUrl: string): Promise<{
    success: boolean;
    title?: string;
    files?: Array<{
      fid: string;
      fileName: string;
      size: number;
      shareId: string;
      stoken: string;
    }>;
    error?: string;
  }> {
    const cookie = this.syncedCookie;
    if (!cookie) {
      return {
        success: false,
        error: 'Quark cookie not synced. Please login first.',
      };
    }
    const match = shareUrl.match(/\/s\/([a-zA-Z0-9]+)/);
    if (!match) {
      return { success: false, error: 'Invalid share URL: ' + shareUrl };
    }
    const shareId = match[1];
    const UA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    const commonHeaders = {
      Cookie: cookie,
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Referer: 'https://pan.quark.cn/',
      Origin: 'https://pan.quark.cn',
    };

    try {
      // Step 1: Get stoken via token API (correct body format: pwd_id).
      const tokenUrl =
        'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc';
      const tokenResp = await axios.post(
        tokenUrl,
        {
          pwd_id: shareId,
          passcode: '',
          support_visit_limit_private_share: true,
        },
        { headers: commonHeaders, timeout: 15000 },
      );
      const tokenData = tokenResp.data;
      if (tokenData?.code !== 0 || !tokenData?.data?.stoken) {
        return {
          success: false,
          error:
            'Token API failed: ' +
            (tokenData?.message || JSON.stringify(tokenData).substring(0, 200)),
        };
      }
      const stoken: string = tokenData.data.stoken;
      const title: string = tokenData.data.title || '';
      console.log(
        '[QuarkPanService] resolveShareToFiles: shareId=',
        shareId,
        'title=',
        title,
        'stoken length=',
        stoken.length,
      );

      // Step 2: Recursively list files starting from root (pdir_fid=0).
      const files: Array<{
        fid: string;
        fileName: string;
        size: number;
        shareId: string;
        stoken: string;
        shareFidToken: string;
      }> = [];
      const videoExtRegex =
        /\.(mp4|mkv|ts|avi|mov|flv|webm|m4v|mpg|mpeg|3gp|m3u8)$/i;

      const listDir = async (pdirFid: string, depth: number): Promise<void> => {
        if (depth > 3) return; // Safety cap on recursion depth.
        let page = 1;
        while (true) {
          const detailUrl =
            'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc' +
            `&pwd_id=${encodeURIComponent(shareId)}` +
            `&stoken=${encodeURIComponent(stoken)}` +
            `&pdir_fid=${encodeURIComponent(pdirFid)}` +
            `&_page=${page}&_size=50`;
          const detailResp = await axios.get(detailUrl, {
            headers: commonHeaders,
            timeout: 15000,
          });
          const dData = detailResp.data;
          if (dData?.code !== 0) {
            console.warn(
              '[QuarkPanService] detail API error at pdir=',
              pdirFid,
              'page=',
              page,
              ':',
              dData?.message,
            );
            break;
          }
          const list = dData?.data?.list || [];
          if (list.length === 0) break;
          for (const item of list) {
            // Quark API field meanings (verified from actual API responses):
            //   dir: true  → folder, recurse into it
            //   dir: false → file (regardless of file_type value)
            //   file_type: 1 → file; file_type: 0 → folder (deprecated field,
            //     not reliable — `dir` is authoritative)
            if (item.dir) {
              await listDir(item.fid, depth + 1);
            } else if (videoExtRegex.test(item.file_name || '')) {
              // Capture share_fid_token — the per-file token required by
              // /share/sharepage/save's fid_token_list field. The spider
              // (NewQuark.java line 721) reads this from the same API and
              // stores it in vod_play_url; without it, the transfer API
              // call silently fails.
              const shareFidToken: string = item.share_fid_token || '';
              if (!shareFidToken) {
                console.warn(
                  '[QuarkPanService] resolveShareToFiles: missing share_fid_token for fid=',
                  item.fid,
                  '(transfer will fail without it)',
                );
              }
              this.shareFidTokenCache.set(`${shareId}:${item.fid}`, {
                token: shareFidToken,
                shareUrl,
              });
              files.push({
                fid: item.fid,
                fileName: item.file_name,
                size: item.size || 0,
                shareId,
                stoken,
                shareFidToken,
              });
            }
          }
          // Check if there are more pages. Quark API returns pagination info
          // in data.metadata with _total / _count fields (NOT data._meta).
          const meta = dData?.data?.metadata;
          const total = meta?._total ?? list.length;
          if (page * 50 >= total) {
            break;
          }
          page++;
        }
      };

      await listDir('0', 0);
      console.log(
        '[QuarkPanService] resolveShareToFiles: found',
        files.length,
        'video files for shareId=',
        shareId,
      );
      return { success: true, title, files };
    } catch (e: any) {
      console.error(
        '[QuarkPanService] resolveShareToFiles error:',
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

  // Cache: (shareId:fid) → { playUrl, expiresAt, transferredFid }
  // The download URL returned by /file/download contains an auth_key valid
  // for ~6 hours. Within that window, replays can reuse the same URL without
  // re-resolving.
  private static playUrlCache = new Map<
    string,
    { playUrl: string; expiresAt: number; transferredFid: string }
  >();

  // Cache: TVBox folder fid (created once per session, reused for all transfers).
  private static tvboxFolderFid: string | null = null;

  // Cache: (shareId:fid) → { token, shareUrl }. Populated by resolveShareToFiles
  // when it scans the share detail API. The spider stores this per-file token
  // in vod_play_url (Base64-encoded JSON) and uses it as fid_token_list when
  // transferring the share file to the user's drive. Without it, the transfer
  // API call /share/sharepage/save silently fails or returns 32003.
  // We also store shareUrl so playerContent can refresh the token if it expires.
  private static shareFidTokenCache = new Map<
    string,
    { token: string; shareUrl: string }
  >();

  // Spider's Quark desktop client UA (NewQuark.java getHeaders()).
  // The video CDN rejects requests with other UAs (returns 412).
  private static readonly QUARK_DESKTOP_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';

  /**
   * Resolve a single Quark share file to a playable streaming URL.
   *
   * Mirrors NewQuark.java's playerContent → allloadurl flow:
   * 1. refreshCookie() — POST /clouddrive/auth/pc/flush to refresh __puus
   *    (CDN rejects stale __puus with 412).
   * 2. Try /file/download with just {fids:[fid]}. This works ONLY if the fid
   *    is already in the user's own drive (e.g., from a previous transfer).
   *    For pure share fids, /file/download returns 21001 "file not found"
   *    because the file belongs to another user.
   * 3. On 21001 (or any failure), transfer the share file to the user's own
   *    drive using shareFidToken as fid_token_list (mirrors spider's static
   *    OoOoR0o0o0oOo0 method at NewQuark.java line 264-286), then call
   *    /file/download on the transferred fid.
   * 4. On transfer failure, try the chat API flow as a last resort (this
   *    rarely works for share fids but is kept for completeness).
   *
   * The /file/v2/play endpoint is NOT used — its URLs are rejected by the
   * CDN with 412 (verified by test_quark_videolist.cjs). Only /file/download
   * produces working URLs.
   */
  static async resolveQuarkDownloadUrl(
    shareId: string,
    fid: string,
  ): Promise<string | null> {
    const cookie = this.syncedCookie;
    if (!cookie) {
      console.warn(
        '[QuarkPanService] resolveQuarkDownloadUrl: no synced cookie',
      );
      return null;
    }

    const cacheKey = `${shareId}:${fid}`;
    const cached = this.playUrlCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(
        '[QuarkPanService] resolveQuarkDownloadUrl: cache hit for',
        cacheKey,
        '(expires in',
        Math.round((cached.expiresAt - Date.now()) / 60000),
        'min)',
      );
      return cached.playUrl;
    }

    // Look up the per-file shareFidToken captured during resolveShareToFiles.
    // The spider (NewQuark.java line 721) reads this from the share detail
    // API and stores it in vod_play_url; without it, /share/sharepage/save
    // returns 32003 "missing fid_token" and the transfer silently fails.
    const cachedTokenInfo = this.shareFidTokenCache.get(cacheKey);
    let shareFidToken = cachedTokenInfo?.token || '';
    const cachedShareUrl = cachedTokenInfo?.shareUrl || '';
    if (!shareFidToken) {
      console.warn(
        '[QuarkPanService] resolveQuarkDownloadUrl: no cached shareFidToken for',
        cacheKey,
        '(transfer will likely fail; resolveShareToFiles must run first)',
      );
    } else {
      console.log(
        '[QuarkPanService] resolveQuarkDownloadUrl: using cached shareFidToken length=',
        shareFidToken.length,
        'for',
        cacheKey,
      );
    }

    const commonHeaders = {
      Cookie: cookie,
      'User-Agent': this.QUARK_DESKTOP_UA,
      'Content-Type': 'application/json;charset=UTF-8',
      Referer: 'https://pan.quark.cn/',
      Origin: 'https://pan.quark.cn',
    };

    try {
      // Step 1: Refresh __puus cookie (mirrors spider's refreshCookie()).
      // CDN validates __puus against the auth_key in the download URL; a
      // stale __puus causes 412 even with a fresh download URL.
      //
      // Use refreshCookieForPlayback (not the private refreshCookie) so we
      // detect true login expiry: if /clouddrive/auth/pc/flush returns a
      // non-zero code, the user must re-scan the QR code. Without this, the
      // private refreshCookie silently keeps the stale cookie and every
      // subsequent API call generates URLs bound to the stale __puus → 412.
      const refreshResult = await this.refreshCookieForPlayback();
      if (refreshResult.expired) {
        console.warn(
          '[QuarkPanService] resolveQuarkDownloadUrl: Quark login expired, emitting pan:loginExpired',
        );
        try {
          BrowserWindow.getAllWindows().forEach((w) =>
            w.webContents.send('pan:loginExpired', 'quark'),
          );
        } catch (e: any) {
          console.warn(
            '[QuarkPanService] Failed to emit pan:loginExpired:',
            e.message,
          );
        }
        return null;
      }
      // refreshCookieForPlayback updated this.syncedCookie in-place if a new
      // __puus was returned. Rebuild commonHeaders.Cookie so the fresh
      // __puus is used for all subsequent API calls (v2/play, download, etc.).
      commonHeaders.Cookie = this.syncedCookie || cookie;

      // Step 2: Try /file/v2/play first — this endpoint returns a streaming-
      // optimized URL that doesn't throttle. /file/download URLs often get
      // throttled by the CDN to ~500KB/s, causing constant buffering during
      // playback. /file/v2/play was previously rejected with 412 due to stale
      // __puus, but with fresh cookies it should work now.
      let downloadUrl = await this.tryFileV2Play(commonHeaders, fid);
      if (downloadUrl) {
        this.cachePlayUrl(cacheKey, downloadUrl, '');
        return downloadUrl;
      }

      // Step 3: Fallback to /file/download with just {fids:[fid]}.
      // Works only if the fid is already in the user's drive (e.g., from a
      // previous transfer that hasn't been cleaned up yet). For pure share
      // fids this returns 21001 "file not found" and we fall through to
      // the transfer path.
      downloadUrl = await this.tryFileDownload(commonHeaders, fid);
      if (downloadUrl) {
        this.cachePlayUrl(cacheKey, downloadUrl, '');
        return downloadUrl;
      }

      // Step 4: Transfer-then-play (PRIMARY path for share fids).
      // Share fids cannot be downloaded directly — they belong to another
      // user. The spider's allloadurl transfers the file to the user's own
      // drive first (using shareFidToken as fid_token_list), then calls
      // /file/download on the new fid. This is the path that actually works
      // for share fids.
      console.log(
        '[QuarkPanService] resolveQuarkDownloadUrl: direct download failed, transferring share file for fid=',
        fid,
      );
      downloadUrl = await this.getDownloadUrlViaTransfer(
        commonHeaders,
        shareId,
        fid,
        shareFidToken,
        cachedShareUrl,
      );
      if (downloadUrl) {
        return downloadUrl;
      }

      // Step 4: Chat API flow (last resort — usually fails for share fids
      // with 21001, but kept for the rare case where the fid happens to be
      // accessible via chat).
      console.log(
        '[QuarkPanService] resolveQuarkDownloadUrl: transfer failed, trying chat API flow for fid=',
        fid,
      );
      downloadUrl = await this.getDownloadUrlViaChatApi(commonHeaders, fid);
      if (downloadUrl) {
        this.cachePlayUrl(cacheKey, downloadUrl, '');
        return downloadUrl;
      }

      console.warn(
        '[QuarkPanService] resolveQuarkDownloadUrl: all paths failed for fid=',
        fid,
      );
      return null;
    } catch (e: any) {
      console.error(
        '[QuarkPanService] resolveQuarkDownloadUrl error:',
        e.message,
        e.response?.status,
        e.response?.data,
      );
      return null;
    }
  }

  /**
   * Public wrapper around refreshCookie for pre-playback refresh.
   *
   * Called by JarLoader before spider's playerContent to ensure __puus is
   * fresh, so the spider-generated download URL's auth_key matches the cookie
   * the ProxyServer will send. Without this, the spider uses a stale JVM
   * cookie → stale auth_key → CDN 412.
   *
   * Also detects true login expiry: if /clouddrive/auth/pc/flush returns a
   * non-zero code (auth failure), the user must re-scan the QR code.
   *
   * Returns:
   *   - refreshed: true if __puus was updated
   *   - expired: true if login has expired (needs re-login)
   *   - cookie: current synced cookie (null if not logged in)
   */
  public static async refreshCookieForPlayback(): Promise<{
    refreshed: boolean;
    expired: boolean;
    cookie: string | null;
  }> {
    const cookie = this.syncedCookie;
    if (!cookie) {
      return { refreshed: false, expired: false, cookie: null };
    }
    const commonHeaders = {
      Cookie: cookie,
      'User-Agent': this.QUARK_DESKTOP_UA,
      'Content-Type': 'application/json;charset=UTF-8',
      Referer: 'https://pan.quark.cn/',
      Origin: 'https://pan.quark.cn',
    };
    try {
      const resp = await axios.post(
        'https://drive-pc.quark.cn/1/clouddrive/auth/pc/flush?pr=ucpro&fr=pc&uc_param_str=',
        null,
        { headers: commonHeaders, timeout: 10000, validateStatus: () => true },
      );
      // Detect true login expiry: Quark API returns code != 0 when the cookie
      // is no longer valid (e.g., 31001 "account not logged in"). A successful
      // flush returns code 0 even if no new __puus is set.
      const body = resp.data;
      if (body && typeof body === 'object' && typeof body.code === 'number') {
        if (body.code !== 0) {
          console.warn(
            '[QuarkPanService] refreshCookieForPlayback: login expired, code=',
            body.code,
            'message=',
            body.message,
          );
          return { refreshed: false, expired: true, cookie: null };
        }
      }
      const setCookie = resp.headers?.['set-cookie'];
      if (!setCookie) {
        return { refreshed: false, expired: false, cookie };
      }
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      const puusEntry = cookies.find((c: string) => c.startsWith('__puus='));
      if (!puusEntry) {
        return { refreshed: false, expired: false, cookie };
      }
      const newPuus = puusEntry.split(';')[0];
      const parts = cookie
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('__puus='));
      parts.push(newPuus);
      this.syncedCookie = parts.join('; ');
      console.log(
        '[QuarkPanService] refreshCookieForPlayback: updated __puus, cookie len=',
        this.syncedCookie.length,
      );
      return { refreshed: true, expired: false, cookie: this.syncedCookie };
    } catch (e: any) {
      console.warn(
        '[QuarkPanService] refreshCookieForPlayback failed (continuing with existing cookie):',
        e.message,
      );
      return { refreshed: false, expired: false, cookie };
    }
  }

  /**
   * Refresh the __puus cookie by calling /clouddrive/auth/pc/flush.
   *
   * Mirrors NewQuark.java refreshCookie(). The spider calls this before
   * every playerContent() to ensure __puus is fresh. The CDN validates
   * __puus against the auth_key in download URLs — a stale __puus causes
   * 412 Precondition Failed.
   *
   * Updates this.syncedCookie in-place if a new __puus is returned.
   */
  private static async refreshCookie(
    commonHeaders: Record<string, string>,
  ): Promise<void> {
    try {
      const resp = await axios.post(
        'https://drive-pc.quark.cn/1/clouddrive/auth/pc/flush?pr=ucpro&fr=pc&uc_param_str=',
        null,
        { headers: commonHeaders, timeout: 10000, validateStatus: () => true },
      );
      const setCookie = resp.headers?.['set-cookie'];
      if (!setCookie) {
        console.log(
          '[QuarkPanService] refreshCookie: no set-cookie header, keeping existing cookie',
        );
        return;
      }
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      const puusEntry = cookies.find((c: string) => c.startsWith('__puus='));
      if (!puusEntry) {
        console.log(
          '[QuarkPanService] refreshCookie: no __puus in set-cookie, keeping existing cookie',
        );
        return;
      }
      const newPuus = puusEntry.split(';')[0]; // "__puus=..."
      // Merge the new __puus into the existing cookie string, replacing any
      // previous __puus value.
      const existingCookie = this.syncedCookie || '';
      const parts = existingCookie
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('__puus='));
      parts.push(newPuus);
      this.syncedCookie = parts.join('; ');
      console.log(
        '[QuarkPanService] refreshCookie: updated __puus, cookie len=',
        this.syncedCookie.length,
      );
      // Update commonHeaders in-place so callers use the fresh cookie.
      commonHeaders.Cookie = this.syncedCookie;
    } catch (e: any) {
      console.warn(
        '[QuarkPanService] refreshCookie failed (continuing with existing cookie):',
        e.message,
      );
    }
  }

  /**
   * Try /file/v2/play — returns a streaming-optimized URL that the CDN
   * doesn't throttle. /file/download URLs are often rate-limited to
   * ~500KB/s on free accounts, causing constant buffering during playback.
   *
   * Previously this endpoint returned URLs rejected by the CDN with 412,
   * but that was due to stale __puus cookies. With fresh cookies (after
   * refreshCookie), this endpoint should work and provide better streaming.
   *
   * Returns the video_url on success, or null on any failure.
   */
  private static async tryFileV2Play(
    commonHeaders: Record<string, string>,
    fid: string,
  ): Promise<string | null> {
    try {
      // Note: Quark's /file/v2/play expects { fid } (singular), not { fids: [fid] }
      // like /file/download. This differs from UC's API which uses the same format.
      const resp = await axios.post(
        'https://drive-pc.quark.cn/1/clouddrive/file/v2/play?pr=ucpro&fr=pc',
        { fid },
        { headers: commonHeaders, timeout: 15000, validateStatus: () => true },
      );
      const d = resp.data;
      if (d?.code === 0 && d?.data?.video_url) {
        const url: string = d.data.video_url;
        console.log(
          '[QuarkPanService] tryFileV2Play: OK, video_url length=',
          url.length,
          'for fid=',
          fid,
        );
        return url;
      }
      if (d?.code === 0 && d?.data?.download_url) {
        const url: string = d.data.download_url;
        console.log(
          '[QuarkPanService] tryFileV2Play: OK (download_url fallback), length=',
          url.length,
          'for fid=',
          fid,
        );
        return url;
      }
      // Some responses have video_list array (like UC API)
      if (d?.code === 0 && d?.data?.video_list?.[0]?.video_info?.url) {
        const url: string = d.data.video_list[0].video_info.url;
        console.log(
          '[QuarkPanService] tryFileV2Play: OK (video_list[0]), length=',
          url.length,
          'for fid=',
          fid,
        );
        return url;
      }
      console.warn(
        '[QuarkPanService] tryFileV2Play: failed for fid=',
        fid,
        'code=',
        d?.code,
        'message=',
        d?.message,
      );
      return null;
    } catch (e: any) {
      console.warn('[QuarkPanService] tryFileV2Play error:', e.message);
      return null;
    }
  }

  /**
   * Try /file/download with just {fids:[fid]}.
   *
   * Mirrors NewQuark.java's NORMAL/VIP member path. The spider calls
   * /file/download with ONLY {fids:[fid]} — no pwd_id, no stoken. Including
   * those extra fields causes the API to treat it as a "share download"
   * which hits the 23018 size limit.
   *
   * Returns the download_url on success, or null on any failure.
   */
  private static async tryFileDownload(
    commonHeaders: Record<string, string>,
    fid: string,
  ): Promise<string | null> {
    try {
      const resp = await axios.post(
        'https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc',
        { fids: [fid] },
        { headers: commonHeaders, timeout: 15000, validateStatus: () => true },
      );
      const d = resp.data;
      if (d?.code === 0 && d?.data?.[0]?.download_url) {
        const url: string = d.data[0].download_url;
        console.log(
          '[QuarkPanService] tryFileDownload: OK, url length=',
          url.length,
          'for fid=',
          fid,
        );
        return url;
      }
      console.warn(
        '[QuarkPanService] tryFileDownload: failed for fid=',
        fid,
        'code=',
        d?.code,
        'message=',
        d?.message,
      );
      return null;
    } catch (e: any) {
      console.warn('[QuarkPanService] tryFileDownload error:', e.message);
      return null;
    }
  }

  /**
   * Get a download URL via the chat API flow.
   *
   * Mirrors NewQuark.java's non-VIP/NORMAL fallback (lines 132-225):
   * 1. List conversations → get first conversation_id
   * 2. Send a message with the file to that conversation
   *    (POST /clouddrive/chat/conv/msg/batch_send)
   * 3. Get the store_msg_id from /clouddrive/chat/conv/info
   * 4. Acquire a download token (POST /clouddrive/chat/conv/file/acquire_dl_token)
   * 5. Call /file/download with {fids:[fid], speedup_session:"", token:<dl_token>}
   *
   * This flow allows downloading share files without transferring them,
   * by sending the file to a chat (even to yourself) which grants download
   * access via the dl_token.
   */
  private static async getDownloadUrlViaChatApi(
    commonHeaders: Record<string, string>,
    fid: string,
  ): Promise<string | null> {
    try {
      // Step 1: Get conversation_id from conv/list.
      const convListResp = await axios.post(
        'https://drive-social-api.quark.cn/1/clouddrive/chat/conv/list?pr=ucpro&fr=pc&sys=win32&ve=3.19.0',
        {
          order_field: 'msg_pos',
          order: 'desc',
          size: 9999,
          fetch_own_conversation: 1,
          fetch_user_count: 1,
        },
        { headers: commonHeaders, timeout: 15000, validateStatus: () => true },
      );
      const convListData = convListResp.data;
      if (
        convListData?.code !== 0 ||
        !convListData?.data?.conversations?.length
      ) {
        console.warn(
          '[QuarkPanService] getDownloadUrlViaChatApi: no conversations found, code=',
          convListData?.code,
          'message=',
          convListData?.message,
        );
        return null;
      }
      const conversationId: string =
        convListData.data.conversations[0].conversation_id;
      console.log(
        '[QuarkPanService] getDownloadUrlViaChatApi: got conversation_id=',
        conversationId,
      );

      // Step 2: Send message with the file to the conversation.
      const groupId = this.uuid();
      const localMsgId = this.uuid();
      const sendResp = await axios.post(
        'https://drive-social-api.quark.cn/1/clouddrive/chat/conv/msg/batch_send?pr=ucpro&fr=pc&sys=win32&ve=3.19.0',
        {
          conversations: [
            {
              merge_file: 0,
              conversation_id: conversationId,
              conversation_type: 3,
              file_list: [
                {
                  fid,
                  content: 'Wex.mp4',
                  client_extra: {
                    group_id: groupId,
                    device_model: 'Wex Administrator',
                    local_msg_id: localMsgId,
                  },
                },
              ],
            },
          ],
          return_msg_as_list: 1,
        },
        { headers: commonHeaders, timeout: 15000, validateStatus: () => true },
      );
      if (sendResp.data?.status !== 200 && sendResp.data?.code !== 0) {
        console.warn(
          '[QuarkPanService] getDownloadUrlViaChatApi: batch_send failed, status=',
          sendResp.data?.status,
          'code=',
          sendResp.data?.code,
          'message=',
          sendResp.data?.message,
        );
        return null;
      }

      // Step 3: Get store_msg_id from conv/info.
      const infoResp = await axios.get(
        `https://drive-social-api.quark.cn/1/clouddrive/chat/conv/info?pr=ucpro&fr=pc&sys=win32&conversation_id=${encodeURIComponent(conversationId)}&fetch_role_cnt=25&fetch_user_cnt=1&ve=3.19.0`,
        { headers: commonHeaders, timeout: 15000, validateStatus: () => true },
      );
      const infoData = infoResp.data;
      if (infoData?.code !== 0 || !infoData?.data?.conversation?.new_msg) {
        console.warn(
          '[QuarkPanService] getDownloadUrlViaChatApi: conv/info failed, code=',
          infoData?.code,
          'message=',
          infoData?.message,
        );
        return null;
      }
      const storeMsgId: string =
        infoData.data.conversation.new_msg.store_msg_id;
      if (!storeMsgId) {
        console.warn(
          '[QuarkPanService] getDownloadUrlViaChatApi: no store_msg_id in conv/info response',
        );
        return null;
      }
      console.log(
        '[QuarkPanService] getDownloadUrlViaChatApi: got store_msg_id=',
        storeMsgId,
      );

      // Step 4: Acquire download token.
      const tokenResp = await axios.post(
        'https://drive-social-api.quark.cn/1/clouddrive/chat/conv/file/acquire_dl_token?pr=ucpro&fr=pc&sys=win32&ve=3.19.0',
        {
          conversation_id: conversationId,
          conversation_type: 3,
          msg_id: storeMsgId,
          file_list: [{ fid }],
        },
        { headers: commonHeaders, timeout: 15000, validateStatus: () => true },
      );
      const tokenData = tokenResp.data;
      if (tokenData?.code !== 0 || !tokenData?.data?.token) {
        console.warn(
          '[QuarkPanService] getDownloadUrlViaChatApi: acquire_dl_token failed, code=',
          tokenData?.code,
          'message=',
          tokenData?.message,
        );
        return null;
      }
      const dlToken: string = tokenData.data.token;
      console.log(
        '[QuarkPanService] getDownloadUrlViaChatApi: got dl_token, length=',
        dlToken.length,
      );

      // Step 5: Call /file/download with the dl_token.
      const dlResp = await axios.post(
        'https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&sys=win32&ve=3.19.0',
        { fids: [fid], speedup_session: '', token: dlToken },
        { headers: commonHeaders, timeout: 15000, validateStatus: () => true },
      );
      const dlData = dlResp.data;
      if (dlData?.code === 0 && dlData?.data?.[0]?.download_url) {
        const url: string = dlData.data[0].download_url;
        console.log(
          '[QuarkPanService] getDownloadUrlViaChatApi: OK, url length=',
          url.length,
        );
        return url;
      }
      console.warn(
        '[QuarkPanService] getDownloadUrlViaChatApi: /file/download with token failed, code=',
        dlData?.code,
        'message=',
        dlData?.message,
      );
      return null;
    } catch (e: any) {
      console.warn(
        '[QuarkPanService] getDownloadUrlViaChatApi error:',
        e.message,
      );
      return null;
    }
  }

  /**
   * Transfer-then-play: transfer share file to user's own drive, then call
   * /file/download on the transferred fid.
   *
   * This is the PRIMARY path for share fids — they cannot be downloaded
   * directly (returns 21001 "file not found") because they belong to another
   * user. The spider's allloadurl does this internally before calling
   * /file/download.
   *
   * Mirrors NewQuark.java's static OoOoR0o0o0oOo0 method (line 264-286):
   *   POST /share/sharepage/save
   *   body: { pdir_fid: "0", to_pdir_fid: <tvboxFid>, pwd_id: shareId,
   *           stoken: <stoken>, fid_list: [fid], fid_token_list: [shareFidToken] }
   *
   * The previous implementation used `fid_token: stoken` (singular, with the
   * share stoken as value) and `todir_fid` — both wrong. The spider uses
   * `fid_token_list: [shareFidToken]` (array, with the per-file token) and
   * `to_pdir_fid`. Without the correct shareFidToken, the transfer silently
   * fails or returns 32003.
   */
  private static async getDownloadUrlViaTransfer(
    commonHeaders: Record<string, string>,
    shareId: string,
    fid: string,
    shareFidToken: string,
    shareUrl: string,
  ): Promise<string | null> {
    if (!shareFidToken) {
      console.warn(
        '[QuarkPanService] getDownloadUrlViaTransfer: no shareFidToken provided for',
        shareId,
        ':',
        fid,
        '— transfer will fail (resolveShareToFiles must capture it first)',
      );
      return null;
    }

    // Get stoken for this share (needed for transfer).
    let stoken = '';
    try {
      const tokenResp = await axios.post(
        'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc',
        {
          pwd_id: shareId,
          passcode: '',
          support_visit_limit_private_share: true,
        },
        { headers: commonHeaders, timeout: 15000, validateStatus: () => true },
      );
      if (tokenResp.data?.code === 0 && tokenResp.data?.data?.stoken) {
        stoken = tokenResp.data.data.stoken;
      }
    } catch (e: any) {
      console.warn(
        '[QuarkPanService] getDownloadUrlViaTransfer: token API failed:',
        e.message,
      );
    }

    const tvboxFid = await this.findOrCreateTvboxFolder(commonHeaders);
    if (!tvboxFid) return null;

    void this.cleanupOldTransfers(commonHeaders, tvboxFid);

    const { taskId, errorCode } = await this.transferShareFile(
      commonHeaders,
      shareId,
      fid,
      shareFidToken,
      stoken,
      tvboxFid,
    );

    // If shareFidToken expired (code 41020), refresh it and retry transfer once.
    if (!taskId && errorCode === 41020 && shareUrl) {
      console.log(
        '[QuarkPanService] getDownloadUrlViaTransfer: shareFidToken expired (41020), refreshing via resolveShareToFiles for shareUrl=',
        shareUrl.substring(0, 50),
      );
      const refreshed = await this.resolveShareToFiles(shareUrl);
      if (refreshed.success && refreshed.files) {
        const refreshedFile = refreshed.files.find((f) => f.fid === fid);
        if (refreshedFile?.shareFidToken) {
          shareFidToken = refreshedFile.shareFidToken;
          stoken = refreshedFile.stoken || stoken;
          console.log(
            '[QuarkPanService] getDownloadUrlViaTransfer: refreshed shareFidToken length=',
            shareFidToken.length,
            'retrying transfer...',
          );
          const retryResult = await this.transferShareFile(
            commonHeaders,
            shareId,
            fid,
            shareFidToken,
            stoken,
            tvboxFid,
          );
          if (retryResult.taskId) {
            const newFid = await this.pollTransferTask(
              commonHeaders,
              retryResult.taskId,
            );
            if (newFid) {
              console.log(
                '[QuarkPanService] getDownloadUrlViaTransfer: transferred after token refresh, fid=',
                newFid,
              );
              // Try /file/v2/play first for streaming-optimized URL
              let downloadUrl = await this.tryFileV2Play(commonHeaders, newFid);
              if (!downloadUrl) {
                downloadUrl = await this.tryFileDownload(commonHeaders, newFid);
              }
              if (downloadUrl) {
                const cacheKey = `${shareId}:${fid}`;
                this.playUrlCache.set(cacheKey, {
                  playUrl: downloadUrl,
                  expiresAt: Date.now() + 5 * 3600 * 1000,
                  transferredFid: newFid,
                });
                return downloadUrl;
              }
            }
          }
        }
      }
      console.warn(
        '[QuarkPanService] getDownloadUrlViaTransfer: token refresh or retry transfer failed',
      );
      return null;
    }

    if (!taskId) return null;

    const newFid = await this.pollTransferTask(commonHeaders, taskId);
    if (!newFid) return null;
    console.log(
      '[QuarkPanService] getDownloadUrlViaTransfer: transferred to fid=',
      newFid,
    );

    // Try /file/v2/play first for streaming-optimized URL, fallback to /file/download.
    let downloadUrl = await this.tryFileV2Play(commonHeaders, newFid);
    if (!downloadUrl) {
      downloadUrl = await this.tryFileDownload(commonHeaders, newFid);
    }
    if (!downloadUrl) {
      console.warn(
        '[QuarkPanService] getDownloadUrlViaTransfer: both /file/v2/play and /file/download failed on transferred fid',
      );
      return null;
    }

    const cacheKey = `${shareId}:${fid}`;
    this.playUrlCache.set(cacheKey, {
      playUrl: downloadUrl,
      expiresAt: Date.now() + 5 * 3600 * 1000,
      transferredFid: newFid,
    });
    const transferredFid = newFid;
    setTimeout(
      () => {
        console.log(
          '[QuarkPanService] getDownloadUrlViaTransfer: scheduled cleanup of fid=',
          transferredFid,
        );
        void this.deleteFile(commonHeaders, transferredFid);
        this.playUrlCache.delete(cacheKey);
      },
      6 * 3600 * 1000,
    );
    return downloadUrl;
  }

  /**
   * Cache a download URL with a 5-hour TTL (auth_key TTL is ~6h).
   */
  private static cachePlayUrl(
    cacheKey: string,
    playUrl: string,
    transferredFid: string,
  ): void {
    this.playUrlCache.set(cacheKey, {
      playUrl,
      expiresAt: Date.now() + 5 * 3600 * 1000,
      transferredFid,
    });
  }

  /**
   * Generate a UUID v4 string (matches Java's UUID.randomUUID().toString()).
   */
  private static uuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Find or create the "TVBox" folder in user's Quark drive.
   *
   * Transferred share files are staged here so they don't pollute the user's
   * root folder. The fid is cached in memory for the session.
   */
  private static async findOrCreateTvboxFolder(
    commonHeaders: Record<string, string>,
  ): Promise<string | null> {
    if (this.tvboxFolderFid) {
      return this.tvboxFolderFid;
    }
    try {
      // List root folder to find existing TVBox folder.
      const listResp = await axios.get(
        'https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=0&_page=1&_size=200&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,updated_at:desc',
        { headers: commonHeaders, timeout: 15000, validateStatus: () => true },
      );
      const list = listResp.data?.data?.list || [];
      for (const item of list) {
        if (item.dir && item.file_name === 'TVBox') {
          this.tvboxFolderFid = item.fid;
          console.log(
            '[QuarkPanService] findOrCreateTvboxFolder: found existing, fid=',
            this.tvboxFolderFid,
          );
          return this.tvboxFolderFid;
        }
      }
      // Create TVBox folder.
      const createResp = await axios.post(
        'https://drive-pc.quark.cn/1/clouddrive/file?pr=ucpro&fr=pc',
        { pdir_fid: '0', file_name: 'TVBox', dir_path: '', dir: true },
        { headers: commonHeaders, timeout: 15000, validateStatus: () => true },
      );
      if (createResp.data?.code === 0 && createResp.data?.data?.fid) {
        this.tvboxFolderFid = createResp.data.data.fid;
        console.log(
          '[QuarkPanService] findOrCreateTvboxFolder: created, fid=',
          this.tvboxFolderFid,
        );
        return this.tvboxFolderFid;
      }
      console.warn(
        '[QuarkPanService] findOrCreateTvboxFolder: create failed:',
        createResp.data?.message,
      );
      return null;
    } catch (e: any) {
      console.error(
        '[QuarkPanService] findOrCreateTvboxFolder error:',
        e.message,
      );
      return null;
    }
  }

  /**
   * Transfer (save) a share file to the user's TVBox folder.
   *
   * Mirrors NewQuark.java's OoOoR0o0o0oOo0 (line 264-286). The spider sends:
   *   {
   *     pdir_fid: "0",
   *     to_pdir_fid: <tvboxFid>,
   *     pwd_id: <shareId>,
   *     stoken: <stoken>,
   *     fid_list: [<sourceFid>],
   *     fid_token_list: [<shareFidToken>]
   *   }
   *
   * The previous implementation used `fid_token: stoken` (singular) and
   * `todir_fid` — both wrong field names. The correct fields are
   * `fid_token_list` (array of per-file tokens, NOT the share stoken) and
   * `to_pdir_fid`. Returns the task_id (transfer is async, must be polled).
   */
  private static async transferShareFile(
    commonHeaders: Record<string, string>,
    shareId: string,
    sourceFid: string,
    shareFidToken: string,
    stoken: string,
    toPdirFid: string,
  ): Promise<{ taskId: string | null; errorCode: number | null }> {
    try {
      const resp = await axios.post(
        'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc',
        {
          pdir_fid: '0',
          to_pdir_fid: toPdirFid,
          pwd_id: shareId,
          stoken,
          fid_list: [sourceFid],
          fid_token_list: [shareFidToken],
        },
        { headers: commonHeaders, timeout: 15000, validateStatus: () => true },
      );
      if (resp.data?.code === 0 && resp.data?.data?.task_id) {
        console.log(
          '[QuarkPanService] transferShareFile: task_id=',
          resp.data.data.task_id,
        );
        return { taskId: resp.data.data.task_id, errorCode: null };
      }
      console.warn(
        '[QuarkPanService] transferShareFile: failed:',
        resp.data?.message,
        '(code:',
        resp.data?.code,
        ')',
      );
      return { taskId: null, errorCode: resp.data?.code || null };
    } catch (e: any) {
      console.error('[QuarkPanService] transferShareFile error:', e.message);
      return { taskId: null, errorCode: null };
    }
  }

  /**
   * Poll the transfer task until it completes (status === 2).
   *
   * Returns the new file's fid (from save_as.save_as_top_fids[0]) on success,
   * or null on timeout/failure. Quark transfers typically complete in 1-3
   * seconds for share files (just metadata copy, no actual upload).
   */
  private static async pollTransferTask(
    commonHeaders: Record<string, string>,
    taskId: string,
  ): Promise<string | null> {
    for (let i = 0; i < 30; i++) {
      try {
        const resp = await axios.get(
          `https://drive-pc.quark.cn/1/clouddrive/task?pr=ucpro&fr=pc&task_id=${taskId}`,
          {
            headers: commonHeaders,
            timeout: 10000,
            validateStatus: () => true,
          },
        );
        const data = resp.data?.data;
        const status = data?.status;
        const topFids = data?.save_as?.save_as_top_fids;
        if (status === 2 && Array.isArray(topFids) && topFids.length > 0) {
          console.log(
            '[QuarkPanService] pollTransferTask: completed after',
            i,
            'polls, new fid=',
            topFids[0],
          );
          return topFids[0];
        }
        // status 4 = failed, 3 = cancelled
        if (status === 4 || status === 3) {
          console.warn(
            '[QuarkPanService] pollTransferTask: task failed/cancelled, status=',
            status,
          );
          return null;
        }
        await new Promise((r) => setTimeout(r, 500));
      } catch (e: any) {
        console.warn(
          '[QuarkPanService] pollTransferTask: poll error:',
          e.message,
        );
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    console.warn(
      '[QuarkPanService] pollTransferTask: timed out after 30 polls',
    );
    return null;
  }

  /**
   * Delete a file from user's Quark drive.
   *
   * Used to clean up transferred share files after their play URL expires
   * (so the user's drive doesn't fill up with old staged transfers).
   */
  private static async deleteFile(
    commonHeaders: Record<string, string>,
    fid: string,
  ): Promise<void> {
    try {
      await axios.post(
        'https://drive-pc.quark.cn/1/clouddrive/file/delete?pr=ucpro&fr=pc',
        { action_type: 2, task_list: [{ fid, delete: true }] },
        { headers: commonHeaders, timeout: 15000, validateStatus: () => true },
      );
      console.log('[QuarkPanService] deleteFile: deleted fid=', fid);
    } catch (e: any) {
      console.warn('[QuarkPanService] deleteFile error:', e.message);
    }
  }

  /**
   * Lazy cleanup of old transferred files in the TVBox folder.
   *
   * Lists files in the TVBox folder and deletes any older than 6 hours
   * (matching the play URL auth_key expiration window). Called before each
   * new transfer to keep the staging folder from filling up the user's drive.
   */
  private static async cleanupOldTransfers(
    commonHeaders: Record<string, string>,
    tvboxFid: string,
  ): Promise<void> {
    try {
      const resp = await axios.get(
        `https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=${encodeURIComponent(tvboxFid)}&_page=1&_size=50&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,updated_at:desc`,
        { headers: commonHeaders, timeout: 15000, validateStatus: () => true },
      );
      const list = resp.data?.data?.list || [];
      const now = Date.now();
      const sixHoursMs = 6 * 3600 * 1000;
      for (const item of list) {
        if (item.dir) continue;
        const updatedAt = item.l_updated_at || item.updated_at || 0;
        if (updatedAt && now - updatedAt > sixHoursMs) {
          await this.deleteFile(commonHeaders, item.fid);
        }
      }
    } catch (e: any) {
      console.warn('[QuarkPanService] cleanupOldTransfers error:', e.message);
    }
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
            'User-Agent': this.QUARK_DESKTOP_UA,
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
      // Persist the raw set-cookie array for debugging — Quark sometimes
      // splits __puus across multiple Set-Cookie entries, and axios may
      // merge them with commas, breaking the naive startsWith() check.
      try {
        const dbgPath = path.join(
          process.env.APPDATA
            ? path.join(process.env.APPDATA, 'tvbox-pc')
            : __dirname,
          'quark-setcookie-debug.log',
        );
        const dir = path.dirname(dbgPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(
          dbgPath,
          `[${new Date().toISOString()}] setCookie count=${cookies.length}\n`,
        );
        for (let i = 0; i < cookies.length; i++) {
          fs.appendFileSync(
            dbgPath,
            `  [${i}] len=${cookies[i].length} ${cookies[i].substring(0, 400)}\n`,
          );
        }
      } catch {}

      const puusEntry = cookies.find((c: string) => c.startsWith('__puus='));
      if (!puusEntry) {
        console.warn(
          '[QuarkPanService] __puus not in set-cookie, using base cookie only',
        );
        return baseCookie;
      }
      const puus = puusEntry.split(';')[0];
      console.log(
        '[QuarkPanService] Fetched __puus cookie, len=',
        puus.length,
        'valueLen=',
        puus.length - 7,
      );
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
    // Persist to temp file for diagnostic scripts
    try {
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');
      const cookiePath = path.join(os.tmpdir(), 'quark_cookie_debug.txt');
      fs.writeFileSync(cookiePath, cookie || '', 'utf-8');
      console.log('[QuarkPanService] Cookie persisted to:', cookiePath);
    } catch (e) {
      // ignore
    }
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

      // Guard spider (NewJuTou/NewErXiao/etc.) reads quark cookie from a
      // DIFFERENT SharedPreferences: NewWexFnw_preferences, key Wex_quark_cookie.
      // Without this, PlayUrlBuilder's AsyncTask cannot resolve pan links and
      // detailContent returns placeholder text ("没有资源") instead of play URLs.
      const GUARD_PREFS = 'NewWexFnw_preferences';
      try {
        const guardPrefs = ctx.getSharedPreferencesSync(GUARD_PREFS, 0);
        const guardEditor = guardPrefs.editSync();
        guardEditor.putStringSync('Wex_quark_cookie', cookie);
        guardEditor.applySync();
        console.log(
          `[QuarkPanService] Synced cookie to ${GUARD_PREFS} (Wex_quark_cookie)`,
        );
      } catch (guardErr: any) {
        console.warn(
          `[QuarkPanService] Failed to sync to ${GUARD_PREFS}:`,
          guardErr.message,
        );
      }
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
