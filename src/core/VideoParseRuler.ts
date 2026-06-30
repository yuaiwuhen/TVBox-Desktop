import type { ParseRule } from './models';

/**
 * Port of Android VideoParseRuler.java
 * Manages host-based sniffing rules from config for video URL detection and filtering.
 */
export class VideoParseRuler {
  // host -> list of rule arrays (OR-combined), each rule array is AND-combined regexes
  private static hostRules: Map<string, string[][]> = new Map();
  // host -> list of filter arrays (OR-combined), each filter array is AND-combined regexes
  private static hostFilters: Map<string, string[][]> = new Map();
  // host -> list of ad-related regex patterns
  private static hostRegex: Map<string, string[]> = new Map();
  // host -> list of script strings
  private static hostScripts: Map<string, string[]> = new Map();

  // Cached compiled regex patterns for performance
  private static regexCache: Map<string, RegExp> = new Map();

  static clearRules(): void {
    VideoParseRuler.hostRules.clear();
    VideoParseRuler.hostFilters.clear();
    VideoParseRuler.hostRegex.clear();
    VideoParseRuler.hostScripts.clear();
    VideoParseRuler.regexCache.clear();
  }

  /**
   * Load sniffing rules from config's "rules" array.
   * Mirrors Android ApiConfig.parseJson rules processing.
   */
  static loadFromConfig(rules: ParseRule[]): void {
    VideoParseRuler.clearRules();

    for (const rule of rules) {
      // {host, rule:[...]} or {host, filter:[...]}
      if (rule.host) {
        if (rule.rule && rule.rule.length > 0) {
          VideoParseRuler.addHostRule(rule.host, rule.rule);
        }
        if (rule.filter && rule.filter.length > 0) {
          VideoParseRuler.addHostFilter(rule.host, rule.filter);
        }
      }

      // {hosts:[...], regex:[...]} - split regex into ads vs video rules
      if (rule.hosts && rule.regex) {
        const videoRules: string[] = [];
        const adsRules: string[] = [];
        for (const regex of rule.regex) {
          if (VideoParseRuler.isAdRegex(regex)) {
            adsRules.push(regex);
          } else {
            videoRules.push(regex);
          }
        }
        for (const host of rule.hosts) {
          if (videoRules.length > 0) {
            VideoParseRuler.addHostRule(host, videoRules);
          }
          if (adsRules.length > 0) {
            VideoParseRuler.addHostRegex(host, adsRules);
          }
        }
      }

      // {hosts:[...], script:[...]}
      if (rule.hosts && rule.script) {
        for (const host of rule.hosts) {
          VideoParseRuler.addHostScript(host, rule.script);
        }
      }
    }
  }

  /**
   * Check if a URL is a video URL, using sniffing rules if standard format check fails.
   * @param pageUrl The page URL (used to look up host-specific rules)
   * @param url The request URL to check
   */
  static isVideoUrl(pageUrl: string, url: string): boolean {
    try {
      // First check standard video formats
      let isVideo = VideoParseRuler.isVideoFormat(url);
      if (!isVideo && pageUrl) {
        const host = VideoParseRuler.getHostFromUrl(pageUrl);
        if (host) {
          if (VideoParseRuler.hostRules.has(host)) {
            isVideo = VideoParseRuler.checkRulesForHost(host, url);
          } else {
            // Fallback to wildcard host
            isVideo = VideoParseRuler.checkRulesForHost('*', url);
          }
        }
      }
      return isVideo;
    } catch {
      return false;
    }
  }

  /**
   * Check if a URL should be filtered (excluded) based on filter rules.
   */
  static isFiltered(pageUrl: string, url: string): boolean {
    try {
      if (!pageUrl) return false;
      const host = VideoParseRuler.getHostFromUrl(pageUrl);
      if (!host) return false;

      const filters = VideoParseRuler.hostFilters.get(host);
      if (!filters || filters.length === 0) return false;

      return VideoParseRuler.checkFilterRulesForHost(host, url);
    } catch {
      return false;
    }
  }

  /**
   * Get the first script associated with a URL's matching host.
   */
  static getScript(url: string): string {
    for (const [host, scripts] of VideoParseRuler.hostScripts.entries()) {
      if (url.includes(host) && scripts.length > 0) {
        return scripts[0];
      }
    }
    return '';
  }

  /**
   * Get all ad regex patterns, keyed by host.
   */
  static getAdRegexes(): Map<string, string[]> {
    return new Map(VideoParseRuler.hostRegex);
  }

  /**
   * Get a combined RegExp for ad patterns matching a specific host.
   * Used by M3u8Purifier for strategy 1 ad segment filtering.
   */
  static getHostsRegex(host: string): RegExp | null {
    const patterns = VideoParseRuler.hostRegex.get(host);
    if (!patterns || patterns.length === 0) return null;
    const combined = patterns.map((p) => `(?:${p})`).join('|');
    try {
      return new RegExp(combined, 'i');
    } catch {
      return null;
    }
  }

  // --- Private helpers ---

  private static addHostRule(host: string, rule: string[]): void {
    if (!rule || rule.length === 0) return;
    const rules = VideoParseRuler.hostRules.get(host) || [];
    rules.push([...rule]);
    VideoParseRuler.hostRules.set(host, rules);
  }

  private static addHostFilter(host: string, filter: string[]): void {
    if (!filter || filter.length === 0) return;
    const filters = VideoParseRuler.hostFilters.get(host) || [];
    filters.push([...filter]);
    VideoParseRuler.hostFilters.set(host, filters);
  }

  private static addHostRegex(host: string, regex: string[]): void {
    if (!regex || regex.length === 0) return;
    const existing = VideoParseRuler.hostRegex.get(host) || [];
    VideoParseRuler.hostRegex.set(host, [...existing, ...regex]);
  }

  private static addHostScript(host: string, scripts: string[]): void {
    if (!scripts || scripts.length === 0) return;
    const existing = VideoParseRuler.hostScripts.get(host) || [];
    VideoParseRuler.hostScripts.set(host, [...existing, ...scripts]);
  }

  /**
   * Check if a regex string is ad-related (mirrors Android M3U8.isAd).
   * Ad regexes contain M3U8 tags or are numeric duration values.
   */
  private static isAdRegex(regex: string): boolean {
    return (
      regex.includes('#EXT-X-DISCONTINUITY') ||
      regex.includes('#EXTINF') ||
      regex.includes('#EXT-X-ENDLIST') ||
      regex.includes('#EXT-X-KEY') ||
      VideoParseRuler.isNumeric(regex)
    );
  }

  private static isNumeric(s: string): boolean {
    try {
      return parseFloat(s) !== 0;
    } catch {
      return false;
    }
  }

  /**
   * Standard video format check (port of Android DefaultConfig.isVideoFormat).
   */
  private static isVideoFormat(url: string): boolean {
    if (url.includes('=http')) return false;
    if (VideoParseRuler.SNIFFER_REGEX.test(url)) {
      return (
        !url.includes('.js') &&
        !url.includes('.css') &&
        !url.includes('.jpg') &&
        !url.includes('.png') &&
        !url.includes('.gif') &&
        !url.includes('.ico') &&
        !url.includes('rl=') &&
        !url.includes('.html')
      );
    }
    return false;
  }

  /**
   * Apply AND-OR rule matching: ALL regexes in a rule array must match (AND),
   * and any rule array can match (OR).
   */
  private static checkRulesForHost(host: string, url: string): boolean {
    const rules = VideoParseRuler.hostRules.get(host);
    if (!rules || rules.length === 0) return false;

    for (const ruleArray of rules) {
      if (!ruleArray || ruleArray.length === 0) continue;
      let allMatch = true;
      for (const pattern of ruleArray) {
        const regex = VideoParseRuler.getCompiledRegex(pattern);
        if (!regex.test(url)) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) return true;
    }
    return false;
  }

  private static checkFilterRulesForHost(host: string, url: string): boolean {
    const filters = VideoParseRuler.hostFilters.get(host);
    if (!filters || filters.length === 0) return false;

    for (const filterArray of filters) {
      if (!filterArray || filterArray.length === 0) continue;
      let allMatch = true;
      for (const pattern of filterArray) {
        const regex = VideoParseRuler.getCompiledRegex(pattern);
        if (!regex.test(url)) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) return true;
    }
    return false;
  }

  private static getCompiledRegex(pattern: string): RegExp {
    let regex = VideoParseRuler.regexCache.get(pattern);
    if (!regex) {
      regex = new RegExp(pattern, 'i');
      VideoParseRuler.regexCache.set(pattern, regex);
    }
    return regex;
  }

  private static getHostFromUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return null;
    }
  }

  // Port of Android DefaultConfig.snifferMatch pattern
  private static readonly SNIFFER_REGEX =
    /http((?!http).){20,}?\.(m3u8|mp4|flv|avi|mkv|rm|wmv|mpg)\?.*|http((?!http).){20,}\.(m3u8|mp4|flv|avi|mkv|rm|wmv|mpg)|http((?!http).)*?video\/tos*|http((?!http).){20,}?\/m3u8\?pt=m3u8.*|http((?!http).)*?default\.ixigua\.com\/.*|http((?!http).)*?dycdn-tos\.pstatp[^\?]*|http.*?\/player\/m3u8play\.php\?url=.*|http.*?\/player\/.*?[pP]lay\.php\?url=.*|http.*?\/playlist\/m3u8\/\?vid=.*|http.*?\.php\?type=m3u8&.*|http.*?\/download\.aspx\?.*|http.*?\/api\/up_api\.php\?.*|https.*?\.66yk\.cn.*|http((?!http).)*?netease\.com\/file\/.*/i;
}
