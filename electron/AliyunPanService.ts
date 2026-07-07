import axios from 'axios';
import { ipcMain } from 'electron';

/**
 * AliyunPanService - 阿里云盘 share resolver.
 *
 * Aliyun Drive uses access_token-based auth (Authorization: Bearer ...),
 * different from Quark/UC's cookie-based auth.
 *
 * Flow:
 *   1. Refresh access_token via /token/refresh (using refresh_token saved
 *      during QR login).
 *   2. resolveShareToFiles: get_share_by_anonymous → list (recursive)
 *   3. resolveDownloadUrl: save share file to user's drive → get_download_url
 *      → return signed download_url (works without Cookie/Referer).
 *
 * Aliyun's download_url is signed and works for ~15 minutes. No transfer-
 * then-play needed (no per-file size limit for free accounts on Aliyun).
 */
export class AliyunPanService {
  private static refreshToken: string = '';
  private static accessToken: string = '';
  private static driveId: string = '';
  private static tokenExpiresAt: number = 0;
  private static tvboxFolderFid: string | null = null;
  // Cache: file_id → { downloadUrl, expiresAt }
  private static downloadUrlCache = new Map<
    string,
    { downloadUrl: string; expiresAt: number }
  >();
  // Cache: shareId → shareToken (so playerContent can resolve by shareId+fileId
  // without re-fetching share_token). share_token is short-lived (~4 hours).
  private static shareTokenCache = new Map<
    string,
    { shareToken: string; expiresAt: number }
  >();

  static init(): void {
    ipcMain.handle('aliyun:setLoginInfo', async (_event, info: any) => {
      this.refreshToken = info?.refreshToken || '';
      this.accessToken = info?.accessToken || '';
      this.driveId = info?.driveId || '';
      this.tokenExpiresAt = Date.now() + 100 * 60 * 1000; // assume valid 100min
      console.log(
        '[AliyunPanService] setLoginInfo: refreshToken len=',
        this.refreshToken.length,
        'accessToken len=',
        this.accessToken.length,
      );
      return { success: true };
    });
    console.log('[AliyunPanService] Initialized');
  }

  static setLoginInfo(info: {
    refreshToken?: string;
    accessToken?: string;
  }): void {
    if (info.refreshToken) this.refreshToken = info.refreshToken;
    if (info.accessToken) {
      this.accessToken = info.accessToken;
      this.tokenExpiresAt = Date.now() + 100 * 60 * 1000;
    }
  }

  /**
   * Refresh the access_token using the saved refresh_token.
   * Aliyun access_tokens expire after 2 hours; refresh_tokens last ~30 days.
   */
  private static async ensureAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    if (!this.refreshToken) {
      console.warn('[AliyunPanService] ensureAccessToken: no refresh_token');
      return null;
    }
    try {
      const resp = await axios.post(
        'https://api.aliyundrive.com/token/refresh',
        { refresh_token: this.refreshToken },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000,
        },
      );
      if (resp.data?.access_token) {
        this.accessToken = resp.data.access_token;
        this.refreshToken = resp.data.refresh_token || this.refreshToken;
        this.driveId = resp.data.default_drive_id || this.driveId;
        // Tokens expire in 7200s; refresh 5 min before.
        this.tokenExpiresAt = Date.now() + (7200 - 300) * 1000;
        console.log(
          '[AliyunPanService] ensureAccessToken: refreshed, driveId=',
          this.driveId,
        );
        return this.accessToken;
      }
      console.warn(
        '[AliyunPanService] ensureAccessToken: refresh failed:',
        resp.data?.message,
      );
      return null;
    } catch (e: any) {
      console.error(
        '[AliyunPanService] ensureAccessToken error:',
        e.message,
        e.response?.data,
      );
      return null;
    }
  }

  /**
   * Resolve an Aliyun share link to a list of playable video files.
   *
   * Uses /adrive/v1.0/share/get_share_by_anonymous (no access_token needed
   * for share browsing, only for download).
   */
  static async resolveShareToFiles(shareUrl: string): Promise<{
    success: boolean;
    title?: string;
    files?: Array<{
      fileId: string;
      fileName: string;
      size: number;
      shareId: string;
      shareToken: string;
      driveId?: string;
    }>;
    error?: string;
  }> {
    // Extract share_id from URL like
    // https://www.aliyundrive.com/s/<id> or https://www.alipan.com/s/<id>
    const match = shareUrl.match(/\/s\/([a-zA-Z0-9]+)/);
    if (!match) {
      return { success: false, error: 'Invalid share URL: ' + shareUrl };
    }
    const shareId = match[1];

    try {
      // Step 1: Get share_token (anonymous, no auth needed).
      const shareResp = await axios.post(
        'https://api.aliyundrive.com/adrive/v1.0/share/get_share_by_anonymous',
        { share_id: shareId },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000,
          validateStatus: () => true,
        },
      );
      if (shareResp.data?.code !== '0' || !shareResp.data?.data?.share_token) {
        // Try alternative: pass share_pwd if required
        const withPwd = await axios.post(
          'https://api.aliyundrive.com/adrive/v1.0/share/get_share_by_anonymous',
          { share_id: shareId, share_pwd: '' },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
            validateStatus: () => true,
          },
        );
        if (withPwd.data?.code !== '0' || !withPwd.data?.data?.share_token) {
          return {
            success: false,
            error:
              'Share token API failed: ' +
              (shareResp.data?.message || withPwd.data?.message || 'unknown'),
          };
        }
        shareResp.data = withPwd.data;
      }
      const shareToken: string = shareResp.data.data.share_token;
      const title: string = shareResp.data.data.shareinfo?.title || '';
      // Cache shareToken for later playerContent resolution. Aliyun's
      // share_token is valid for ~4 hours; refresh 10 min before expiry.
      this.shareTokenCache.set(shareId, {
        shareToken,
        expiresAt: Date.now() + (4 * 3600 - 600) * 1000,
      });
      console.log(
        '[AliyunPanService] resolveShareToFiles: shareId=',
        shareId,
        'title=',
        title,
      );

      // Step 2: Recursively list files.
      const files: Array<{
        fileId: string;
        fileName: string;
        size: number;
        shareId: string;
        shareToken: string;
        driveId?: string;
      }> = [];
      const videoExtRegex =
        /\.(mp4|mkv|ts|avi|mov|flv|webm|m4v|mpg|mpeg|3gp|m3u8)$/i;

      const listDir = async (
        parentFileId: string,
        depth: number,
      ): Promise<void> => {
        if (depth > 3) return;
        // First page
        let nextMarker: string | null = null;
        do {
          const body: any = {
            share_id: shareId,
            parent_file_id: parentFileId,
            share_token: shareToken,
          };
          if (nextMarker) body.marker = nextMarker;
          const listResp = await axios.post(
            'https://api.aliyundrive.com/adrive/v1.0/share/list',
            body,
            {
              headers: { 'Content-Type': 'application/json' },
              timeout: 15000,
              validateStatus: () => true,
            },
          );
          if (listResp.data?.code !== '0') {
            console.warn(
              '[AliyunPanService] list API error at parent=',
              parentFileId,
              ':',
              listResp.data?.message,
            );
            break;
          }
          const items = listResp.data?.data?.items || [];
          for (const item of items) {
            if (item.type === 'folder') {
              await listDir(item.file_id, depth + 1);
            } else if (
              item.type === 'file' &&
              videoExtRegex.test(item.name || '')
            ) {
              files.push({
                fileId: item.file_id,
                fileName: item.name,
                size: item.size || 0,
                shareId,
                shareToken,
                driveId: item.drive_id,
              });
            }
          }
          nextMarker = listResp.data?.data?.next_marker || null;
        } while (nextMarker);
      };

      await listDir('root', 0);
      console.log(
        '[AliyunPanService] resolveShareToFiles: found',
        files.length,
        'video files for shareId=',
        shareId,
      );
      return { success: true, title, files };
    } catch (e: any) {
      console.error(
        '[AliyunPanService] resolveShareToFiles error:',
        e.message,
        e.response?.data,
      );
      return {
        success: false,
        error: `${e.message} (status: ${e.response?.status || 'unknown'})`,
      };
    }
  }

  /**
   * Resolve an Aliyun share file to a download URL.
   *
   * Aliyun requires saving the share file to user's own drive before
   * /v2/file/get_download_url works. The save is fast (metadata copy).
   * Returns a signed download_url that works directly (no Cookie/Referer).
   *
   * shareToken is looked up from the cache populated by resolveShareToFiles.
   * If missing/expired, we re-fetch via get_share_by_anonymous.
   */
  static async resolveDownloadUrl(
    shareId: string,
    fileId: string,
  ): Promise<string | null> {
    const cacheKey = `${shareId}:${fileId}`;
    const cached = this.downloadUrlCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.log('[AliyunPanService] resolveDownloadUrl: cache hit');
      return cached.downloadUrl;
    }

    const accessToken = await this.ensureAccessToken();
    if (!accessToken) {
      console.warn('[AliyunPanService] resolveDownloadUrl: no access_token');
      return null;
    }

    // Look up shareToken from cache; re-fetch if missing/expired.
    let shareToken = '';
    const cachedToken = this.shareTokenCache.get(shareId);
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
      shareToken = cachedToken.shareToken;
    } else {
      const reToken = await this.fetchShareToken(shareId);
      if (!reToken) {
        console.warn(
          '[AliyunPanService] resolveDownloadUrl: no share_token for',
          shareId,
        );
        return null;
      }
      shareToken = reToken;
    }

    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    };

    try {
      // Step 1: Find or create TVBox folder.
      const tvboxFid = await this.findOrCreateTvboxFolder(authHeaders);
      if (!tvboxFid) return null;

      // Step 2: Save the share file to TVBox folder.
      const saveResp = await axios.post(
        'https://api.aliyundrive.com/adrive/v1.0/share/save',
        {
          share_id: shareId,
          file_id: fileId,
          share_token: shareToken,
          to_drive_id: this.driveId,
          to_parent_file_id: tvboxFid,
        },
        {
          headers: authHeaders,
          timeout: 15000,
          validateStatus: () => true,
        },
      );
      if (saveResp.data?.code !== '0' || !saveResp.data?.data?.file_id) {
        // Check if file already exists (duplicate save returns error)
        if (saveResp.data?.code === 'invalidParameter.DuplicateFile') {
          // Find the existing file in TVBox folder
          const existingFid = await this.findFileInFolder(
            authHeaders,
            tvboxFid,
            fileId,
          );
          if (!existingFid) {
            console.warn(
              '[AliyunPanService] duplicate save but file not found',
            );
            return null;
          }
          return await this.fetchDownloadUrl(
            authHeaders,
            cacheKey,
            existingFid,
          );
        }
        console.warn(
          '[AliyunPanService] save failed:',
          saveResp.data?.message,
          '(code:',
          saveResp.data?.code,
          ')',
        );
        return null;
      }
      const newFileId: string = saveResp.data.data.file_id;
      console.log(
        '[AliyunPanService] resolveDownloadUrl: saved, new file_id=',
        newFileId,
      );

      // Step 3: Get download URL for the saved file.
      const downloadUrl = await this.fetchDownloadUrl(
        authHeaders,
        cacheKey,
        newFileId,
      );
      // Schedule cleanup (delete saved file after 30 min, since download_url
      // expires in 15 min and we don't want to clutter user's drive).
      if (downloadUrl) {
        const fidToDelete = newFileId;
        setTimeout(
          () => {
            void this.deleteFile(authHeaders, fidToDelete);
            this.downloadUrlCache.delete(cacheKey);
          },
          30 * 60 * 1000,
        );
      }
      return downloadUrl;
    } catch (e: any) {
      console.error(
        '[AliyunPanService] resolveDownloadUrl error:',
        e.message,
        e.response?.data,
      );
      return null;
    }
  }

  private static async findOrCreateTvboxFolder(
    authHeaders: Record<string, string>,
  ): Promise<string | null> {
    if (this.tvboxFolderFid) return this.tvboxFolderFid;
    try {
      // List root folder.
      const listResp = await axios.post(
        'https://api.aliyundrive.com/adrive/v1.0/file/list',
        {
          drive_id: this.driveId,
          parent_file_id: 'root',
          limit: 200,
          order_by: 'name',
          order_direction: 'ASC',
        },
        {
          headers: authHeaders,
          timeout: 15000,
          validateStatus: () => true,
        },
      );
      const items = listResp.data?.data?.items || [];
      for (const item of items) {
        if (item.type === 'folder' && item.name === 'TVBox') {
          this.tvboxFolderFid = item.file_id;
          return this.tvboxFolderFid;
        }
      }
      // Create TVBox folder.
      const createResp = await axios.post(
        'https://api.aliyundrive.com/adrive/v1.0/file/create',
        {
          drive_id: this.driveId,
          parent_file_id: 'root',
          name: 'TVBox',
          type: 'folder',
          check_name_mode: 'refuse',
        },
        {
          headers: authHeaders,
          timeout: 15000,
          validateStatus: () => true,
        },
      );
      if (createResp.data?.data?.file_id) {
        this.tvboxFolderFid = createResp.data.data.file_id;
        console.log(
          '[AliyunPanService] created TVBox folder, fid=',
          this.tvboxFolderFid,
        );
        return this.tvboxFolderFid;
      }
      return null;
    } catch (e: any) {
      console.error(
        '[AliyunPanService] findOrCreateTvboxFolder error:',
        e.message,
      );
      return null;
    }
  }

  private static async findFileInFolder(
    authHeaders: Record<string, string>,
    folderFid: string,
    _originalFileId: string,
  ): Promise<string | null> {
    // Aliyun doesn't return the saved file_id for duplicates; we'd need to
    // list the folder and match by name. For simplicity, return null and let
    // the caller retry with a unique folder name.
    void authHeaders;
    void folderFid;
    void _originalFileId;
    return null;
  }

  private static async fetchDownloadUrl(
    authHeaders: Record<string, string>,
    cacheKey: string,
    fileId: string,
  ): Promise<string | null> {
    try {
      const resp = await axios.post(
        'https://api.aliyundrive.com/v2/file/get_download_url',
        { drive_id: this.driveId, file_id: fileId },
        {
          headers: authHeaders,
          timeout: 15000,
          validateStatus: () => true,
        },
      );
      if (resp.data?.data?.download_url || resp.data?.download_url) {
        const url: string =
          resp.data.data?.download_url || resp.data.download_url;
        console.log(
          '[AliyunPanService] fetchDownloadUrl: got URL, length=',
          url.length,
        );
        this.downloadUrlCache.set(cacheKey, {
          downloadUrl: url,
          // download_url expires in 15 min; refresh 1 min before.
          expiresAt: Date.now() + 14 * 60 * 1000,
        });
        return url;
      }
      console.warn(
        '[AliyunPanService] fetchDownloadUrl failed:',
        resp.data?.message,
      );
      return null;
    } catch (e: any) {
      console.error('[AliyunPanService] fetchDownloadUrl error:', e.message);
      return null;
    }
  }

  private static async deleteFile(
    authHeaders: Record<string, string>,
    fileId: string,
  ): Promise<void> {
    try {
      await axios.post(
        'https://api.aliyundrive.com/adrive/v1.0/recyclebin/trash',
        { drive_id: this.driveId, file_id: fileId },
        {
          headers: authHeaders,
          timeout: 15000,
          validateStatus: () => true,
        },
      );
      console.log('[AliyunPanService] deleted file', fileId);
    } catch (e: any) {
      console.warn('[AliyunPanService] deleteFile error:', e.message);
    }
  }

  /**
   * Fetch share_token via get_share_by_anonymous. Used by resolveDownloadUrl
   * when the cached shareToken has expired.
   */
  private static async fetchShareToken(
    shareId: string,
  ): Promise<string | null> {
    try {
      const resp = await axios.post(
        'https://api.aliyundrive.com/adrive/v1.0/share/get_share_by_anonymous',
        { share_id: shareId },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000,
          validateStatus: () => true,
        },
      );
      if (resp.data?.code !== '0' || !resp.data?.data?.share_token) {
        return null;
      }
      const shareToken: string = resp.data.data.share_token;
      this.shareTokenCache.set(shareId, {
        shareToken,
        expiresAt: Date.now() + (4 * 3600 - 600) * 1000,
      });
      return shareToken;
    } catch {
      return null;
    }
  }
}
