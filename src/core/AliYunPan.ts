import axios from 'axios';

/**
 * TVBox Native AliYunPan integration equivalent
 * This handles the token refresh, QR code login, and direct file extraction
 */
export class AliYunPan {
  private static refreshToken: string =
    localStorage.getItem('ali_refresh_token') || '';
  private static accessToken: string = '';
  private static driveId: string = '';

  static async init(token: string) {
    if (token && token.length > 0) {
      this.refreshToken = token;
      localStorage.setItem('ali_refresh_token', token);
    }
    await this.refreshAccessToken();
  }

  private static async refreshAccessToken() {
    if (!this.refreshToken) return;

    try {
      const { data } = await axios.post(
        'https://auth.aliyundrive.com/v2/account/token',
        {
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
        },
      );

      this.accessToken = data.access_token;
      this.refreshToken = data.refresh_token;
      this.driveId = data.default_drive_id;

      localStorage.setItem('ali_refresh_token', this.refreshToken);
    } catch (e) {
      console.error('AliYunPan token refresh failed', e);
    }
  }

  /**
   * Resolves an alipan:// or https://www.aliyundrive.com/s/xxx share link
   * into a direct playable URL.
   */
  static async resolveShareLink(shareUrl: string): Promise<string | null> {
    if (!this.accessToken) {
      await this.refreshAccessToken();
      if (!this.accessToken) throw new Error('阿里云盘未登录或Token失效');
    }

    // TVBox logic:
    // 1. Extract share ID from URL
    // 2. Fetch share token using share ID
    // 3. Fetch file list in the shared folder
    // 4. Get download/play URL for the video file

    // TODO: Implement the full Alibaba Cloud API flow
    // (share_id -> share_token -> file_id -> download_url).
    // Returning null signals "no playable URL" so the caller can surface
    // an appropriate error instead of a fake placeholder URL.
    console.warn(
      '[AliYunPan] resolveShareLink not implemented — returning null',
    );
    return null;
  }
}
