/**
 * XBPQ Spider - XPath-based rule parser for TVBox
 *
 * XBPQ uses a special string extraction syntax:
 * - "开始标记&&结束标记" extracts content between markers
 * - "属性名=\"&&\"" extracts attribute value
 * - "替换:old>>new" replaces text
 */

import type { ISpider } from './models';

interface XBPQRules {
  请求头?: string;
  编码?: string;
  主页url?: string;
  二次截取?: string;
  数组?: string;
  标题?: string;
  图片?: string;
  副标题?: string;
  链接?: string;
  线路数组?: string;
  线路标题?: string;
  播放数组?: string;
  播放列表?: string;
  播放链接?: string;
  播放标题?: string;
  搜索模式?: string;
  搜索url?: string;
  简介?: string;
  分类url?: string;
  分类?: string;
  [key: string]: any;
}

interface SourceBean {
  key: string;
  name: string;
  api: string;
  ext?: string | XBPQRules;
  type?: number;
}

/**
 * Extract content using XBPQ rule syntax
 * Rule format: "startMarker&&endMarker" or "attr=\"&&\""
 * Modifiers: "替换:old>>new"
 */
function extractByRule(html: string, rule: string): string {
  if (!rule || !html) return '';

  // Handle replacement modifier
  const replaceMatch = rule.match(/替换:(.+?)>>(.+?)(?:$|\||\+)/);
  let replaceOld = '';
  let replaceNew = '';
  if (replaceMatch) {
    replaceOld = replaceMatch[1];
    replaceNew = replaceMatch[2];
    rule = rule.replace(/替换:.+?>>.+?(\+|$)/, '');
  }

  // Handle prefix/suffix modifiers (✨+...)
  const prefixMatch = rule.match(/^[^+]+\+/);
  let prefix = '';
  if (prefixMatch) {
    prefix = prefixMatch[0].replace(/\+$/, '');
    rule = rule.substring(prefixMatch[0].length);
  }

  // Split by && for start/end markers
  const parts = rule.split('&&');
  if (parts.length < 2) {
    return rule; // Not a rule, return as-is
  }

  const startMarker = parts[0];
  const endMarker = parts[1];

  // Find start position
  let startIdx = html.indexOf(startMarker);
  if (startIdx === -1) return '';
  startIdx += startMarker.length;

  // Find end position
  let endIdx = html.indexOf(endMarker, startIdx);
  if (endIdx === -1) return '';

  let result = html.substring(startIdx, endIdx);

  // Apply replacement
  if (replaceOld && replaceNew) {
    result = result.replace(new RegExp(replaceOld, 'g'), replaceNew);
  }

  // Apply prefix
  if (prefix) {
    result = prefix + result;
  }

  return result.trim();
}

/**
 * Extract array of items from HTML
 */
function extractArray(
  html: string,
  arrayRule: string,
  itemEndRule?: string,
): string[] {
  if (!arrayRule || !html) return [];

  const parts = arrayRule.split('&&');
  if (parts.length < 2) return [];

  const startMarker = parts[0];
  const endMarker = parts[1];

  const items: string[] = [];
  let searchStart = 0;

  while (true) {
    const startIdx = html.indexOf(startMarker, searchStart);
    if (startIdx === -1) break;

    let endIdx: number;
    if (itemEndRule) {
      // Use custom end marker for each item
      const endParts = itemEndRule.split('&&');
      if (endParts.length >= 2) {
        endIdx = html.indexOf(endParts[1], startIdx + startMarker.length);
      } else {
        endIdx = html.indexOf(endMarker, startIdx + startMarker.length);
      }
    } else {
      endIdx = html.indexOf(endMarker, startIdx + startMarker.length);
    }

    if (endIdx === -1) break;

    items.push(html.substring(startIdx, endIdx + endMarker.length));
    searchStart = endIdx + endMarker.length;
  }

  return items;
}

/**
 * Parse HTTP headers from rule string
 * Format: "Header1$Value1#Header2$Value2"
 */
function parseHeaders(headerRule: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!headerRule) return headers;

  const parts = headerRule.split('#');
  for (const part of parts) {
    const [name, value] = part.split('$');
    if (name && value) {
      headers[name.trim()] = value.trim();
    }
  }

  return headers;
}

/**
 * Replace placeholders in URL template
 * Format: "url/{param1}/{param2}.html"
 */
function formatUrl(
  template: string,
  params: Record<string, string | number>,
): string {
  let url = template;
  for (const [key, value] of Object.entries(params)) {
    url = url.replace(`{${key}}`, String(value));
  }
  return url;
}

export class XbpqSpider implements ISpider {
  private key: string;
  private name: string;
  private rules: XBPQRules;
  private baseUrl: string;

  constructor(source: SourceBean) {
    this.key = source.key;
    this.name = source.name;

    // Parse ext as rules
    if (typeof source.ext === 'string') {
      try {
        this.rules = JSON.parse(source.ext);
      } catch {
        this.rules = {};
      }
    } else {
      this.rules = source.ext || {};
    }

    // Extract base URL from 主页url
    if (this.rules.主页url) {
      try {
        const url = new URL(this.rules.主页url);
        this.baseUrl = url.origin;
      } catch {
        this.baseUrl = '';
      }
    }

    console.log(`[XbpqSpider] Created: ${this.key}`, {
      name: this.name,
      homeUrl: this.rules.主页url,
      categories: this.rules.分类,
    });
  }

  async init(extend: string): Promise<void> {
    // Rules already parsed in constructor
    console.log(`[XbpqSpider] Initialized: ${this.key}`);
  }

  /**
   * Fetch HTML content from URL
   */
  private async fetchHtml(url: string): Promise<string> {
    const headers = parseHeaders(this.rules.请求头 || '');
    if (!headers['User-Agent']) {
      headers['User-Agent'] =
        'Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36';
    }

    console.log(`[XbpqSpider] Fetching: ${url}`, { headers });

    try {
      // Use Electron's net module to bypass SSL issues
      const response = await fetch(url, {
        headers,
        redirect: 'follow',
        // @ts-ignore - Electron's fetch supports these options
        useElectronNet: true,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      console.log(`[XbpqSpider] Fetched ${html.length} bytes from ${url}`);
      if (html.length < 500) {
        console.log(`[XbpqSpider] Content preview: ${html}`);
      }
      return html;
    } catch (e) {
      console.error(`[XbpqSpider] Fetch error for ${url}:`, e);
      return '';
    }
  }

  /**
   * Parse video list from HTML
   */
  private parseVideoList(html: string): any[] {
    // Apply 二次截取 if defined
    if (this.rules.二次截取) {
      html = extractByRule(html, this.rules.二次截取);
    }

    if (!this.rules.数组) {
      console.warn('[XbpqSpider] No 数组 rule defined');
      return [];
    }

    const items = extractArray(
      html,
      this.rules.数组,
      this.rules.数组?.split('&&')[1],
    );
    console.log(`[XbpqSpider] Found ${items.length} items`);

    const videos: any[] = [];
    for (const itemHtml of items) {
      const video: any = {
        vod_id: '',
        vod_name: '',
        vod_pic: '',
        vod_remarks: '',
      };

      // Extract fields
      if (this.rules.标题) {
        video.vod_name = extractByRule(itemHtml, this.rules.标题);
      }
      if (this.rules.图片) {
        video.vod_pic = extractByRule(itemHtml, this.rules.图片);
        // Fix relative URLs
        if (video.vod_pic && !video.vod_pic.startsWith('http')) {
          video.vod_pic = this.baseUrl + video.vod_pic;
        }
      }
      if (this.rules.副标题) {
        video.vod_remarks = extractByRule(itemHtml, this.rules.副标题);
      }
      if (this.rules.链接) {
        video.vod_id = extractByRule(itemHtml, this.rules.链接);
      } else {
        // Try to extract link from common patterns
        const hrefMatch = itemHtml.match(/href="([^"]+)"/);
        if (hrefMatch) {
          video.vod_id = hrefMatch[1];
        }
      }

      if (video.vod_name) {
        videos.push(video);
      }
    }

    return videos;
  }

  async homeContent(filter: boolean): Promise<string> {
    const url = this.rules.主页url;
    if (!url) {
      return JSON.stringify({ list: [], class: [], filters: {} });
    }

    const html = await this.fetchHtml(url);
    const videos = this.parseVideoList(html);

    // Parse categories
    const categories: any[] = [];
    if (this.rules.分类) {
      const cats = this.rules.分类.split('#');
      for (const cat of cats) {
        const [name, id] = cat.split('$');
        if (name && id) {
          categories.push({
            type_id: id,
            type_name: name,
          });
        }
      }
    }

    const result = {
      list: videos,
      class: categories,
      filters: {},
    };

    return JSON.stringify(result);
  }

  async homeVideoContent(): Promise<string> {
    return JSON.stringify({ list: [] });
  }

  async categoryContent(
    tid: string,
    pg: string,
    filter: boolean,
    extend: Record<string, string>,
  ): Promise<string> {
    if (!this.rules.分类url) {
      return JSON.stringify({ list: [], count: 0 });
    }

    const url = formatUrl(this.rules.分类url, {
      cateId: tid,
      catePg: pg,
    });

    const html = await this.fetchHtml(url);
    const videos = this.parseVideoList(html);

    return JSON.stringify({
      list: videos,
      count: videos.length,
      page: parseInt(pg) || 1,
    });
  }

  async detailContent(ids: string[]): Promise<string> {
    // XBPQ detail parsing is complex, return basic info
    console.log(`[XbpqSpider] detailContent for ${ids.length} IDs`);

    // For now, return empty - full implementation would parse detail page
    return JSON.stringify({
      list: ids.map((id) => ({
        vod_id: id,
        vod_name: '',
        vod_play_from: '',
        vod_play_url: '',
      })),
    });
  }

  async searchContent(
    key: string,
    quick: boolean,
    pg?: string,
  ): Promise<string> {
    if (!this.rules.搜索url) {
      return JSON.stringify({ list: [] });
    }

    const url = formatUrl(this.rules.搜索url, {
      wd: encodeURIComponent(key),
      pg: pg || '1',
    });

    const html = await this.fetchHtml(url);
    const videos = this.parseVideoList(html);

    return JSON.stringify({ list: videos });
  }

  async playerContent(
    flag: string,
    id: string,
    vipFlags: string[],
  ): Promise<string> {
    // XBPQ player parsing would require detail page parsing
    return JSON.stringify({
      parse: 0,
      url: id,
      header: '',
    });
  }

  async isVideoFormat(url: string): Promise<boolean> {
    return false;
  }

  async manualVideoCheck(): Promise<boolean> {
    return false;
  }

  async action(actionId: string, actionData: any): Promise<string> {
    return '';
  }

  destroy(): void {
    console.log(`[XbpqSpider] Destroyed: ${this.key}`);
  }
}
