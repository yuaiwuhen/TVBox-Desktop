import axios from 'axios';

export interface SubtitleSearchResult {
  name: string;
  url: string;
  isZip: boolean;
}

export class SubtitleSearch {
  private static ASSRT_BASE = 'https://secure.assrt.net/sub/';

  /**
   * Search subtitles from assrt.net by title.
   */
  static async search(title: string, page: number = 1): Promise<SubtitleSearchResult[]> {
    try {
      const resp = await axios.get(this.ASSRT_BASE, {
        params: {
          searchword: title,
          sort: 'rank',
          page,
          no_redir: 1,
        },
        responseType: 'text',
        timeout: 15000,
      });

      return this.parseSearchResults(resp.data);
    } catch (e) {
      console.warn('[SubtitleSearch] Search failed:', e);
      return [];
    }
  }

  /**
   * Fetch subtitle content from a URL.
   * For .srt/.ass/.vtt files, returns the text content directly.
   */
  static async fetchSubtitle(url: string): Promise<string | null> {
    try {
      const resp = await axios.get(url, {
        responseType: 'text',
        timeout: 15000,
      });
      return typeof resp.data === 'string' ? resp.data : String(resp.data);
    } catch (e) {
      console.warn('[SubtitleSearch] Fetch subtitle failed:', e);
      return null;
    }
  }

  private static parseSearchResults(html: string): SubtitleSearchResult[] {
    const results: SubtitleSearchResult[] = [];

    // Parse HTML to find subtitle links using regex (lightweight, no DOM parser needed)
    // Pattern: <a class="introtitle" href="/sub/..." title="..." >
    const regex = /<a[^>]*class="introtitle"[^>]*href="([^"]*)"[^>]*title="([^"]*)"[^>]*>/gi;
    let match;

    while ((match = regex.exec(html)) !== null) {
      const href = match[1];
      const title = match[2];
      if (!href || !title) continue;

      results.push({
        name: this.decodeHtmlEntities(title),
        url: href.startsWith('http') ? href : `https://assrt.net${href}`,
        isZip: true, // assrt.net subtitles are typically zip files
      });
    }

    // Fallback pattern: try different HTML structure
    if (results.length === 0) {
      const altRegex = /<a[^>]*href="(\/sub\/\d+)"[^>]*>([^<]*)<\/a>/gi;
      while ((match = altRegex.exec(html)) !== null) {
        const href = match[1];
        const title = match[2]?.trim();
        if (!href || !title) continue;

        results.push({
          name: this.decodeHtmlEntities(title),
          url: `https://assrt.net${href}`,
          isZip: true,
        });
      }
    }

    return results;
  }

  private static decodeHtmlEntities(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&#39;/g, "'");
  }
}
