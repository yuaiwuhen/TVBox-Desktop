import axios from 'axios';
import { ipcMain } from 'electron';

/**
 * Pan115Service - 115网盘 share resolver.
 *
 * Based on Android spider NewPan115.java decompiled flow:
 *
 *   1. Parse share URL to extract share_code + receive_code (password).
 *   2. GET https://115cdn.com/webapi/share/snap?share_code=<code>&receive_code=<pwd>&cid=
 *      to list files in the share. No login needed for listing.
 *    - Items with "fid" are files; items with "cid" are folders (recurse).
 *   3. Recursive folder traversal via cid parameter.
 *
 * Playback requires login (Wex_pan115_cookie) + LoadNiMa.decode encryption
 * via jx1.php/jx2.php endpoints. Without login, episodes are listed but
 * playback returns a "login required" prompt.
 *
 * Episode ID format: Base64-encoded JSON of
 *   { share_code, receive_code, file_id, file_name }
 * matching Android's NewPan115$PlayInfo.toJsonBase64() output.
 */
export class Pan115Service {
  private static syncedCookie: string | null = null;

  static init(): void {
    ipcMain.handle('pan115:setCookie', async (_event, cookie: string) => {
      this.syncedCookie = cookie;
      return { success: true };
    });
    ipcMain.handle('pan115:getCookie', async () => {
      return { cookie: this.syncedCookie };
    });
    console.log('[Pan115Service] Initialized');
  }

  static setSyncedCookie(cookie: string | null): void {
    this.syncedCookie = cookie;
  }
  static getSyncedCookie(): string | null {
    return this.syncedCookie;
  }

  private static buildHeaders(cookie?: string): Record<string, string> {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36  115Browser/26.0.7.2',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://115.com',
      Origin: 'https://115.com',
      Cookie: cookie || '',
    };
  }

  /**
   * Parse a 115 pan share URL to extract share_code and receive_code.
   * URL format: https://115.com/s/<share_code>?password=<receive_code>
   *   or: https://anxia.com/s/<share_code>?password=<receive_code>
   *   or: https://115cdn.com/s/<share_code>?password=<receive_code>
   */
  private static parseShareUrl(
    shareUrl: string,
  ): { shareCode: string; receiveCode: string } | null {
    try {
      let decoded = shareUrl;
      try {
        decoded = decodeURIComponent(shareUrl);
      } catch {
        // ignore
      }
      // Match share_code and password
      let m = decoded.match(
        /https?:\/\/(?:115\.com|anxia\.com|115cdn\.com)\/s\/([^?]+)\?password=([a-zA-Z0-9]+)/,
      );
      if (m) {
        return { shareCode: m[1], receiveCode: m[2] };
      }
      // Try without password
      m = decoded.match(
        /https?:\/\/(?:115\.com|anxia\.com|115cdn\.com)\/s\/([a-zA-Z0-9]+)/,
      );
      if (m) {
        return { shareCode: m[1], receiveCode: '' };
      }
      console.warn('[Pan115Service] parseShareUrl: no match for', shareUrl);
      return null;
    } catch (e: any) {
      console.warn('[Pan115Service] parseShareUrl error:', e.message);
      return null;
    }
  }

  /**
   * Resolve a 115 pan share link to a list of playable video files.
   * No login needed for listing. Recursively lists folders.
   */
  static async resolveShareToFiles(shareUrl: string): Promise<{
    success: boolean;
    title?: string;
    files?: Array<{
      fileId: string;
      fileName: string;
      size: number;
      shareCode: string;
      receiveCode: string;
      dirName: string;
    }>;
    error?: string;
  }> {
    const parsed = this.parseShareUrl(shareUrl);
    if (!parsed) {
      return {
        success: false,
        error: 'Invalid 115 pan share URL: ' + shareUrl,
      };
    }
    const { shareCode, receiveCode } = parsed;
    console.log(
      '[Pan115Service] resolveShareToFiles: shareCode=',
      shareCode,
      'receiveCode=',
      receiveCode ? '***' : '(empty)',
    );

    try {
      const files: Array<{
        fileId: string;
        fileName: string;
        size: number;
        shareCode: string;
        receiveCode: string;
        dirName: string;
      }> = [];
      const videoExtRegex =
        /\.(mp4|mkv|ts|avi|mov|flv|webm|m4v|mpg|mpeg|3gp|m3u8|rmvb|iso)$/i;

      // BFS through folders starting at cid="" (root)
      await this.listSnapRecursive(
        shareCode,
        receiveCode,
        '',
        '',
        files,
        videoExtRegex,
      );

      console.log(
        '[Pan115Service] resolveShareToFiles: shareCode=',
        shareCode,
        'files=',
        files.length,
      );

      if (files.length === 0) {
        return { success: false, error: '115网盘分享中没有找到视频文件' };
      }

      // Sort by filename (natural order)
      files.sort((a, b) =>
        a.fileName.localeCompare(b.fileName, 'zh-CN', { numeric: true }),
      );

      return {
        success: true,
        title: '115-' + shareCode,
        files,
      };
    } catch (e: any) {
      console.error(
        '[Pan115Service] resolveShareToFiles error:',
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
   * Recursively list a 115 pan share via webapi/share/snap.
   */
  private static async listSnapRecursive(
    shareCode: string,
    receiveCode: string,
    cid: string,
    dirName: string,
    files: Array<{
      fileId: string;
      fileName: string;
      size: number;
      shareCode: string;
      receiveCode: string;
      dirName: string;
    }>,
    videoExtRegex: RegExp,
  ): Promise<void> {
    const snapUrl =
      `https://115cdn.com/webapi/share/snap?share_code=${encodeURIComponent(shareCode)}` +
      `&offset=0&limit=9999&asc=1&o=file_name` +
      `&receive_code=${encodeURIComponent(receiveCode)}` +
      `&cid=${encodeURIComponent(cid)}`;
    const resp = await axios.get(snapUrl, {
      headers: this.buildHeaders(),
      timeout: 15000,
      validateStatus: () => true,
    });
    const body = resp.data;
    if (!body || !body.state || !body.data || !body.data.list) {
      console.warn(
        '[Pan115Service] listSnapRecursive: no list, state=',
        body?.state,
        'cid=',
        cid,
      );
      return;
    }
    const list = body.data.list;
    for (const item of list) {
      const name = String(item.n || '').replaceAll('#', '').replaceAll('$', '');
      const size = Number(item.s || 0);
      if (item.fid) {
        // File
        if (videoExtRegex.test(name)) {
          files.push({
            fileId: String(item.fid),
            fileName: name,
            size,
            shareCode,
            receiveCode,
            dirName,
          });
        }
      } else if (item.cid) {
        // Folder: recurse
        const subDirName = dirName ? `${dirName}/${name}` : name;
        await this.listSnapRecursive(
          shareCode,
          receiveCode,
          String(item.cid),
          subDirName,
          files,
          videoExtRegex,
        );
      }
    }
  }

  /**
   * Build the episode ID (Base64-encoded JSON) matching Android's
   * NewPan115$PlayInfo.toJsonBase64() format.
   */
  static buildEpisodeId(file: {
    shareCode: string;
    receiveCode: string;
    fileId: string;
    fileName: string;
  }): string {
    const payload = {
      share_code: file.shareCode,
      receive_code: file.receiveCode,
      file_id: file.fileId,
      file_name: file.fileName,
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  }

  /**
   * Resolve a 115 pan file to a play URL.
   * Requires login (Wex_pan115_cookie) + LoadNiMa.decode encryption via
   * jx1.php/jx2.php. Not implemented (returns null to signal "login required").
   */
  static async resolveDownloadUrl(
    _shareCode: string,
    _fileId: string,
  ): Promise<string | null> {
    if (!this.syncedCookie) {
      console.warn(
        '[Pan115Service] resolveDownloadUrl: no cookie set, login required',
      );
      return null;
    }
    // Full playback requires LoadNiMa.decode (jx1.php/jx2.php) which is
    // complex. Return null for now.
    // TODO: implement LoadNiMa.decode-based playback when cookie is available.
    console.warn(
      '[Pan115Service] resolveDownloadUrl: playback not yet implemented (needs LoadNiMa.decode)',
    );
    return null;
  }
}
