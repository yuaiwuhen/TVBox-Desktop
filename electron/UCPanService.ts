import axios from 'axios';
import { ipcMain } from 'electron';

/**
 * UCPanService - UC网盘 share resolver.
 *
 * UC盘 and Quark盘 share the same API shape (both operated by Alibaba's UC
 * subsidiary). The only differences are:
 *   - Domain: pc-api.uc.cn (UC) vs drive-pc.quark.cn (Quark)
 *   - pr parameter: UCBrowser (UC) vs ucpro (Quark)
 *   - Cookie keys: same (__pus, __puus)
 *
 * Flow mirrors QuarkPanService:
 *   1. resolveShareToFiles: token → detail (recursive) → flat file list
 *   2. resolveDownloadUrl: try /file/download → on 23018 (size limit) fall
 *      back to transfer-then-play using /file/v2/play (returns streaming URL
 *      with signed auth_key).
 */
export class UCPanService {
  // Last cookie synced from renderer (set via PanLoginService.syncAllCookies).
  private static syncedCookie: string | null = null;
  // Cache: (shareId:fid) → { playUrl, expiresAt, transferredFid }
  private static playUrlCache = new Map<
    string,
    { playUrl: string; expiresAt: number; transferredFid: string }
  >();
  private static tvboxFolderFid: string | null = null;

  static setSyncedCookie(cookie: string | null): void {
    this.syncedCookie = cookie;
  }
  static getSyncedCookie(): string | null {
    return this.syncedCookie;
  }

  static init(): void {
    ipcMain.handle('uc:setCookie', async (_event, cookie: string) => {
      this.syncedCookie = cookie;
      return { success: true };
    });
    ipcMain.handle('uc:getCookie', async () => {
      return { cookie: this.syncedCookie };
    });
    console.log('[UCPanService] Initialized');
  }

  private static buildHeaders(): Record<string, string> {
    const UA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
    return {
      Cookie: this.syncedCookie || '',
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Referer: 'https://drive.uc.cn/',
      Origin: 'https://drive.uc.cn',
    };
  }

  /**
   * Resolve a UC share link to a list of playable video files.
   *
   * Mirrors QuarkPanService.resolveShareToFiles but with UC's API domain.
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
    if (!this.syncedCookie) {
      return { success: false, error: 'UC cookie not synced. Please login first.' };
    }
    const match = shareUrl.match(/\/s\/([a-zA-Z0-9]+)/);
    if (!match) {
      return { success: false, error: 'Invalid share URL: ' + shareUrl };
    }
    const shareId = match[1];
    const headers = this.buildHeaders();

    try {
      const tokenResp = await axios.post(
        'https://pc-api.uc.cn/1/clouddrive/share/sharepage/token?pr=UCBrowser&fr=pc',
        { pwd_id: shareId, passcode: '', support_visit_limit_private_share: true },
        { headers, timeout: 15000 },
      );
      if (tokenResp.data?.code !== 0 || !tokenResp.data?.data?.stoken) {
        return {
          success: false,
          error: 'Token API failed: ' + (tokenResp.data?.message || 'unknown'),
        };
      }
      const stoken: string = tokenResp.data.data.stoken;
      const title: string = tokenResp.data.data.title || '';
      console.log(
        '[UCPanService] resolveShareToFiles: shareId=',
        shareId,
        'title=',
        title,
        'stoken length=',
        stoken.length,
      );

      const files: Array<{
        fid: string;
        fileName: string;
        size: number;
        shareId: string;
        stoken: string;
      }> = [];
      const videoExtRegex =
        /\.(mp4|mkv|ts|avi|mov|flv|webm|m4v|mpg|mpeg|3gp|m3u8)$/i;

      const listDir = async (pdirFid: string, depth: number): Promise<void> => {
        if (depth > 3) return;
        let page = 1;
        while (true) {
          const detailUrl =
            'https://pc-api.uc.cn/1/clouddrive/share/sharepage/detail?pr=UCBrowser&fr=pc' +
            `&pwd_id=${encodeURIComponent(shareId)}` +
            `&stoken=${encodeURIComponent(stoken)}` +
            `&pdir_fid=${encodeURIComponent(pdirFid)}` +
            `&_page=${page}&_size=50`;
          const detailResp = await axios.get(detailUrl, {
            headers,
            timeout: 15000,
          });
          const dData = detailResp.data;
          if (dData?.code !== 0) {
            console.warn(
              '[UCPanService] detail API error at pdir=',
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
            if (item.dir) {
              await listDir(item.fid, depth + 1);
            } else if (videoExtRegex.test(item.file_name || '')) {
              files.push({
                fid: item.fid,
                fileName: item.file_name,
                size: item.size || 0,
                shareId,
                stoken,
              });
            }
          }
          const meta = dData?.data?.metadata;
          const total = meta?._total ?? list.length;
          if (page * 50 >= total) break;
          page++;
        }
      };

      await listDir('0', 0);
      console.log(
        '[UCPanService] resolveShareToFiles: found',
        files.length,
        'video files for shareId=',
        shareId,
      );
      return { success: true, title, files };
    } catch (e: any) {
      console.error('[UCPanService] resolveShareToFiles error:', e.message);
      return {
        success: false,
        error: `${e.message} (status: ${e.response?.status || 'unknown'})`,
      };
    }
  }

  /**
   * Resolve a UC share file to a streaming URL.
   *
   * Same transfer-then-play flow as QuarkPanService.resolveQuarkDownloadUrl.
   */
  static async resolveDownloadUrl(
    shareId: string,
    fid: string,
  ): Promise<string | null> {
    if (!this.syncedCookie) {
      console.warn('[UCPanService] resolveDownloadUrl: no synced cookie');
      return null;
    }

    const cacheKey = `${shareId}:${fid}`;
    const cached = this.playUrlCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.log('[UCPanService] resolveDownloadUrl: cache hit for', cacheKey);
      return cached.playUrl;
    }

    const headers = this.buildHeaders();

    try {
      const tokenResp = await axios.post(
        'https://pc-api.uc.cn/1/clouddrive/share/sharepage/token?pr=UCBrowser&fr=pc',
        { pwd_id: shareId, passcode: '', support_visit_limit_private_share: true },
        { headers, timeout: 15000 },
      );
      if (tokenResp.data?.code !== 0 || !tokenResp.data?.data?.stoken) {
        console.warn(
          '[UCPanService] resolveDownloadUrl: token API failed:',
          tokenResp.data?.message,
        );
        return null;
      }
      const stoken: string = tokenResp.data.data.stoken;

      // Try direct download first.
      const downloadResp = await axios.post(
        'https://pc-api.uc.cn/1/clouddrive/file/download?pr=UCBrowser&fr=pc',
        { fids: [fid], pwd_id: shareId, stoken },
        { headers, timeout: 15000, validateStatus: () => true },
      );
      if (downloadResp.data?.code === 0 && downloadResp.data?.data?.[0]?.download_url) {
        const url: string = downloadResp.data.data[0].download_url;
        console.log(
          '[UCPanService] resolveDownloadUrl: direct download OK, length=',
          url.length,
        );
        this.playUrlCache.set(cacheKey, {
          playUrl: url,
          expiresAt: Date.now() + 5 * 3600 * 1000,
          transferredFid: '',
        });
        return url;
      }

      if (downloadResp.data?.code !== 23018) {
        console.warn(
          '[UCPanService] resolveDownloadUrl: download API failed:',
          downloadResp.data?.message,
          '(code:',
          downloadResp.data?.code,
          ')',
        );
        return null;
      }
      console.log(
        '[UCPanService] resolveDownloadUrl: hit size limit (23018), falling back to transfer-then-play',
      );

      const tvboxFid = await this.findOrCreateTvboxFolder(headers);
      if (!tvboxFid) return null;
      void this.cleanupOldTransfers(headers, tvboxFid);

      const taskId = await this.transferShareFile(
        headers,
        shareId,
        fid,
        stoken,
        tvboxFid,
      );
      if (!taskId) return null;

      const newFid = await this.pollTransferTask(headers, taskId);
      if (!newFid) return null;

      const playUrl = await this.fetchPlayUrl(headers, newFid);
      if (!playUrl) return null;

      this.playUrlCache.set(cacheKey, {
        playUrl,
        expiresAt: Date.now() + 5 * 3600 * 1000,
        transferredFid: newFid,
      });
      const transferredFid = newFid;
      setTimeout(
        () => {
          void this.deleteFile(headers, transferredFid);
          this.playUrlCache.delete(cacheKey);
        },
        6 * 3600 * 1000,
      );

      console.log(
        '[UCPanService] resolveDownloadUrl: got play URL via transfer, length=',
        playUrl.length,
      );
      return playUrl;
    } catch (e: any) {
      console.error('[UCPanService] resolveDownloadUrl error:', e.message);
      return null;
    }
  }

  private static async findOrCreateTvboxFolder(
    headers: Record<string, string>,
  ): Promise<string | null> {
    if (this.tvboxFolderFid) return this.tvboxFolderFid;
    try {
      const listResp = await axios.get(
        'https://pc-api.uc.cn/1/clouddrive/file/sort?pr=UCBrowser&fr=pc&pdir_fid=0&_page=1&_size=200&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,updated_at:desc',
        { headers, timeout: 15000, validateStatus: () => true },
      );
      const list = listResp.data?.data?.list || [];
      for (const item of list) {
        if (item.dir && item.file_name === 'TVBox') {
          this.tvboxFolderFid = item.fid;
          return this.tvboxFolderFid;
        }
      }
      const createResp = await axios.post(
        'https://pc-api.uc.cn/1/clouddrive/file?pr=UCBrowser&fr=pc',
        { pdir_fid: '0', file_name: 'TVBox', dir_path: '', dir: true },
        { headers, timeout: 15000, validateStatus: () => true },
      );
      if (createResp.data?.code === 0 && createResp.data?.data?.fid) {
        this.tvboxFolderFid = createResp.data.data.fid;
        return this.tvboxFolderFid;
      }
      return null;
    } catch (e: any) {
      console.error('[UCPanService] findOrCreateTvboxFolder error:', e.message);
      return null;
    }
  }

  private static async transferShareFile(
    headers: Record<string, string>,
    shareId: string,
    sourceFid: string,
    stoken: string,
    todirFid: string,
  ): Promise<string | null> {
    try {
      const resp = await axios.post(
        'https://pc-api.uc.cn/1/clouddrive/share/sharepage/save?pr=UCBrowser&fr=pc',
        {
          fid_list: [sourceFid],
          fid_token: stoken,
          todir_fid: todirFid,
          pwd_id: shareId,
          stoken,
        },
        { headers, timeout: 15000, validateStatus: () => true },
      );
      if (resp.data?.code === 0 && resp.data?.data?.task_id) {
        return resp.data.data.task_id;
      }
      console.warn(
        '[UCPanService] transferShareFile failed:',
        resp.data?.message,
        '(code:',
        resp.data?.code,
        ')',
      );
      return null;
    } catch (e: any) {
      console.error('[UCPanService] transferShareFile error:', e.message);
      return null;
    }
  }

  private static async pollTransferTask(
    headers: Record<string, string>,
    taskId: string,
  ): Promise<string | null> {
    for (let i = 0; i < 30; i++) {
      try {
        const resp = await axios.get(
          `https://pc-api.uc.cn/1/clouddrive/task?pr=UCBrowser&fr=pc&task_id=${taskId}`,
          { headers, timeout: 10000, validateStatus: () => true },
        );
        const data = resp.data?.data;
        const status = data?.status;
        const topFids = data?.save_as?.save_as_top_fids;
        if (status === 2 && Array.isArray(topFids) && topFids.length > 0) {
          console.log(
            '[UCPanService] pollTransferTask: completed after',
            i,
            'polls, new fid=',
            topFids[0],
          );
          return topFids[0];
        }
        if (status === 4 || status === 3) return null;
        await new Promise((r) => setTimeout(r, 500));
      } catch (e: any) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return null;
  }

  private static async fetchPlayUrl(
    headers: Record<string, string>,
    fid: string,
  ): Promise<string | null> {
    try {
      const resp = await axios.post(
        'https://pc-api.uc.cn/1/clouddrive/file/v2/play?pr=UCBrowser&fr=pc',
        { fid },
        { headers, timeout: 15000, validateStatus: () => true },
      );
      if (resp.data?.code !== 0) {
        console.warn(
          '[UCPanService] fetchPlayUrl: API failed:',
          resp.data?.message,
          '(code:',
          resp.data?.code,
          ')',
        );
        return null;
      }
      const videoList = resp.data?.data?.video_list || [];
      const isMp4 = (v: any) => {
        const fmt = String(v?.video_info?.format || '').toLowerCase();
        return !fmt.includes('m3u8');
      };
      const pick =
        videoList.find(
          (v: any) =>
            v?.video_info?.url && v?.accessable !== false && isMp4(v),
        ) ||
        videoList.find(
          (v: any) => v?.video_info?.url && v?.accessable !== false,
        ) ||
        videoList.find((v: any) => v?.video_info?.url);
      const url: string | undefined = pick?.video_info?.url;
      if (!url) return null;
      console.log(
        '[UCPanService] fetchPlayUrl: got URL, resolution=',
        pick?.resolution,
        'length=',
        url.length,
      );
      return url;
    } catch (e: any) {
      console.error('[UCPanService] fetchPlayUrl error:', e.message);
      return null;
    }
  }

  private static async deleteFile(
    headers: Record<string, string>,
    fid: string,
  ): Promise<void> {
    try {
      await axios.post(
        'https://pc-api.uc.cn/1/clouddrive/file/delete?pr=UCBrowser&fr=pc',
        { action_type: 2, task_list: [{ fid, delete: true }] },
        { headers, timeout: 15000, validateStatus: () => true },
      );
    } catch (e: any) {
      console.warn('[UCPanService] deleteFile error:', e.message);
    }
  }

  private static async cleanupOldTransfers(
    headers: Record<string, string>,
    tvboxFid: string,
  ): Promise<void> {
    try {
      const resp = await axios.get(
        `https://pc-api.uc.cn/1/clouddrive/file/sort?pr=UCBrowser&fr=pc&pdir_fid=${encodeURIComponent(tvboxFid)}&_page=1&_size=50&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,updated_at:desc`,
        { headers, timeout: 15000, validateStatus: () => true },
      );
      const list = resp.data?.data?.list || [];
      const now = Date.now();
      const sixHoursMs = 6 * 3600 * 1000;
      for (const item of list) {
        if (item.dir) continue;
        const updatedAt = item.l_updated_at || item.updated_at || 0;
        if (updatedAt && now - updatedAt > sixHoursMs) {
          await this.deleteFile(headers, item.fid);
        }
      }
    } catch (e: any) {
      console.warn('[UCPanService] cleanupOldTransfers error:', e.message);
    }
  }
}
