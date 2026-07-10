import axios from 'axios';
import { ipcMain } from 'electron';

/**
 * Pan189Service - 天翼网盘 (China Telecom 189 Cloud) share resolver.
 *
 * Based on Android spider NewPan189.java decompiled flow:
 *
 *   1. Parse share URL to extract shareCode + optional accessCode (password).
 *   2. GET getShareInfoByCodeV2.action?shareCode=<code> to get share metadata
 *      (fileId, shareId, isFolder, shareMode, fileName). No login needed.
 *   3. If isFolder=true: GET listShareDir.action?fileId=<id>&shareId=<id>
 *      &isFolder=true&shareMode=<mode>&accessCode=<pwd> to list files. No login.
 *   4. Recursive into subfolders.
 *
 * Playback requires login (Wex_pan189_cookie) + signature via
 * getFileDownloadUrl.action. Without login, episodes are listed but playback
 * returns a "login required" prompt.
 *
 * Episode ID format: Base64-encoded JSON of
 *   { file_id, share_id, file_name, dir_name, file_size }
 * matching Android's NewPan189.getvod() output.
 */
export class Pan189Service {
  private static syncedCookie: string | null = null;

  static init(): void {
    ipcMain.handle('pan189:setCookie', async (_event, cookie: string) => {
      this.syncedCookie = cookie;
      return { success: true };
    });
    ipcMain.handle('pan189:getCookie', async () => {
      return { cookie: this.syncedCookie };
    });
    console.log('[Pan189Service] Initialized');
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
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      Accept: 'application/json;charset=UTF-8',
      Cookie: cookie || '',
    };
  }

  /**
   * Parse a 189 pan share URL to extract shareCode and optional password.
   * URL formats:
   *   https://cloud.189.cn/web/share?code=<code>
   *   https://cloud.189.cn/web/share?code=<code>（访问码:<pwd>）
   *   https://cloud.189.cn/t/<code>
   *   https://cloud.189.cn/t/<code>（访问码:<pwd>）
   *   https://cloud.189.cn/t/<code>?访问码:<pwd>
   */
  private static parseShareUrl(
    shareUrl: string,
  ): { shareCode: string; accessCode: string } | null {
    try {
      let decoded = shareUrl;
      try {
        decoded = decodeURIComponent(shareUrl);
      } catch {
        // ignore
      }
      // Extract password from "（访问码:xxx）" or "?访问码:xxx" or "?pwd=xxx"
      let accessCode = '';
      const pwdMatch = decoded.match(
        /(?:访问码[:：]|pwd=|password=)([A-Za-z0-9]{4})/,
      );
      if (pwdMatch) {
        accessCode = pwdMatch[1];
      }
      // Extract shareCode
      let shareCode = '';
      let m = decoded.match(/cloud\.189\.cn\/web\/share\?code=([A-Za-z0-9]+)/);
      if (m) {
        shareCode = m[1];
      } else {
        m = decoded.match(/cloud\.189\.cn\/t\/([A-Za-z0-9]+)/);
        if (m) {
          shareCode = m[1];
        }
      }
      if (!shareCode) {
        // Fallback: uuid/shareCode pattern
        m = decoded.match(/shareCode=([A-Za-z0-9]+)/);
        if (m) shareCode = m[1];
      }
      if (!shareCode) {
        console.warn('[Pan189Service] parseShareUrl: no shareCode for', shareUrl);
        return null;
      }
      return { shareCode, accessCode };
    } catch (e: any) {
      console.warn('[Pan189Service] parseShareUrl error:', e.message);
      return null;
    }
  }

  /**
   * Resolve a 189 pan share link to a list of playable video files.
   * No login needed for listing. Recursively lists folders.
   */
  static async resolveShareToFiles(shareUrl: string): Promise<{
    success: boolean;
    title?: string;
    files?: Array<{
      fileId: string;
      fileName: string;
      size: number;
      shareId: string;
      shareCode: string;
      accessCode: string;
      dirName: string;
    }>;
    error?: string;
  }> {
    const parsed = this.parseShareUrl(shareUrl);
    if (!parsed) {
      return {
        success: false,
        error: 'Invalid 189 pan share URL: ' + shareUrl,
      };
    }
    const { shareCode, accessCode } = parsed;
    console.log(
      '[Pan189Service] resolveShareToFiles: shareCode=',
      shareCode,
      'accessCode=',
      accessCode ? '***' : '(empty)',
    );

    try {
      // Step 1: getShareInfoByCodeV2
      const infoUrl =
        `https://cloud.189.cn/api/open/share/getShareInfoByCodeV2.action?noCache=${Math.random()}` +
        `&shareCode=${encodeURIComponent(shareCode)}`;
      const infoResp = await axios.get(infoUrl, {
        headers: this.buildHeaders(),
        timeout: 15000,
        validateStatus: () => true,
      });
      const info = infoResp.data;
      if (!info || info.res_code !== '0' || !info.shareId) {
        console.warn(
          '[Pan189Service] getShareInfoByCodeV2 failed, res_code=',
          info?.res_code,
          'msg=',
          info?.res_message || info?.errorMsg,
        );
        return {
          success: false,
          error: `天翼网盘分享解析失败: ${info?.res_message || info?.errorMsg || 'unknown'}`,
        };
      }
      const shareId = String(info.shareId);
      const rootFileId = String(info.fileId);
      const isFolder = String(info.isFolder);
      const shareMode = String(info.shareMode);
      const rootFileName = info.fileName || '';
      console.log(
        '[Pan189Service] getShareInfoByCodeV2: shareId=',
        shareId,
        'fileId=',
        rootFileId,
        'isFolder=',
        isFolder,
      );

      const files: Array<{
        fileId: string;
        fileName: string;
        size: number;
        shareId: string;
        shareCode: string;
        accessCode: string;
        dirName: string;
      }> = [];
      const videoExtRegex =
        /\.(mp4|mkv|ts|avi|mov|flv|webm|m4v|mpg|mpeg|3gp|m3u8|rmvb|iso)$/i;

      // Step 2: if folder, list recursively; if file, add directly
      if (isFolder === 'true' || isFolder === '1') {
        await this.listShareDirRecursive(
          rootFileId,
          shareId,
          isFolder,
          shareMode,
          accessCode,
          '',
          files,
          videoExtRegex,
        );
      } else {
        // Single file share
        if (videoExtRegex.test(rootFileName)) {
          files.push({
            fileId: rootFileId,
            fileName: rootFileName,
            size: 0,
            shareId,
            shareCode,
            accessCode,
            dirName: '',
          });
        }
      }

      console.log(
        '[Pan189Service] resolveShareToFiles: shareCode=',
        shareCode,
        'files=',
        files.length,
      );

      if (files.length === 0) {
        return { success: false, error: '天翼网盘分享中没有找到视频文件' };
      }

      // Sort by filename (natural order)
      files.sort((a, b) =>
        a.fileName.localeCompare(b.fileName, 'zh-CN', { numeric: true }),
      );

      return {
        success: true,
        title: '189-' + shareCode,
        files,
      };
    } catch (e: any) {
      console.error(
        '[Pan189Service] resolveShareToFiles error:',
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
   * Recursively list a 189 pan share folder.
   */
  private static async listShareDirRecursive(
    fileId: string,
    shareId: string,
    isFolder: string,
    shareMode: string,
    accessCode: string,
    dirName: string,
    files: Array<{
      fileId: string;
      fileName: string;
      size: number;
      shareId: string;
      shareCode: string;
      accessCode: string;
      dirName: string;
    }>,
    videoExtRegex: RegExp,
  ): Promise<void> {
    const listUrl =
      `https://cloud.189.cn/api/open/share/listShareDir.action?noCache=${Math.random()}` +
      `&pageNum=1&pageSize=9999&fileId=${encodeURIComponent(fileId)}` +
      `&shareDirFileId=${encodeURIComponent(fileId)}` +
      `&isFolder=${encodeURIComponent(isFolder)}` +
      `&shareId=${encodeURIComponent(shareId)}` +
      `&shareMode=${encodeURIComponent(shareMode)}` +
      `&iconOption=5&orderBy=filename&descending=false` +
      `&accessCode=${encodeURIComponent(accessCode)}`;
    const resp = await axios.get(listUrl, {
      headers: this.buildHeaders(),
      timeout: 15000,
      validateStatus: () => true,
    });
    const body = resp.data;
    if (!body || !body.fileListAO) {
      return;
    }
    const fileList = body.fileListAO.fileList || [];
    const folderList = body.fileListAO.folderList || [];
    for (const f of fileList) {
      const name = String(f.name || '').replaceAll('$', '').replaceAll('#', '');
      if (videoExtRegex.test(name)) {
        files.push({
          fileId: String(f.id),
          fileName: name,
          size: Number(f.size || 0),
          shareId,
          shareCode: '',
          accessCode,
          dirName,
        });
      }
    }
    // Recurse into subfolders
    for (const folder of folderList) {
      const subName = String(folder.name || '')
        .replaceAll('$', '')
        .replaceAll('#', '');
      const subDirName = dirName ? `${dirName}/${subName}` : subName;
      await this.listShareDirRecursive(
        String(folder.id),
        shareId,
        'true',
        shareMode,
        accessCode,
        subDirName,
        files,
        videoExtRegex,
      );
    }
  }

  /**
   * Build the episode ID (Base64-encoded JSON) matching Android's format.
   */
  static buildEpisodeId(file: {
    fileId: string;
    fileName: string;
    size: number;
    shareId: string;
    dirName: string;
  }): string {
    const payload = {
      file_id: file.fileId,
      share_id: file.shareId,
      file_name: file.fileName,
      dir_name: file.dirName,
      file_size: file.size,
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  }

  /**
   * Resolve a 189 pan file to a play URL.
   * Requires login (Wex_pan189_cookie) + signature. Not implemented
   * (returns null to signal "login required").
   */
  static async resolveDownloadUrl(
    _shareCode: string,
    _fileId: string,
  ): Promise<string | null> {
    if (!this.syncedCookie) {
      console.warn(
        '[Pan189Service] resolveDownloadUrl: no cookie set, login required',
      );
      return null;
    }
    // Full playback implementation requires signature calculation
    // (AccessToken + Timestamp + Signature + Sign-Type) which is complex.
    // For now, return null to signal login required.
    // TODO: implement signature-based playback when cookie is available.
    console.warn(
      '[Pan189Service] resolveDownloadUrl: playback not yet implemented (needs signature)',
    );
    return null;
  }
}
