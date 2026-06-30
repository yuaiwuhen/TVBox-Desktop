import axios from 'axios';
import { VideoParseRuler } from './VideoParseRuler';

interface M3U8Segment {
  url: string;
  duration: number;
  discontinuity: boolean;
}

export class M3u8Purifier {
  /**
   * Purify an M3U8 playlist by removing ad segments.
   * Three strategies:
   * 1. Regex rules from VideoParseRuler (host-specific ad patterns)
   * 2. Prefix/domain majority voting (minority URLs are ads)
   * 3. DISCONTINUITY-based duration heuristics (very short segments between discontinuities are ads)
   */
  static purify(content: string, m3u8Url: string): string {
    const lines = content.split('\n');
    const segments = M3u8Purifier.parseSegments(lines, m3u8Url);
    if (segments.length === 0) return content;

    // Strategy 1: Remove segments matching ad regex rules
    const host = M3u8Purifier.extractHost(m3u8Url);
    const adRegex = host ? VideoParseRuler.getHostsRegex(host) : null;
    let filtered = adRegex
      ? segments.filter((s) => !adRegex.test(s.url))
      : segments;

    // Strategy 2: Prefix/domain majority voting
    if (filtered.length > 3) {
      filtered = M3u8Purifier.removeMinorityUrls(filtered);
    }

    // Strategy 3: DISCONTINUITY-based ad detection
    filtered = M3u8Purifier.removeDiscontinuityAds(filtered);

    if (filtered.length === segments.length) return content;

    return M3u8Purifier.rebuildM3U8(content, filtered, m3u8Url);
  }

  /**
   * Fetch, purify, and return M3U8 content via proxy.
   */
  static async fetchAndPurify(
    url: string,
    headers?: Record<string, string>,
  ): Promise<string> {
    const resp = await axios.get(url, {
      headers: headers || {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: new URL(url).origin + '/',
      },
      responseType: 'text',
      timeout: 15000,
    });

    let content = typeof resp.data === 'string' ? resp.data : String(resp.data);

    // Follow redirect if m3u8 points to another m3u8
    if (!content.includes('#EXTINF') && content.trim().startsWith('http')) {
      return M3u8Purifier.fetchAndPurify(content.trim(), headers);
    }

    // Purify ad segments
    content = M3u8Purifier.purify(content, url);

    // Rewrite relative URLs to absolute
    if (content.includes('#EXTINF') || content.includes('#EXT-X-')) {
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
      content = content.replace(
        /^(?!#)(?!https?:\/\/)(\S+)$/gm,
        (match) => baseUrl + match,
      );
    }

    return content;
  }

  // --- Internal methods ---

  private static parseSegments(
    lines: string[],
    m3u8Url: string,
  ): M3U8Segment[] {
    const segments: M3U8Segment[] = [];
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
    let currentDuration = 0;
    let discontinuity = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-DISCONTINUITY')) {
        discontinuity = true;
      } else if (line.startsWith('#EXTINF:')) {
        const durMatch = line.match(/#EXTINF:([\d.]+)/);
        currentDuration = durMatch ? parseFloat(durMatch[1]) : 0;
      } else if (line && !line.startsWith('#')) {
        const url = line.startsWith('http') ? line : baseUrl + line;
        segments.push({ url, duration: currentDuration, discontinuity });
        discontinuity = false;
        currentDuration = 0;
      }
    }

    return segments;
  }

  private static removeMinorityUrls(segments: M3U8Segment[]): M3U8Segment[] {
    if (segments.length < 4) return segments;

    // Try prefix-based majority voting
    const prefixCounts = new Map<string, number>();
    for (const seg of segments) {
      const prefix = M3u8Purifier.getUrlPrefix(seg.url);
      prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    }

    // Find the majority prefix
    let maxPrefix = '';
    let maxCount = 0;
    for (const [prefix, count] of prefixCounts) {
      if (count > maxCount) {
        maxCount = count;
        maxPrefix = prefix;
      }
    }

    // If majority is > 60%, filter out minority
    const threshold = segments.length * 0.6;
    if (maxCount >= threshold && prefixCounts.size > 1) {
      const filtered = segments.filter(
        (seg) => M3u8Purifier.getUrlPrefix(seg.url) === maxPrefix,
      );
      if (filtered.length > 0) return filtered;
    }

    // Fallback: domain-based majority voting
    const domainCounts = new Map<string, number>();
    for (const seg of segments) {
      const domain = M3u8Purifier.extractDomain(seg.url);
      domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    }

    let maxDomain = '';
    let maxDomainCount = 0;
    for (const [domain, count] of domainCounts) {
      if (count > maxDomainCount) {
        maxDomainCount = count;
        maxDomain = domain;
      }
    }

    // Domains appearing > 15 times are likely not ads
    if (maxDomainCount >= threshold && domainCounts.size > 1) {
      const filtered = segments.filter(
        (seg) => M3u8Purifier.extractDomain(seg.url) === maxDomain,
      );
      if (filtered.length > 0) return filtered;
    }

    return segments;
  }

  private static removeDiscontinuityAds(
    segments: M3U8Segment[],
  ): M3U8Segment[] {
    // Group segments between discontinuities
    const groups: M3U8Segment[][] = [];
    let currentGroup: M3U8Segment[] = [];

    for (const seg of segments) {
      if (seg.discontinuity && currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
      }
      currentGroup.push(seg);
    }
    if (currentGroup.length > 0) groups.push(currentGroup);

    if (groups.length <= 1) return segments;

    // Calculate total duration per group
    const groupDurations = groups.map((g) =>
      g.reduce((sum, s) => sum + s.duration, 0),
    );

    // The largest group is likely the main content
    const maxDuration = Math.max(...groupDurations);

    // Filter out groups with very short total duration (< 5% of main or < 2 seconds)
    const result: M3U8Segment[] = [];
    for (let i = 0; i < groups.length; i++) {
      const dur = groupDurations[i];
      if (dur >= maxDuration * 0.05 && dur >= 2) {
        result.push(...groups[i]);
      }
    }

    return result.length > 0 ? result : segments;
  }

  private static rebuildM3U8(
    originalContent: string,
    segments: M3U8Segment[],
    m3u8Url: string,
  ): string {
    const lines: string[] = [];
    const originalLines = originalContent.split('\n');
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

    // Copy header lines (before first #EXTINF)
    let headerDone = false;
    for (const line of originalLines) {
      if (
        line.startsWith('#EXTINF') ||
        line.startsWith('#EXT-X-DISCONTINUITY')
      ) {
        _headerDone = true;
        break;
      }
      if (line.startsWith('#') || line.trim() === '') {
        lines.push(line);
      }
    }

    // Add #EXT-X-MEDIA-SEQUENCE if not present
    if (!lines.some((l) => l.includes('#EXT-X-MEDIA-SEQUENCE'))) {
      lines.splice(1, 0, '#EXT-X-MEDIA-SEQUENCE:0');
    }

    // Rebuild segment entries
    let prevDiscontinuity = false;
    for (const seg of segments) {
      if (seg.discontinuity && !prevDiscontinuity) {
        lines.push('#EXT-X-DISCONTINUITY');
      }
      prevDiscontinuity = seg.discontinuity;

      lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
      // Use relative URL if possible
      const url = seg.url.startsWith(baseUrl)
        ? seg.url.substring(baseUrl.length)
        : seg.url;
      lines.push(url);
    }

    lines.push('#EXT-X-ENDLIST');

    return lines.join('\n');
  }

  private static getUrlPrefix(url: string): string {
    try {
      const u = new URL(url);
      // Use path up to 3rd slash as prefix (domain + first path segment)
      const pathParts = u.pathname.split('/').slice(0, 3);
      return `${u.hostname}/${pathParts.join('/')}`;
    } catch {
      return url.substring(0, Math.min(50, url.length));
    }
  }

  private static extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  private static extractHost(m3u8Url: string): string {
    try {
      return new URL(m3u8Url).hostname;
    } catch {
      return '';
    }
  }
}
