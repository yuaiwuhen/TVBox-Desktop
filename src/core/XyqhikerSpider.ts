/**
 * XYQHiker Spider - XPath-like rule parser for TVBox
 *
 * XYQHiker uses XPath-like syntax to extract content from HTML:
 * - //element[@attr='value'] - XPath selector
 * - /text() - text content
 * - /@attr - attribute value
 * - Json.parse - parse JSON data
 */

import type { ISpider } from './models';

interface XYQHikerRules {
  分类url?: string;
  分类?: string;
  分类名?: string;
  一级?: string;
  一级url?: string;
  一级标题?: string;
  一级图片?: string;
  一级描述?: string;
  二级url?: string;
  二级标题?: string;
  二级图片?: string;
  二级描述?: string;
  搜索url?: string;
  [key: string]: any;
}

interface SourceBean {
  key: string;
  name: string;
  api: string;
  ext?: string | XYQHikerRules;
  type?: number;
}

/**
 * Fetch HTML content via main process IPC
 */
async function fetchHtml(url: string, headers?: Record<string, string>): Promise<string> {
  const ipc = (window as any).electronIPC;
  if (!ipc) {
    throw new Error('electronIPC not available');
  }

  const result = await ipc.invoke('http:fetchHtml', {
    url,
    headers: headers || {},
    timeout: 30000,
  });

  if (!result.success) {
    throw new Error(result.error || 'Unknown error');
  }

  return result.data;
}

/**
 * Parse XPath-like expression and extract from HTML
 * Simplified XPath implementation for common patterns
 */
function xpathExtract(html: string, xpath: string): string[] {
  const results: string[] = [];

  // Handle Json.parse for JSON data
  if (xpath.includes('Json.parse')) {
    try {
      // Extract JSON from HTML
      const jsonMatch = html.match(/<script[^>]*>\s*(?:var\s+\w+\s*=\s*)?({[\s\S]*?})\s*<\/script>/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[1]);
        // Navigate JSON path
        const jsonPath = xpath.replace(/.*Json\.parse\((\w+)\)\./, '$1.');
        const value = navigateJsonPath(data, jsonPath);
        if (value) results.push(value);
      }
    } catch (e) {
      console.error('[XyqhikerSpider] Json.parse error:', e);
    }
    return results;
  }

  // Handle XPath-like selectors: //element[@attr='value']
  const xpathMatch = xpath.match(/\/\/(\w+)(?:\[@(\w+)=['"]([^'"]+)['"]\])?(?:\/(\w+)(?:\[@(\w+)=['"]([^'"]+)['"]\])?)*/);
  if (!xpathMatch) {
    return results;
  }

  // Simple regex-based extraction for common patterns
  // This is a simplified implementation - a full XPath parser would be more complex

  // Pattern: //element[@attr='value']
  const elementMatch = xpath.match(/\/\/(\w+)(?:\[@(\w+)=['"]([^'"]+)['"]\])?/);
  if (elementMatch) {
    const element = elementMatch[1];
    const attr = elementMatch[2];
    const value = elementMatch[3];

    if (attr && value) {
      // Find elements with specific attribute value
      const pattern = new RegExp(`<${element}[^>]*${attr}=['"]${escapeRegex(value)}['"][^>]*>(.*?)<\/${element}>`, 'gis');
      const matches = html.matchAll(pattern);
      for (const match of matches) {
        results.push(match[1]);
      }
    } else {
      // Find all elements
      const pattern = new RegExp(`<${element}[^>]*>(.*?)<\/${element}>`, 'gis');
      const matches = html.matchAll(pattern);
      for (const match of matches) {
        results.push(match[1]);
      }
    }
  }

  // Handle /text() and /@attr
  if (xpath.includes('/text()')) {
    return results.map(r => r.replace(/<[^>]+>/g, '').trim());
  }

  if (xpath.includes('/@')) {
    const attrMatch = xpath.match(/\/@(\w+)/);
    if (attrMatch) {
      const attr = attrMatch[1];
      return results.map(r => {
        const attrPattern = new RegExp(`${attr}=['"]([^'"]+)['"]`);
        const m = r.match(attrPattern);
        return m ? m[1] : '';
      });
    }
  }

  return results;
}

/**
 * Navigate JSON path like "data.list.0.name"
 */
function navigateJsonPath(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (!current) return null;
    if (part.match(/^\d+$/)) {
      current = current[parseInt(part)];
    } else {
      current = current[part];
    }
  }
  return current;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class XyqhikerSpider implements ISpider {
  private key: string;
  private name: string;
  private rules: XYQHikerRules;
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

    // Extract base URL from 分类url
    if (this.rules.分类url) {
      try {
        const url = new URL(this.rules.分类url);
        this.baseUrl = url.origin;
      } catch {
        this.baseUrl = '';
      }
    }

    console.log(`[XyqhikerSpider] Created: ${this.key}`, {
      name: this.name,
      baseUrl: this.baseUrl,
    });
  }

  async init(extend: string): Promise<void> {
    console.log(`[XyqhikerSpider] Initialized: ${this.key}`);
  }

  async homeContent(filter: boolean): Promise<string> {
    const url = this.rules.分类url;
    if (!url) {
      return JSON.stringify({ list: [], class: [], filters: {} });
    }

    try {
      const html = await fetchHtml(url);

      // Parse categories
      const categories: any[] = [];
      if (this.rules.分类) {
        const cats = this.rules.分类.split('#');
        const names = (this.rules.分类名 || '').split('#');
        for (let i = 0; i < cats.length; i++) {
          categories.push({
            type_id: cats[i],
            type_name: names[i] || cats[i],
          });
        }
      }

      // Parse video list (一级 rules)
      const videos = await this.parseVideoList(html);

      return JSON.stringify({
        list: videos,
        class: categories,
        filters: {},
      });
    } catch (e) {
      console.error(`[XyqhikerSpider] homeContent error:`, e);
      return JSON.stringify({ list: [], class: [], filters: {} });
    }
  }

  async homeVideoContent(): Promise<string> {
    return JSON.stringify({ list: [] });
  }

  private async parseVideoList(html: string): Promise<any[]> {
    if (!this.rules.一级) return [];

    const items = xpathExtract(html, this.rules.一级);
    const videos: any[] = [];

    for (const item of items) {
      const video: any = {
        vod_id: '',
        vod_name: '',
        vod_pic: '',
        vod_remarks: '',
      };

      if (this.rules.一级url) {
        const urls = xpathExtract(item, this.rules.一级url);
        video.vod_id = urls[0] || '';
      }

      if (this.rules.一级标题) {
        const titles = xpathExtract(item, this.rules.一级标题);
        video.vod_name = titles[0] || '';
      }

      if (this.rules.一级图片) {
        const imgs = xpathExtract(item, this.rules.一级图片);
        video.vod_pic = imgs[0] || '';
        if (video.vod_pic && !video.vod_pic.startsWith('http')) {
          video.vod_pic = this.baseUrl + video.vod_pic;
        }
      }

      if (this.rules.一级描述) {
        const descs = xpathExtract(item, this.rules.一级描述);
        video.vod_remarks = descs[0] || '';
      }

      if (video.vod_name) {
        videos.push(video);
      }
    }

    return videos;
  }

  async categoryContent(
    tid: string,
    pg: string,
    filter: boolean,
    extend: Record<string, string>,
  ): Promise<string> {
    const urlTemplate = this.rules.分类url;
    if (!urlTemplate) {
      return JSON.stringify({ list: [], count: 0 });
    }

    const url = urlTemplate
      .replace('{cateId}', tid)
      .replace('{catePg}', pg);

    try {
      const html = await fetchHtml(url);
      const videos = await this.parseVideoList(html);
      return JSON.stringify({
        list: videos,
        count: videos.length,
        page: parseInt(pg) || 1,
      });
    } catch (e) {
      console.error(`[XyqhikerSpider] categoryContent error:`, e);
      return JSON.stringify({ list: [], count: 0 });
    }
  }

  async detailContent(ids: string[]): Promise<string> {
    // Simplified - full implementation would parse detail page
    return JSON.stringify({
      list: ids.map(id => ({
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

    const url = this.rules.搜索url
      .replace('{wd}', encodeURIComponent(key))
      .replace('{pg}', pg || '1');

    try {
      const html = await fetchHtml(url);
      const videos = await this.parseVideoList(html);
      return JSON.stringify({ list: videos });
    } catch (e) {
      console.error(`[XyqhikerSpider] searchContent error:`, e);
      return JSON.stringify({ list: [] });
    }
  }

  async playerContent(
    flag: string,
    id: string,
    vipFlags: string[],
  ): Promise<string> {
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
    console.log(`[XyqhikerSpider] Destroyed: ${this.key}`);
  }
}