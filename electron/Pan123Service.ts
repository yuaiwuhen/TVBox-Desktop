import axios from 'axios';
import { ipcMain } from 'electron';

/**
 * Pan123Service - 123网盘 share resolver.
 *
 * 123 pan is unusual among Chinese cloud drives: share resolution and
 * download URL generation work WITHOUT login. The API is based on the
 * Android spider NewPan123.java decompiled flow:
 *
 *   1. Parse share URL to extract shareKey + optional password.
 *   2. GET /b/api/share/get to list files in the share (recursive).
 *   3. POST /b/api/share/download/info with file metadata to get a
 *      direct download URL.
 *
 * The download URL returned is a direct CDN link (no Cookie/Referer
 * needed), so the player can stream it directly without going through
 * ProxyServer.
 */
export class Pan123Service {
  private static syncedCookie: string | null = null;
  // Cache: (shareKey:fileId) → { downloadUrl, expiresAt }
  private static downloadUrlCache = new Map<
    string,
    { downloadUrl: string; expiresAt: number }
  >();

  static init(): void {
    ipcMain.handle('pan123:setCookie', async (_event, cookie: string) => {
      this.syncedCookie = cookie;
      return { success: true };
    });
    ipcMain.handle('pan123:getCookie', async () => {
      return { cookie: this.syncedCookie };
    });
    console.log('[Pan123Service] Initialized');
  }

  static setSyncedCookie(cookie: string | null): void {
    this.syncedCookie = cookie;
  }
  static getSyncedCookie(): string | null {
    return this.syncedCookie;
  }

  private static buildHeaders(): Record<string, string> {
    return {
      'App-Version': '43',
      'Content-Type': 'application/json',
      Referer: 'https://www.123684.com/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36',
      Cookie: this.syncedCookie || '',
    };
  }

  /**
   * Parse a 123 pan share URL to extract shareKey and password.
   * URL formats:
   *   https://www.123684.com/s/<shareKey>
   *   https://www.123pan.com/s/<shareKey>?pwd=<password>
   *   https://123865.com/s/<shareKey>提取码:<password>
   */
  private static parseShareUrl(
    shareUrl: string,
  ): { shareKey: string; sharePwd: string } | null {
    try {
      let decoded = shareUrl;
      try {
        decoded = decodeURIComponent(shareUrl);
      } catch {
        // ignore
      }
      // Normalize "提取码:" to "?pwd="
      if (decoded.includes('提取码') && !decoded.includes('?')) {
        decoded = decoded.replace(/提取码[:：]/, '?pwd=');
      }
      if (decoded.includes('?pwd=')) {
        decoded = decoded.replace(/\?pwd=/, '?提取码:');
      }
      // Extract password
      let sharePwd = '';
      if (decoded.includes('?')) {
        const afterQ = decoded.split('?')[1].replaceAll(/[^A-Za-z0-9]/g, '');
        sharePwd = afterQ;
      }
      // Extract shareKey via regex (matches all 123 pan domains)
      const match = decoded.match(
        /https?:\/\/(?:www\.)?(?:123684|123865|123912|123592|123pan)\.(?:com|cn)\/s\/([^\/?]+)/,
      );
      if (!match) {
        console.warn('[Pan123Service] parseShareUrl: no match for', shareUrl);
        return null;
      }
      let shareKey = match[1];
      if (shareKey.includes('.html')) {
        shareKey = shareKey.replace('.html', '');
      }
      return { shareKey, sharePwd };
    } catch (e: any) {
      console.warn('[Pan123Service] parseShareUrl error:', e.message);
      return null;
    }
  }

  /**
   * Resolve a 123 pan share link to a list of playable video files.
   * Recursively lists all folders in the share.
   */
  static async resolveShareToFiles(shareUrl: string): Promise<{
    success: boolean;
    title?: string;
    files?: Array<{
      fileId: string;
      fileName: string;
      size: number;
      s3KeyFlag: string;
      etag: string;
      shareKey: string;
      category: string;
    }>;
    error?: string;
  }> {
    const parsed = this.parseShareUrl(shareUrl);
    if (!parsed) {
      return {
        success: false,
        error: 'Invalid 123 pan share URL: ' + shareUrl,
      };
    }
    const { shareKey, sharePwd } = parsed;
    console.log(
      '[Pan123Service] resolveShareToFiles: shareKey=',
      shareKey,
      'sharePwd=',
      sharePwd ? '***' : '(empty)',
    );

    try {
      const files: Array<{
        fileId: string;
        fileName: string;
        size: number;
        s3KeyFlag: string;
        etag: string;
        shareKey: string;
        category: string;
      }> = [];
      // BFS through folders. Queue items: { parentId, next, parentName }
      // parentName tracks the folder name for episode naming (【category】).
      const queue: Array<{
        parentId: string;
        next: number;
        parentName: string;
      }> = [{ parentId: '0', next: 0, parentName: '' }];
      const videoExtRegex =
        /\.(mp4|mkv|ts|avi|mov|flv|webm|m4v|mpg|mpeg|3gp|m3u8|rmvb)$/i;
      const maxPagesPerFolder = 50;
      let totalApiCalls = 0;

      while (queue.length > 0) {
        const { parentId, next, parentName } = queue.shift()!;
        let pageNext = next;
        for (let page = 0; page < maxPagesPerFolder; page++) {
          const listUrl =
            `https://www.123684.com/b/api/share/get?limit=100&next=${pageNext}` +
            `&orderBy=file_name&orderDirection=asc&shareKey=${encodeURIComponent(
              shareKey,
            )}&SharePwd=${encodeURIComponent(sharePwd)}` +
            `&ParentFileId=${encodeURIComponent(parentId)}&Page=1`;
          totalApiCalls++;
          const resp = await axios.get(listUrl, {
            headers: this.buildHeaders(),
            timeout: 15000,
            validateStatus: () => true,
          });
          const body = resp.data;
          if (!body || body.code !== 0) {
            // code 5103/5104 = share invalid/expired
            if (body?.code === 5103 || body?.code === 5104) {
              console.warn(
                '[Pan123Service] share invalid/expired, code=',
                body.code,
              );
              return {
                success: false,
                error: `123网盘分享链接无效或已过期 (code=${body.code})`,
              };
            }
            console.warn(
              '[Pan123Service] list failed, code=',
              body?.code,
              'parent=',
              parentId,
            );
            break;
          }
          const infoList = body?.data?.InfoList || body?.data?.infoList || [];
          if (!Array.isArray(infoList) || infoList.length === 0) {
            break; // no more files in this folder
          }
          for (const f of infoList) {
            // 123 pan: Type 0 = file, Type 1 = folder
            if (f.Type === 1 || f.type === 1) {
              const folderName = f.FileName || f.fileName || '';
              queue.push({
                parentId: String(f.FileId || f.fileId),
                next: 0,
                parentName: folderName,
              });
            } else {
              const name = f.FileName || f.fileName || '';
              if (videoExtRegex.test(name)) {
                files.push({
                  fileId: String(f.FileId || f.fileId),
                  fileName: name,
                  size: Number(f.Size || f.size || 0),
                  s3KeyFlag: f.S3KeyFlag || f.s3KeyFlag || '',
                  etag: f.Etag || f.etag || '',
                  shareKey,
                  category: parentName,
                });
              }
            }
          }
          // Check if there are more pages
          const isEnd =
            body?.data?.NextPage === 0 ||
            body?.data?.nextPage === 0 ||
            body?.data?.IsEnd !== undefined;
          if (isEnd) break;
          pageNext = body?.data?.NextPage || body?.data?.nextPage || 0;
          if (!pageNext) break;
        }
      }

      console.log(
        '[Pan123Service] resolveShareToFiles: shareKey=',
        shareKey,
        'files=',
        files.length,
        'apiCalls=',
        totalApiCalls,
      );

      if (files.length === 0) {
        return { success: false, error: '123网盘分享中没有找到视频文件' };
      }

      // Sort by filename (natural order)
      files.sort((a, b) =>
        a.fileName.localeCompare(b.fileName, 'zh-CN', { numeric: true }),
      );

      // Cache metadata internally so resolveDownloadUrl can look it up.
      // Also cache under the raw shareId (which may include ?pwd=) since
      // JarLoader's resolveQuarkPlayerContent passes the raw shareId.
      for (const f of files) {
        this.fileMetaCache.set(`${shareKey}:${f.fileId}`, {
          s3KeyFlag: f.s3KeyFlag,
          size: f.size,
          etag: f.etag,
        });
      }

      return {
        success: true,
        title: '123-' + shareKey,
        files,
      };
    } catch (e: any) {
      console.error(
        '[Pan123Service] resolveShareToFiles error:',
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
   * Resolve a 123 pan file to a direct download URL.
   * The download URL is a CDN link that works without Cookie/Referer.
   */
  static async resolveDownloadUrl(
    shareKeyOrId: string,
    fileId: string,
  ): Promise<string | null> {
    // shareKeyOrId may be the raw shareId from JarLoader (e.g.,
    // "3WSzTd-e5H3d?pwd=OI8C#") OR the clean shareKey. Extract the clean
    // shareKey for the API call.
    const cleanKey = shareKeyOrId.split(/[?#]/)[0];
    const cacheKey = `${cleanKey}:${fileId}`;
    const cached = this.downloadUrlCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.log('[Pan123Service] resolveDownloadUrl: cache hit');
      return cached.downloadUrl;
    }

    // Look up file metadata. Try both cleanKey and raw shareKeyOrId since
    // cacheFileMetadata may have been called with either form.
    const meta =
      this.fileMetaCache.get(cacheKey) ||
      this.fileMetaCache.get(`${shareKeyOrId}:${fileId}`);
    if (!meta) {
      console.warn(
        '[Pan123Service] resolveDownloadUrl: no metadata for',
        cacheKey,
        '(need to call resolveShareToFiles first)',
      );
      return null;
    }

    try {
      const resp = await axios.post(
        'https://www.123684.com/b/api/share/download/info',
        {
          ShareKey: cleanKey,
          FileID: fileId,
          S3KeyFlag: meta.s3KeyFlag,
          Size: meta.size,
          Etag: meta.etag,
        },
        {
          headers: this.buildHeaders(),
          timeout: 15000,
          validateStatus: () => true,
        },
      );
      const body = resp.data;
      if (body?.code !== 0 || !body?.data?.DownloadUrl) {
        console.warn(
          '[Pan123Service] resolveDownloadUrl failed, code=',
          body?.code,
          'msg=',
          body?.message,
        );
        return null;
      }
      const downloadUrl = body.data.DownloadUrl;
      // 123 pan download URLs expire after ~1 hour
      this.downloadUrlCache.set(cacheKey, {
        downloadUrl,
        expiresAt: Date.now() + 50 * 60 * 1000,
      });
      console.log(
        '[Pan123Service] resolveDownloadUrl: got URL for',
        cacheKey,
        '(len=',
        downloadUrl.length,
        ')',
      );
      return downloadUrl;
    } catch (e: any) {
      console.error('[Pan123Service] resolveDownloadUrl error:', e.message);
      return null;
    }
  }

  // Metadata cache: (shareKey:fileId) → { s3KeyFlag, size, etag }
  // Populated by resolveShareToFiles, consumed by resolveDownloadUrl.
  private static fileMetaCache = new Map<
    string,
    { s3KeyFlag: string; size: number; etag: string }
  >();

  /**
   * Store file metadata so resolveDownloadUrl can look it up later.
   * Called from JarLoader after resolveShareToFiles returns.
   */
  static cacheFileMetadata(
    shareKey: string,
    fileId: string,
    meta: { s3KeyFlag: string; size: number; etag: string },
  ): void {
    this.fileMetaCache.set(`${shareKey}:${fileId}`, meta);
  }
}
