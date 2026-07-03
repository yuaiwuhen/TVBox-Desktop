import axios from 'axios';
import * as cheerio from 'cheerio';
import type {
  SourceBean,
  ISpider,
  Movie,
  MovieSort,
  SpiderHomeResult,
  SpiderDetailResult,
  PlayResult,
} from './models';

// ─── JSON path evaluator ──────────────────────────────────────────────────────

/**
 * Resolve a dot-notation path on an object.
 * e.g. "data.list" on {data: {list: [...]}} returns the array.
 */
function jsonPath(obj: any, path: string): any {
  if (obj == null || !path) return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// ─── URL template expansion ────────────────────────────────────────────────────

/**
 * Expand a URL template by replacing {key} placeholders with values.
 * Known keys: {cateId}, {catePg}, {vid}, {wd}, {playUrl}
 */
function expandUrl(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, key: string) => vars[key] || '');
}

// ─── Selector-based value extraction ───────────────────────────────────────────

/**
 * Extract a value from content (JSON object, HTML string, or plain text)
 * according to a rule string. Supported prefixes:
 *   json:path.to.field  — JSON dot-path
 *   css:selector         — CSS selector (cheerio), returns text
 *   css:selector@attr    — CSS selector, returns attribute value
 *   xpath://expr         — basic XPath (limited)
 *   regex:pattern        — regex, first capture group
 *   /pattern/flags       — alternative regex format
 *   (bare string)        — literal key name for JSON, or text content for HTML
 */
function extractValue(content: any, rule: string, baseUrl?: string): string {
  if (!rule) return '';
  const r = rule.trim();

  // json: prefix
  if (r.startsWith('json:')) {
    const path = r.substring(5);
    const obj = typeof content === 'string' ? safeParseJson(content) : content;
    const val = jsonPath(obj, path);
    if (val == null) return '';
    return typeof val === 'object' ? JSON.stringify(val) : String(val);
  }

  // css: prefix
  if (r.startsWith('css:')) {
    const expr = r.substring(4);
    const html =
      typeof content === 'string' ? content : JSON.stringify(content);
    return cssExtract(html, expr, baseUrl);
  }

  // xpath: prefix
  if (r.startsWith('xpath:')) {
    const expr = r.substring(6);
    const html =
      typeof content === 'string' ? content : JSON.stringify(content);
    return xpathExtract(html, expr);
  }

  // regex: prefix
  if (r.startsWith('regex:')) {
    const pattern = r.substring(6);
    return regexExtract(
      String(typeof content === 'string' ? content : JSON.stringify(content)),
      pattern,
    );
  }

  // /pattern/flags format
  if (r.startsWith('/') && r.lastIndexOf('/') > 0) {
    return regexExtract(
      String(typeof content === 'string' ? content : JSON.stringify(content)),
      r,
    );
  }

  // Default: treat as a JSON key path on the content object
  const obj = typeof content === 'string' ? safeParseJson(content) : content;
  if (obj != null && typeof obj === 'object') {
    const val = jsonPath(obj, r);
    if (val != null)
      return typeof val === 'object' ? JSON.stringify(val) : String(val);
  }

  // Last resort: return content as-is if it's a string
  if (typeof content === 'string') return content;
  return '';
}

/**
 * Extract a list of elements from content according to a node selector rule.
 * Returns an array of sub-objects or sub-HTML strings.
 */
function extractNodeList(content: any, nodeRule: string): any[] {
  if (!nodeRule) return [];
  const r = nodeRule.trim();

  // json: prefix — return the array at the path
  if (r.startsWith('json:')) {
    const path = r.substring(5);
    const obj = typeof content === 'string' ? safeParseJson(content) : content;
    const arr = jsonPath(obj, path);
    return Array.isArray(arr) ? arr : [];
  }

  // css: prefix — return array of outer HTML for each matched element
  if (r.startsWith('css:')) {
    const selector = r.substring(4);
    const html =
      typeof content === 'string' ? content : JSON.stringify(content);
    try {
      const $ = cheerio.load(html);
      const results: string[] = [];
      $(selector).each((_i, el) => {
        results.push($(el).toString());
      });
      return results;
    } catch {
      return [];
    }
  }

  // Default: treat as JSON path
  const obj = typeof content === 'string' ? safeParseJson(content) : content;
  if (obj != null) {
    const arr = jsonPath(obj, r);
    return Array.isArray(arr) ? arr : [];
  }

  return [];
}

// ─── CSS extraction ────────────────────────────────────────────────────────────

function cssExtract(html: string, expr: string, baseUrl?: string): string {
  try {
    const $ = cheerio.load(html);
    // Support "selector@attr" syntax — default attr is text
    const atIndex = expr.lastIndexOf('@');
    let selector = expr;
    let attr: string | null = null;

    if (atIndex > 0) {
      selector = expr.substring(0, atIndex);
      attr = expr.substring(atIndex + 1);
    }

    const el = $(selector).first();
    if (!el.length) return '';

    if (attr === null || attr === 'text') return el.text().trim();
    if (attr === 'html' || attr === 'innerHtml') return el.html() || '';
    if (attr === 'href' || attr === 'src') {
      const val = el.attr(attr) || '';
      return val && baseUrl ? joinUrl(baseUrl, val) : val;
    }
    return el.attr(attr) || '';
  } catch {
    return '';
  }
}

// ─── Basic XPath extraction ────────────────────────────────────────────────────

/**
 * Minimal XPath support — handles common patterns used in TVBox configs:
 *   //tag[@attr='value']/subtag
 *   //tag/@attr
 *   //tag/text()
 */
function xpathExtract(html: string, expr: string): string {
  try {
    const $ = cheerio.load(html);

    // Normalize: strip leading xpath: if accidentally double-prefixed
    let xp = expr.trim();

    // Try to convert simple XPath to CSS + attr extraction
    // Pattern: //tag[@attr='value']/subtag/@attr  or  //tag/text()
    const attrMatch = xp.match(/\/@(\w+)$/);
    const textMatch = xp.match(/\/text\(\)$/);
    let targetAttr: string | null = null;
    let wantText = false;

    if (attrMatch) {
      targetAttr = attrMatch[1];
      xp = xp.substring(0, xp.length - attrMatch[0].length);
    } else if (textMatch) {
      wantText = true;
      xp = xp.substring(0, xp.length - '/text()'.length);
    }

    // Convert XPath to CSS selector
    const cssSelector = xpathToCss(xp);
    if (!cssSelector) return '';

    const el = $(cssSelector).first();
    if (!el.length) return '';

    if (targetAttr) return el.attr(targetAttr) || '';
    if (wantText) return el.text().trim();
    return el.text().trim();
  } catch {
    return '';
  }
}

/**
 * Convert a simple XPath expression to a CSS selector.
 * Handles: //tag, //tag[@attr='val'], //tag/subtag, //tag[@class='x']/subtag
 */
function xpathToCss(xp: string): string {
  let result = '';
  const segments = xp.split('/').filter(Boolean); // split and remove empties

  for (const seg of segments) {
    if (!seg) continue;

    // //tag[@attr='value']  →  tag[attr="value"]
    const attrMatch = seg.match(/^(\w+)\[@(\w+)=['"]([^'"]+)['"]\]$/);
    if (attrMatch) {
      const tag = attrMatch[1];
      const attrName = attrMatch[2];
      const attrVal = attrMatch[3];
      result += (result ? ' ' : '') + `${tag}[${attrName}="${attrVal}"]`;
      continue;
    }

    // //tag  →  tag
    if (seg.startsWith('//')) {
      result += seg.substring(2);
      continue;
    }

    // plain tag name
    result += (result ? ' ' : '') + seg;
  }

  return result;
}

// ─── Regex extraction ──────────────────────────────────────────────────────────

function regexExtract(text: string, pattern: string): string {
  try {
    let re: RegExp;
    // /pattern/flags format
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      const lastSlash = pattern.lastIndexOf('/');
      const expr = pattern.substring(1, lastSlash);
      const flags = pattern.substring(lastSlash + 1);
      re = new RegExp(expr, flags);
    } else {
      // regex: prefix already stripped, treat as raw pattern
      re = new RegExp(pattern);
    }
    const m = text.match(re);
    if (m) {
      // Return first capture group if it exists, otherwise full match
      return m[1] !== undefined ? m[1] : m[0];
    }
    return '';
  } catch {
    return '';
  }
}

// ─── Utility helpers ───────────────────────────────────────────────────────────

function safeParseJson(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function joinUrl(parent: string, child: string): string {
  if (!child) return '';
  if (/^https?:\/\//i.test(child)) return child;
  if (child.startsWith('//')) return 'https:' + child;
  if (child.startsWith('/')) {
    try {
      const base = new URL(parent);
      return base.origin + child;
    } catch {
      return child;
    }
  }
  try {
    return new URL(child, parent).href;
  } catch {
    return child;
  }
}

// ─── Rule interface ────────────────────────────────────────────────────────────

interface JsonRules {
  categories?: string; // "电影$movie#电视剧$tv"
  homeUrl?: string;
  cateUrl?: string;
  cateVodNode?: string;
  cateVodName?: string;
  cateVodId?: string;
  cateVodImg?: string;
  cateVodImgMark?: string;
  cateVodMark?: string;
  detailUrl?: string;
  detailVodNode?: string;
  detailVodName?: string;
  detailVodId?: string;
  detailVodImg?: string;
  detailVodMark?: string;
  detailVodPlayFrom?: string;
  detailVodPlayUrl?: string;
  detailVodContent?: string;
  searchUrl?: string;
  scVodNode?: string;
  scVodName?: string;
  scVodId?: string;
  scVodImg?: string;
  scVodMark?: string;
  playUrl?: string;
  playParse?: string;
  ua?: string;
  // extend fields sometimes present
  [key: string]: any;
}

// ─── JsonRuleParser ────────────────────────────────────────────────────────────

export class JsonRuleParser implements ISpider {
  private source: SourceBean;
  private rules: JsonRules = {};
  private sourceType: number; // 0=XML/XPath, 1=JSON, 2=Mix
  private baseUrl: string = '';

  constructor(source: SourceBean) {
    this.source = source;
    this.sourceType = source.type;
  }

  // ── ISpider interface ────────────────────────────────────────────────

  async init(extend: string): Promise<void> {
    // Parse the ext JSON string into the rule object
    const extStr = extend || this.source.ext || '';
    console.log(
      `[JsonRuleParser] init: key=${this.source.key}, type=${this.source.type}, api=${this.source.api}, ext=${extStr.substring(0, 200)}`,
    );
    if (extStr) {
      try {
        const parsed = JSON.parse(extStr);
        if (parsed && typeof parsed === 'object') {
          this.rules = parsed as JsonRules;
          console.log(
            `[JsonRuleParser] parsed ext rules: homeUrl=${this.rules.homeUrl}, categories=${this.rules.categories}, cateVodNode=${this.rules.cateVodNode}`,
          );
        }
      } catch {
        // ext might be a plain URL or other format
        // If it looks like a URL, treat as homeUrl fallback
        if (extStr.startsWith('http')) {
          this.rules.homeUrl = extStr;
        }
      }
    }

    // ── mac/vod API auto-configuration (type=1) ──
    // For standard mac/vod JSON API: detect and set up default rules
    if (
      this.sourceType === 1 &&
      this.source.api &&
      /^https?:\/\//i.test(this.source.api)
    ) {
      if (!this.rules.homeUrl) {
        this.rules.homeUrl = this.source.api;
      }
      if (!this.rules.cateUrl) {
        this.rules.cateUrl =
          this.source.api + '?ac=videolist&t={cateId}&pg={catePg}';
      }
      if (!this.rules.detailUrl) {
        this.rules.detailUrl = this.source.api + '?ac=detail&ids={vid}';
      }
      if (!this.rules.searchUrl) {
        this.rules.searchUrl =
          this.source.api + '?ac=videolist&wd={wd}&pg={catePg}';
      }
      console.log(
        `[JsonRuleParser] mac/vod API auto-config: homeUrl=${this.rules.homeUrl}, cateUrl=${this.rules.cateUrl}, detailUrl=${this.rules.detailUrl}`,
      );
    }

    // Derive base URL from homeUrl or cateUrl for resolving relative paths
    this.baseUrl = this.rules.homeUrl || this.source.api || '';
    try {
      const u = new URL(this.baseUrl);
      this.baseUrl = u.origin;
    } catch {
      // keep as-is
    }
  }

  async homeContent(_filter: boolean): Promise<string> {
    try {
      const homeUrl = this.rules.homeUrl || this.source.api || '';
      console.log(
        `[JsonRuleParser] homeContent: key=${this.source.key}, type=${this.sourceType}, homeUrl=${homeUrl}`,
      );
      if (!homeUrl) return JSON.stringify({ class: [], list: [] });

      const html = await this.fetchPage(homeUrl);
      let parsed: any = safeParseJson(html);
      console.log(
        `[JsonRuleParser] homeContent: fetched ${html.length} chars from ${homeUrl}`,
      );
      console.log(`[JsonRuleParser] homeContent: parsed content:`, parsed);

      // Build categories from API response (Box Android format: "class" field)
      let classes: MovieSort[] = [];
      if (parsed && parsed.class && Array.isArray(parsed.class)) {
        classes = parsed.class
          .map((c: any) => ({
            type_id: String(c.type_id ?? c.id ?? ''),
            type_name: String(c.type_name ?? c.name ?? ''),
          }))
          .filter((c: MovieSort) => c.type_id && c.type_name);
        console.log(
          `[JsonRuleParser] homeContent: parsed ${classes.length} categories from API response`,
        );
      }

      // If no categories from API, try rules.categories string
      if (classes.length === 0) {
        classes = this.parseCategories();
      }

      // Parse video list using cateVod* rules (fall back to scVod* or direct)
      const nodeRule =
        this.rules.cateVodNode || this.rules.scVodNode || 'json:list';
      let items = extractNodeList(parsed || html, nodeRule);

      // mac/vod API fallback: when response is { code, list, page, pagecount, total }
      if (items.length === 0 && parsed && Array.isArray(parsed.list)) {
        items = parsed.list;
      }

      // If categories are still empty, aggregate from the video list (mac/vod API)
      if (classes.length === 0 && items.length > 0) {
        const seen = new Map<string, string>();
        for (const it of items) {
          if (it && typeof it === 'object') {
            const tid = String(it.type_id ?? '');
            const tname = String(it.type_name ?? it.type_id ?? '');
            if (tid && !seen.has(tid)) {
              seen.set(tid, tname);
            }
          }
        }
        classes = Array.from(seen.entries()).map(([tid, tname]) => ({
          type_id: tid,
          type_name: tname,
        }));
        classes.sort((a, b) => Number(a.type_id) - Number(b.type_id));
      }

      console.log(
        `[JsonRuleParser] homeContent: nodeRule=${nodeRule}, items=${items.length}, classes=${classes.length}`,
      );

      const list: Movie[] = [];
      for (const item of items) {
        list.push(this.extractMovie(item, 'cate', homeUrl));
      }

      const result: SpiderHomeResult = { class: classes, list };
      return JSON.stringify(result);
    } catch (e) {
      console.error('[JsonRuleParser] homeContent error:', e);
      return JSON.stringify({ class: [], list: [] });
    }
  }

  async homeVideoContent(): Promise<string> {
    // Same as homeContent but only returns the list, no categories
    try {
      const homeUrl = this.rules.homeUrl || this.source.api || '';
      if (!homeUrl) return JSON.stringify({ list: [] });

      const html = await this.fetchPage(homeUrl);
      const parsed = safeParseJson(html);

      const nodeRule =
        this.rules.cateVodNode || this.rules.scVodNode || 'json:list';
      let items = extractNodeList(parsed || html, nodeRule);

      // mac/vod API fallback
      if (items.length === 0 && parsed && Array.isArray(parsed.list)) {
        items = parsed.list;
      }

      const list: Movie[] = [];
      for (const item of items) {
        list.push(this.extractMovie(item, 'cate', homeUrl));
      }

      let page = 1;
      let pagecount = 1;
      let total = 0;
      if (parsed && typeof parsed === 'object') {
        page = parsed.page || 1;
        pagecount = parsed.pagecount || parsed.pageCount || 1;
        total = parsed.total || 0;
      }

      return JSON.stringify({ list, page, pagecount, total });
    } catch (e) {
      console.error('[JsonRuleParser] homeVideoContent error:', e);
      return JSON.stringify({ list: [] });
    }
  }

  async categoryContent(
    tid: string,
    pg: string,
    filter: boolean,
    extend: Record<string, string>,
  ): Promise<string> {
    try {
      const cateTpl = this.rules.cateUrl || this.rules.homeUrl || '';
      if (!cateTpl) return JSON.stringify({ list: [], page: pg, pagecount: 1 });

      // Build URL from template
      const vars: Record<string, string> = {
        cateId: tid,
        catePg: pg,
        ...extend,
      };
      // Also support {cateId} being referenced as the tid directly
      const url = expandUrl(cateTpl, vars);

      console.log(
        `[JsonRuleParser] categoryContent: tid=${tid}, pg=${pg}, url=${url}`,
      );

      const html = await this.fetchPage(url);
      const parsed = safeParseJson(html);

      const nodeRule =
        this.rules.cateVodNode || this.rules.scVodNode || 'json:list';
      const items = extractNodeList(parsed || html, nodeRule);

      console.log(
        `[JsonRuleParser] categoryContent: nodeRule=${nodeRule}, items=${items.length}`,
      );

      const list: Movie[] = [];
      for (const item of items) {
        list.push(this.extractMovie(item, 'cate', url));
      }

      // Try to get pagination info from JSON response
      let page = parseInt(pg, 10) || 1;
      let pageCount = 1;
      let total = 0;
      if (parsed && typeof parsed === 'object') {
        pageCount =
          parsed.pagecount || parsed.pageCount || parsed.page_count || 1;
        total = parsed.total || 0;
        page = parsed.page || page;
      }

      console.log(
        `[JsonRuleParser] categoryContent: list=${list.length}, page=${page}, pagecount=${pageCount}, total=${total}`,
      );

      return JSON.stringify({ list, page, pagecount: pageCount, total });
    } catch (e) {
      console.error('[JsonRuleParser] categoryContent error:', e);
      return JSON.stringify({ list: [], page: pg, pagecount: 1 });
    }
  }

  async detailContent(ids: string[]): Promise<string> {
    try {
      const id = ids[0] || '';
      if (!id) return JSON.stringify({ list: [] });

      const detailTpl = this.rules.detailUrl || '';
      if (!detailTpl) return JSON.stringify({ list: [] });

      const url = expandUrl(detailTpl, { vid: id });

      console.log(`[JsonRuleParser] detailContent: id=${id}, url=${url}`);

      const html = await this.fetchPage(url);
      const parsed = safeParseJson(html);

      // Extract detail node
      const nodeRule = this.rules.detailVodNode || 'json:';
      let detailObj: any;

      if (nodeRule && nodeRule !== 'json:') {
        const nodes = extractNodeList(parsed || html, nodeRule);
        detailObj = nodes.length > 0 ? nodes[0] : parsed || {};
      } else {
        // If no detailVodNode, the whole response is the detail
        detailObj = parsed || {};
        // Or check for common wrapper: {data: {...}} or {list: [...]}
        if (
          detailObj.data &&
          typeof detailObj.data === 'object' &&
          !Array.isArray(detailObj.data)
        ) {
          detailObj = detailObj.data;
        } else if (Array.isArray(detailObj.list) && detailObj.list.length > 0) {
          detailObj = detailObj.list[0];
        }
      }

      const movie = this.extractMovie(detailObj, 'detail', url);

      // Extract play sources
      if (this.rules.detailVodPlayFrom) {
        const rawFrom = extractValue(
          detailObj,
          this.rules.detailVodPlayFrom,
          url,
        );
        movie.vod_play_from = rawFrom;
      }
      if (this.rules.detailVodPlayUrl) {
        const rawUrl = extractValue(
          detailObj,
          this.rules.detailVodPlayUrl,
          url,
        );
        movie.vod_play_url = rawUrl;
      }
      if (this.rules.detailVodContent) {
        const rawContent = extractValue(
          detailObj,
          this.rules.detailVodContent,
          url,
        );
        movie.vod_content = rawContent;
      }

      movie.sourceKey = this.source.key;

      console.log(
        `[JsonRuleParser] detailContent: vod_name=${movie.vod_name}, vod_id=${movie.vod_id}, vod_play_from=${movie.vod_play_from}`,
      );

      const result: SpiderDetailResult = { list: [movie] };
      return JSON.stringify(result);
    } catch (e) {
      console.error('[JsonRuleParser] detailContent error:', e);
      return JSON.stringify({ list: [] });
    }
  }

  async searchContent(
    key: string,
    quick: boolean,
    pg?: string,
  ): Promise<string> {
    try {
      const searchTpl = this.rules.searchUrl || '';
      if (!searchTpl) return JSON.stringify({ list: [] });

      const vars: Record<string, string> = { wd: key };
      if (pg) vars.pg = pg;
      const url = expandUrl(searchTpl, vars);

      const html = await this.fetchPage(url);
      const parsed = safeParseJson(html);

      const nodeRule =
        this.rules.scVodNode || this.rules.cateVodNode || 'json:list';
      const items = extractNodeList(parsed || html, nodeRule);

      const list: Movie[] = [];
      for (const item of items) {
        list.push(this.extractMovie(item, 'sc', url));
      }

      return JSON.stringify({ list });
    } catch (e) {
      console.error('[JsonRuleParser] searchContent error:', e);
      return JSON.stringify({ list: [] });
    }
  }

  async playerContent(
    flag: string,
    id: string,
    vipFlags: string[],
  ): Promise<string> {
    try {
      // Type 2 (Mix): support playParse
      if (
        this.sourceType === 2 &&
        this.rules.playParse === '1' &&
        this.rules.playUrl
      ) {
        // Build play URL from template
        const playTpl = this.rules.playUrl;
        const url = expandUrl(playTpl, { playUrl: id });

        // For type 2, we may need to fetch the play page and extract the video URL
        const html = await this.fetchPage(url);

        // Try to find a direct video URL in the response
        const videoRegex =
          /https?:\/\/[^\s"'<>]+?\.(m3u8|mp4|flv|mkv|ts)(\?[^\s"'<>]*)?/i;
        const match = html.match(videoRegex);

        if (match) {
          const result: PlayResult = { parse: 0, url: match[0] };
          return JSON.stringify(result);
        }

        // If we can't find a direct URL, return the play page URL for VIP parsing
        const result: PlayResult = { parse: 1, url };
        return JSON.stringify(result);
      }

      // Type 0/1 or no playParse: return the ID directly
      // If playUrl template exists (without playParse), expand it
      if (this.rules.playUrl) {
        const url = expandUrl(this.rules.playUrl, { playUrl: id });
        const result: PlayResult = { parse: 0, url };
        return JSON.stringify(result);
      }

      // Default: direct play, no parsing needed
      const result: PlayResult = { parse: 0, url: id };
      return JSON.stringify(result);
    } catch (e) {
      console.error('[JsonRuleParser] playerContent error:', e);
      const result: PlayResult = { parse: 0, url: id };
      return JSON.stringify(result);
    }
  }

  async isVideoFormat(url: string): Promise<boolean> {
    return /\.(m3u8|mp4|flv|mkv|ts|mov|avi|wmv|3gp|webm)(\?.*)?$/i.test(url);
  }

  async manualVideoCheck(): Promise<boolean> {
    return false;
  }

  destroy(): void {
    this.rules = {};
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  /**
   * Fetch a page and return its content as text.
   * For JSON APIs, the response is typically already parsed by axios.
   * Note: User-Agent and other forbidden headers are filtered by browsers,
   * so we only set allowed custom headers.
   */
  private async fetchPage(url: string): Promise<string> {
    console.log(`[JsonRuleParser] fetchPage: url=${url}`);
    const headers: Record<string, string> = {};
    // Only set custom UA when running in Node (Electron main process)
    // Browser will silently drop the header
    if (this.rules.ua) {
      headers['User-Agent'] = this.rules.ua;
    }

    const resp = await axios.get(url, {
      headers,
      responseType: 'text',
      timeout: 15000,
    });

    const content =
      typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    console.log(
      `[JsonRuleParser] fetchPage: status=${resp.status}, length=${content.length}`,
    );

    return content;
  }

  /**
   * Parse the categories string from rules.
   * Format: "电影$movie#电视剧$tv#综艺$variety"
   * Each item is split by '#', then name$id split by '$'
   */
  private parseCategories(): MovieSort[] {
    const classes: MovieSort[] = [];
    const catStr = this.rules.categories || '';
    if (!catStr) return classes;

    const items = catStr.split('#');
    for (const item of items) {
      const parts = item.split('$', 2);
      if (parts.length === 2) {
        classes.push({ type_id: parts[1].trim(), type_name: parts[0].trim() });
      } else if (parts.length === 1 && parts[0].trim()) {
        classes.push({ type_id: parts[0].trim(), type_name: parts[0].trim() });
      }
    }

    return classes;
  }

  /**
   * Extract a Movie object from a parsed item using the given rule prefix.
   * prefix is 'cate', 'detail', or 'sc' — determines which rules to use.
   */
  private extractMovie(item: any, prefix: string, baseUrl: string): Movie {
    const movie: Movie = {
      vod_id: '',
      vod_name: '',
    };

    const idRule = (this.rules as any)[`${prefix}VodId`] || '';
    const nameRule = (this.rules as any)[`${prefix}VodName`] || '';
    const imgRule = (this.rules as any)[`${prefix}VodImg`] || '';
    const markRule = (this.rules as any)[`${prefix}VodMark`] || '';

    if (idRule) {
      movie.vod_id = extractValue(item, idRule, baseUrl);
    } else if (item && typeof item === 'object') {
      // Default keys
      movie.vod_id = String(item.vod_id ?? item.id ?? '');
    }

    if (nameRule) {
      movie.vod_name = extractValue(item, nameRule, baseUrl);
    } else if (item && typeof item === 'object') {
      movie.vod_name = String(item.vod_name ?? item.name ?? item.title ?? '');
    }

    if (imgRule) {
      movie.vod_pic = extractValue(item, imgRule, baseUrl);
    } else if (item && typeof item === 'object') {
      movie.vod_pic = String(item.vod_pic ?? item.pic ?? '');
    }

    if (markRule) {
      movie.vod_remarks = extractValue(item, markRule, baseUrl);
    } else if (item && typeof item === 'object') {
      movie.vod_remarks = String(item.vod_remarks ?? item.note ?? '');
    }

    // For detail prefix, also extract common fields from the item directly
    if (prefix === 'detail' && item && typeof item === 'object') {
      if (!movie.vod_year) movie.vod_year = String(item.vod_year ?? '');
      if (!movie.vod_area) movie.vod_area = String(item.vod_area ?? '');
      if (!movie.vod_actor) movie.vod_actor = String(item.vod_actor ?? '');
      if (!movie.vod_director)
        movie.vod_director = String(item.vod_director ?? '');
      if (!movie.type_name) movie.type_name = String(item.type_name ?? '');
      if (!movie.vod_lang) movie.vod_lang = String(item.vod_lang ?? '');
      if (!movie.vod_content)
        movie.vod_content = String(item.vod_content ?? '');
      if (!movie.vod_play_from)
        movie.vod_play_from = String(item.vod_play_from ?? '');
      if (!movie.vod_play_url)
        movie.vod_play_url = String(item.vod_play_url ?? '');
    }

    // Resolve relative image URLs
    if (movie.vod_pic && baseUrl) {
      movie.vod_pic = joinUrl(baseUrl, movie.vod_pic);
    }

    return movie;
  }
}
