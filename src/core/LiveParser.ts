import axios from 'axios';
import type { LiveChannelGroup, LiveChannelItem, EpgInfo } from './models';

// ─── EPG data ────────────────────────────────────────────────────────────────

export interface EpgData {
  channelName: string;
  programs: EpgInfo[];
}

export class EpgLoader {
  /**
   * Load EPG from a URL, returning a map of channel display-name → EpgData.
   */
  static async load(epgUrl: string): Promise<Map<string, EpgData>> {
    try {
      const { data } = await axios.get(epgUrl, {
        responseType: 'text',
        timeout: 30000,
      });
      return this.loadXml(typeof data === 'string' ? data : String(data));
    } catch (e) {
      console.error('[EpgLoader] Failed to load EPG:', e);
      return new Map();
    }
  }

  /**
   * Parse XMLTV format EPG XML content.
   *
   * Structure:
   * <tv>
   *   <channel id="CCTV1"><display-name>CCTV-1</display-name></channel>
   *   <programme start="20240101060000 +0800" stop="20240101070000 +0800" channel="CCTV1">
   *     <title>新闻联播</title>
   *   </programme>
   * </tv>
   */
  static async loadXml(content: string): Promise<Map<string, EpgData>> {
    const result = new Map<string, EpgData>();

    // Map channel id → display-name(s)
    const channelIdToNames = new Map<string, string[]>();

    // Parse <channel> elements
    const channelRegex = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g;
    let chMatch: RegExpExecArray | null;
    while ((chMatch = channelRegex.exec(content)) !== null) {
      const id = chMatch[1];
      const body = chMatch[2];
      const names: string[] = [];
      const nameRegex = /<display-name[^>]*>([^<]+)<\/display-name>/g;
      let nameMatch: RegExpExecArray | null;
      while ((nameMatch = nameRegex.exec(body)) !== null) {
        names.push(nameMatch[1].trim());
      }
      if (names.length > 0) {
        channelIdToNames.set(id, names);
      }
    }

    // Build channel name → EpgData mapping
    for (const [_id, names] of channelIdToNames) {
      for (const name of names) {
        if (!result.has(name)) {
          result.set(name, { channelName: name, programs: [] });
        }
      }
    }

    // Parse <programme> elements
    const progRegex = /<programme\s+([^>]+)>([\s\S]*?)<\/programme>/g;
    let progMatch: RegExpExecArray | null;
    while ((progMatch = progRegex.exec(content)) !== null) {
      const attrs = progMatch[1];
      const body = progMatch[2];

      const channelMatch = attrs.match(/channel="([^"]+)"/);
      const startMatch = attrs.match(/start="([^"]+)"/);
      const stopMatch = attrs.match(/stop="([^"]+)"/);
      if (!channelMatch || !startMatch || !stopMatch) continue;

      const channelId = channelMatch[1];
      const start = this.formatEpgTime(startMatch[1]);
      const end = this.formatEpgTime(stopMatch[1]);

      const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/);
      const title = titleMatch ? titleMatch[1].trim() : '';

      const names = channelIdToNames.get(channelId);
      if (names) {
        for (const name of names) {
          const epg = result.get(name);
          if (epg) {
            epg.programs.push({ title, start, end });
          }
        }
      }
    }

    // Sort programs by start time within each channel
    for (const epg of result.values()) {
      epg.programs.sort((a, b) => a.start.localeCompare(b.start));
    }

    return result;
  }

  /**
   * Format XMLTV timestamp like "20240101060000 +0800" → "2024-01-01 06:00:00"
   */
  private static formatEpgTime(raw: string): string {
    // Remove whitespace and timezone
    const cleaned = raw.replace(/\s*\+\d{4}/, '').trim();
    if (cleaned.length >= 14) {
      return (
        `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)} ` +
        `${cleaned.slice(8, 10)}:${cleaned.slice(10, 12)}:${cleaned.slice(12, 14)}`
      );
    }
    return raw;
  }
}

// ─── Live URL wrapping ───────────────────────────────────────────────────────

/**
 * Wrap a live URL into proxy format like Android TVBox:
 * base64Encode(url) → http://127.0.0.1:9978/proxy?do=live&type=txt&ext={base64}
 */
export function wrapLiveUrl(liveUrl: string, port: number = 9978): string {
  const ext = urlSafeBase64Encode(liveUrl);
  return `http://127.0.0.1:${port}/proxy?do=live&type=txt&ext=${ext}`;
}

/**
 * Decode the `ext` parameter from a live proxy URL back to the original URL.
 */
export function unwrapLiveUrl(ext: string): string {
  return urlSafeBase64Decode(ext);
}

// ─── Base64 helpers (URL-safe) ───────────────────────────────────────────────

function urlSafeBase64Encode(str: string): string {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function urlSafeBase64Decode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // Pad with '=' to make length a multiple of 4
  const pad = base64.length % 4;
  if (pad === 2) base64 += '==';
  else if (pad === 3) base64 += '=';
  return Buffer.from(base64, 'base64').toString('utf-8');
}

// ─── LiveParser ──────────────────────────────────────────────────────────────

export class LiveParser {
  /**
   * Parse a live source URL, auto-detecting the format.
   */
  static async parse(url: string): Promise<LiveChannelGroup[]> {
    try {
      // Handle proxy:// URLs
      if (url.startsWith('proxy://')) {
        url = this.resolveProxyUrl(url);
      }

      const { data } = await axios.get(url, {
        responseType: 'text',
        timeout: 30000,
      });
      const text = typeof data === 'string' ? data : String(data);

      if (url.toLowerCase().includes('.m3u')) {
        return this.parseM3uContent(text);
      }
      return this.parseTxtContent(text);
    } catch (e) {
      console.error('[LiveParser] Failed to parse live source:', e);
      return [];
    }
  }

  // ── TXT format ─────────────────────────────────────────────────────────

  /**
   * Parse standard TVBox live txt format.
   *
   * Format:
   *   CCTV1,http://example.com/cctv1.m3u8
   *   频道名$url$源名,http://example.com/stream.m3u8$源2
   *   分组名,#genre#
   *   加密分组_密码,#genre#
   *   CCTV5,http://example.com/cctv5.m3u8
   */
  static parseTxtContent(text: string): LiveChannelGroup[] {
    const groups: LiveChannelGroup[] = [];
    let currentGroup: LiveChannelGroup | null = null;
    let groupIndex = 0;
    let channelIndex = 0;

    const lines = text.split('\n');
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      // Genre/group marker: "分组名,#genre#" or "加密分组_密码,#genre#"
      if (line.includes(',#genre#')) {
        const rawName = line.split(',')[0].trim();
        const underscoreIdx = rawName.indexOf('_');
        let groupName = rawName;
        let groupPassword: string | undefined;

        if (underscoreIdx > 0) {
          groupName = rawName.substring(0, underscoreIdx);
          groupPassword = rawName.substring(underscoreIdx + 1);
        }

        currentGroup = {
          groupName,
          groupPassword,
          groupIndex: groupIndex++,
          channels: [],
        };
        groups.push(currentGroup);
        continue;
      }

      // Channel line: "频道名,url" or "频道名,url1$url2$..."
      const commaIdx = line.indexOf(',');
      if (commaIdx < 0) continue;

      const rawName = line.substring(0, commaIdx).trim();
      const rawUrl = line.substring(commaIdx + 1).trim();
      if (!rawUrl) continue;

      // Parse channel name: may contain $url$sourceName format
      // "频道名$url$源名" means: name has embedded source info
      // But actually the $url$ part is in the URL section, not the name.
      // Standard format: channelName,url1$sourceName1$url2$sourceName2
      const channelName = rawName;

      // Parse URLs: each URL may be followed by $sourceName
      // Multiple URLs separated by $ where odd positions are source names
      // e.g. "http://a.m3u8$源1$http://b.m3u8$源2"
      const urls: string[] = [];
      const sourceNames: string[] = [];

      const parts = rawUrl.split('$');
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i].trim();
        if (!part) continue;
        if (i % 2 === 0) {
          // Even index → URL
          urls.push(part);
        } else {
          // Odd index → source name for the previous URL
          sourceNames.push(part);
        }
      }

      // If there are no source names, ensure sourceNames array matches urls length
      while (sourceNames.length < urls.length) {
        sourceNames.push('');
      }

      const channelItem: LiveChannelItem = {
        channelName,
        channelIndex: channelIndex++,
        channelNum: channelIndex,
        channelUrls: urls,
        channelSourceNames: sourceNames,
      };

      if (currentGroup) {
        currentGroup.channels.push(channelItem);
      } else {
        // No genre declared yet → create default group
        currentGroup = {
          groupName: '未分类',
          groupIndex: groupIndex++,
          channels: [],
        };
        groups.push(currentGroup);
        currentGroup.channels.push(channelItem);
      }
    }

    return groups;
  }

  // ── M3U format ─────────────────────────────────────────────────────────

  /**
   * Parse M3U format:
   * #EXTM3U
   * #EXTINF:-1 tvg-id="cctv1" tvg-name="CCTV1" tvg-logo="http://logo.png" group-title="央视",CCTV-1
   * http://example.com/cctv1.m3u8
   */
  static parseM3uContent(text: string): LiveChannelGroup[] {
    const groupsMap = new Map<string, LiveChannelGroup>();
    let groupIndex = 0;
    let channelIndex = 0;

    const lines = text.split('\n');
    let currentName = '';
    let currentGroup = '未分类';
    let currentLogo = '';
    let currentTvgId = '';
    let currentTvgName = '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('#EXTINF:')) {
        // Extract tvg-id
        const tvgIdMatch = line.match(/tvg-id="([^"]*)"/);
        currentTvgId = tvgIdMatch ? tvgIdMatch[1] : '';

        // Extract tvg-name
        const tvgNameMatch = line.match(/tvg-name="([^"]*)"/);
        currentTvgName = tvgNameMatch ? tvgNameMatch[1] : '';

        // Extract tvg-logo
        const logoMatch = line.match(/tvg-logo="([^"]*)"/);
        currentLogo = logoMatch ? logoMatch[1] : '';

        // Extract group-title
        const groupMatch = line.match(/group-title="([^"]*)"/);
        currentGroup = groupMatch ? groupMatch[1] : '未分类';

        // Extract name (after last comma)
        const commaIdx = line.lastIndexOf(',');
        currentName =
          commaIdx >= 0
            ? line.substring(commaIdx + 1).trim()
            : currentTvgName || 'Unknown';
        if (!currentName && currentTvgName) {
          currentName = currentTvgName;
        }
      } else if (!line.startsWith('#')) {
        // URL line
        const url = line.trim();
        if (!url) continue;

        if (!groupsMap.has(currentGroup)) {
          groupsMap.set(currentGroup, {
            groupName: currentGroup,
            groupIndex: groupIndex++,
            channels: [],
          });
        }

        const group = groupsMap.get(currentGroup)!;
        group.channels.push({
          channelName: currentName,
          channelIndex: channelIndex++,
          channelNum: channelIndex,
          channelUrls: [url],
          channelSourceNames: [''],
        });

        // Reset for next entry
        currentGroup = '未分类';
        currentName = '';
        currentLogo = '';
        currentTvgId = '';
        currentTvgName = '';
      }
    }

    return Array.from(groupsMap.values());
  }

  // ── FongMi format ──────────────────────────────────────────────────────

  /**
   * Parse FongMi live format from config's lives section:
   * { "type": "0", "url": "http://...", "epg": "http://...", "playerType": 1 }
   *
   * Returns the extracted url, epg, and playerType.
   */
  static parseFongMiFormat(livesObj: any): {
    url: string;
    epg?: string;
    playerType?: number;
  } {
    if (!livesObj || typeof livesObj !== 'object') {
      return { url: '' };
    }

    const url: string = livesObj.url || '';
    const epg: string | undefined = livesObj.epg || undefined;
    const playerType: number | undefined =
      livesObj.playerType != null ? Number(livesObj.playerType) : undefined;

    return { url, epg, playerType };
  }

  // ── proxy:// format ────────────────────────────────────────────────────

  /**
   * Parse proxy:// format:
   * { "url": "proxy://do=live&type=txt&ext=aHR0cDovL..." }
   *
   * Extracts the `ext` query parameter and base64-decodes it to get the real URL.
   */
  static parseProxyFormat(livesObj: any): string {
    if (!livesObj || typeof livesObj !== 'object') {
      return '';
    }

    const rawUrl: string = livesObj.url || '';
    if (!rawUrl.startsWith('proxy://')) {
      return rawUrl;
    }

    return this.resolveProxyUrl(rawUrl);
  }

  /**
   * Resolve a proxy:// URL by extracting the `ext` parameter and decoding it.
   */
  static resolveProxyUrl(proxyUrl: string): string {
    try {
      // proxy://do=live&type=txt&ext=aHR0cDovL...
      const queryPart = proxyUrl.replace('proxy://', '');
      const params = new URLSearchParams(queryPart);
      const ext = params.get('ext');
      if (ext) {
        return urlSafeBase64Decode(ext);
      }
    } catch (e) {
      console.error('[LiveParser] Failed to resolve proxy URL:', e);
    }
    return proxyUrl;
  }
}
