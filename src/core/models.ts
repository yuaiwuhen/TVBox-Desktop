// ===== Source / Site =====

export interface SourceBean {
  key: string;
  name: string;
  api: string;
  type: number; // 0=XML, 1=JSON, 3=Spider
  searchable: number;
  quickSearch: number;
  filterable: number;
  hide?: number;
  playerUrl?: string;
  ext?: string;
  jar?: string;
  playerType?: number; // -1=follow settings, 0=system, 1=IJK, 2=Exo
  categories?: string[];
  clickSelector?: string;
  style?: string;
}

// ===== VOD / Movie =====

export interface Movie {
  vod_id: string;
  vod_name: string;
  vod_pic?: string;
  vod_remarks?: string;
  vod_year?: string;
  vod_area?: string;
  vod_director?: string;
  vod_actor?: string;
  vod_content?: string;
  vod_play_from?: string; // "Line1$$$Line2"
  vod_play_url?: string; // "Ep1$url1#Ep2$url2$$$Ep1$url3"
  type_name?: string;
  vod_lang?: string;
  vod_state?: string;
  vod_tag?: string;
  sourceKey?: string;
  action?: string;
}

export interface MovieSort {
  type_id: string;
  type_name: string;
}

// ===== Spider Results =====

export interface SpiderHomeResult {
  class?: MovieSort[];
  list?: Movie[];
  filters?: Record<string, FilterGroup[]>;
}

export interface SpiderDetailResult {
  list: Movie[];
}

export interface PlayResult {
  parse: number; // 0=direct play, 1=need VIP parse
  url: string;
  header?: string; // JSON string of headers
  msg?: string;
  playUrl?: string;
  jxFrom?: string;
  danmuUrl?: string; // URL to fetch danmaku/barrage data (Bilibili XML or JSON format)
}

// ===== Filter / Sort =====

export interface FilterGroup {
  key: string;
  name: string;
  value: FilterItem[];
}

export interface FilterItem {
  n: string; // name
  v: string; // value
}

// ===== Parse =====

export interface ParseBean {
  name: string;
  url: string;
  type: number; // 0=sniffer, 1=JSON, 2=JSON ext, 3=aggregate, 4=super
  ext?: string; // JSON object string
}

// ===== Live =====

export interface LiveChannelGroup {
  groupName: string;
  groupPassword?: string;
  groupIndex: number;
  channels: LiveChannelItem[];
}

export interface LiveChannelItem {
  channelName: string;
  channelIndex: number;
  channelNum: number;
  channelUrls: string[];
  channelSourceNames: string[];
}

// ===== EPG =====

export interface EpgInfo {
  title: string;
  start: string;
  end: string;
}

// ===== IJK Codec =====

export interface IJKCode {
  name: string;
  options: Record<string, string>;
  selected: boolean;
}

// ===== Config =====

export interface TVBoxConfig {
  sites: SourceBean[];
  lives?: any[];
  parses?: ParseBean[];
  flags?: string[];
  wallpaper?: string;
  spider?: string;
  jarCache?: string;
  livePlayHeaders?: Record<string, string>;
  rules?: ParseRule[];
  ads?: string[];
  ijk?: IJKCodeGroup[];
}

export interface IJKCodeGroup {
  group: string;
  options: IJKCodeOption[];
}

export interface IJKCodeOption {
  name: string;
  category: number;
  value: string;
}

// ===== Sniff Rules =====

export interface ParseRule {
  host?: string;
  rule?: string[];
  filter?: string[];
  hosts?: string[];
  regex?: string[];
  script?: string[];
}

// ===== History / Favorite =====

export interface HistoryRecord extends Movie {
  sourceKey: string;
  playUrl: string;
  playFlag: string;
  playIndex: number;
  progress: number;
  duration: number;
  timestamp: number;
}

export interface FavoriteRecord extends Movie {
  sourceKey: string;
  timestamp: number;
}

// ===== Spider Interface =====

export interface ISpider {
  init(extend: string): Promise<void>;
  homeContent(filter: boolean): Promise<string>;
  homeVideoContent(): Promise<string>;
  categoryContent(
    tid: string,
    pg: string,
    filter: boolean,
    extend: Record<string, string>,
  ): Promise<string>;
  detailContent(ids: string[]): Promise<string>;
  searchContent(key: string, quick: boolean, pg?: string): Promise<string>;
  playerContent(flag: string, id: string, vipFlags: string[]): Promise<string>;
  isVideoFormat(url: string): Promise<boolean>;
  manualVideoCheck(): Promise<boolean>;
  destroy(): void;
  action(actionId: string, actionData: any): Promise<string>;
}

/**
 * Process image URL with embedded headers (@Referer, @User-Agent, @Cookie).
 * Spider may return URLs like:
 *   https://img.doubanio.com/xxx.jpg@Referer=https://movie.douban.com/@User-Agent=Mozilla/5.0...
 * Browser cannot set these headers directly, so we route through proxy.
 * Returns the proxy URL if headers are embedded, otherwise the original URL.
 */
export function processImageUrl(url: string | undefined, proxyPort: number = 19980): string {
  if (!url) return '';
  // Check if URL contains embedded headers
  if (url.includes('@Referer=') || url.includes('@User-Agent=') || url.includes('@Cookie=')) {
    return `http://127.0.0.1:${proxyPort}/image?url=${encodeURIComponent(url)}`;
  }
  return url;
}
