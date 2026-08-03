/**
 * SourceTypeDetector - Detects source type for dedicated UI rendering
 *
 * Mirrors Android's SourceBean.style + categories approach and extends it
 * with name-based heuristics for sources that don't declare a style.
 *
 * Android's style system (ImgUtil.Style):
 *   - type: "rect" (grid) or "list" (list view)
 *   - ratio: width/height ratio
 *     - ratio >= 1.7 → 3 columns (landscape)
 *     - ratio >= 1.3 → 4 columns (4:3)
 *     - ratio < 1 → portrait poster
 *
 * PC extends this with semantic type detection (children/music/pan/anime/
 * shortPlay/sport/audio/education/bilibili/mediaServer/live) so each type
 * gets a dedicated layout optimized for its content shape.
 */

import type { SourceBean, MovieSort } from './models';

export type SourceType =
  | 'children'
  | 'music'
  | 'pan'
  | 'anime'
  | 'shortPlay'
  | 'sport'
  | 'audio'
  | 'education'
  | 'bilibili'
  | 'mediaServer'
  | 'live'
  | 'video';

export interface SourceStyleConfig {
  type: SourceType;
  ratio: number;
  layout: 'grid' | 'list' | 'card';
  cols: number;
  supportsViewToggle: boolean;
  /** Display name for empty-state icon fallback */
  emptyHint?: string;
}

const DEFAULT_VIDEO_STYLE: SourceStyleConfig = {
  type: 'video',
  ratio: 2 / 3,
  layout: 'grid',
  cols: 6,
  supportsViewToggle: false,
  emptyHint: '暂无视频',
};

const CHILDREN_STYLE: SourceStyleConfig = {
  type: 'children',
  ratio: 1,
  layout: 'grid',
  cols: 6,
  supportsViewToggle: false,
  emptyHint: '暂无儿童内容',
};

const MUSIC_STYLE: SourceStyleConfig = {
  type: 'music',
  ratio: 1,
  layout: 'list',
  cols: 1,
  supportsViewToggle: false,
  emptyHint: '暂无音乐',
};

const PAN_STYLE: SourceStyleConfig = {
  type: 'pan',
  ratio: 1,
  layout: 'card',
  cols: 5,
  supportsViewToggle: true,
  emptyHint: '暂无文件',
};

const ANIME_STYLE: SourceStyleConfig = {
  type: 'anime',
  ratio: 2 / 3,
  layout: 'grid',
  cols: 6,
  supportsViewToggle: false,
  emptyHint: '暂无动漫',
};

const SHORT_PLAY_STYLE: SourceStyleConfig = {
  type: 'shortPlay',
  ratio: 9 / 16,
  layout: 'grid',
  cols: 6,
  supportsViewToggle: false,
  emptyHint: '暂无短剧',
};

const SPORT_STYLE: SourceStyleConfig = {
  type: 'sport',
  ratio: 16 / 9,
  layout: 'grid',
  cols: 4,
  supportsViewToggle: false,
  emptyHint: '暂无体育内容',
};

const AUDIO_STYLE: SourceStyleConfig = {
  type: 'audio',
  ratio: 1,
  layout: 'list',
  cols: 1,
  supportsViewToggle: false,
  emptyHint: '暂无有声内容',
};

const EDUCATION_STYLE: SourceStyleConfig = {
  type: 'education',
  ratio: 16 / 9,
  layout: 'grid',
  cols: 4,
  supportsViewToggle: false,
  emptyHint: '暂无课程',
};

const BILIBILI_STYLE: SourceStyleConfig = {
  type: 'bilibili',
  ratio: 16 / 9,
  layout: 'grid',
  cols: 5,
  supportsViewToggle: false,
  emptyHint: '暂无B站内容',
};

const MEDIA_SERVER_STYLE: SourceStyleConfig = {
  type: 'mediaServer',
  ratio: 2 / 3,
  layout: 'grid',
  cols: 5,
  supportsViewToggle: false,
  emptyHint: '暂无媒体资源',
};

const LIVE_STYLE: SourceStyleConfig = {
  type: 'live',
  ratio: 16 / 9,
  layout: 'grid',
  cols: 4,
  supportsViewToggle: false,
  emptyHint: '暂无直播',
};

// ===== Name keyword detection =====
// Names look like "💓我的┃夸克💓‍" or "🍉漫剧┃小龙🍉" — strip emoji/whitespace
// before matching so keywords like "夸克" / "漫剧" are reliably found.

const PAN_NAME_KEYWORDS = [
  '我的夸克', '我的UC', '我的阿里', '我的百度', '我的115',
  '我的天翼', '我的移动', '我的迅雷', '我的网盘', '我的光鸭', '我的123',
  '115分享',
];

const MUSIC_NAME_KEYWORDS = [
  '音乐', '歌曲', '歌单', '电台', '舞曲', 'KTV',
  '蜻蜓', '酷狗', '酷听', '易听', '轮回',
];

const AUDIO_NAME_KEYWORDS = [
  '听书', '有声', '评书', '广播剧', '极客', '悦庭', '爱上听',
];

const CHILDREN_NAME_KEYWORDS = [
  '儿歌', '儿童', '少儿', '卡通', '绘本', '启蒙', '早教', '幼儿',
  '亲子', '睡前', '宝宝', '贝贝', '兔兔', '多多儿',
];

const ANIME_NAME_KEYWORDS = [
  '动漫', '漫剧', '漫短', '番薯', '喵呜', '花海', '魔都', '动画',
];

const SHORT_PLAY_NAME_KEYWORDS = [
  '短剧',
];

const SPORT_NAME_KEYWORDS = [
  '体育', '看球', '瓜子体育', '飞球', '球通', '八八', '咖啡体育', 'WWE',
  'NBA', 'CBA', '足球', '篮球',
];

const EDUCATION_NAME_KEYWORDS = [
  '教育', '课堂', '课程', '教学', '小学', '初中', '高中', '考研',
  '考研', '考证', '技能',
];

const BILIBILI_NAME_KEYWORDS = [
  '哔哩', 'B站', 'bilibili', 'Bili',
];

const MEDIA_SERVER_NAME_KEYWORDS = [
  'emby', 'alist', 'webdav', 'diyvod', 'vod┃diy',
];

const LIVE_NAME_KEYWORDS = [
  '直播', '虎牙', '斗鱼',
];

// ===== Category keyword detection =====

const CHILDREN_CATEGORY_KEYWORDS = [
  '儿童', '少儿', '儿歌', '卡通', '绘本', '启蒙', '早教', '幼儿',
  '亲子', '动画', '童年', '动漫',
];

const MUSIC_CATEGORY_KEYWORDS = [
  '音乐', '歌曲', '歌单', '舞曲', '电台', 'KTV',
];

const AUDIO_CATEGORY_KEYWORDS = [
  '听书', '有声', '评书', '广播', '相声', '戏曲',
];

const ANIME_CATEGORY_KEYWORDS = [
  '动漫', '动画', '番剧', '日漫', '国漫',
];

const SHORT_PLAY_CATEGORY_KEYWORDS = [
  '短剧',
];

const SPORT_CATEGORY_KEYWORDS = [
  '体育', '足球', '篮球', 'NBA', 'CBA',
];

const EDUCATION_CATEGORY_KEYWORDS = [
  '教育', '课程', '课堂', '教学', '小学', '初中', '高中', '考研',
];

const BILIBILI_CATEGORY_KEYWORDS = [
  'B站', '哔哩', 'bilibili',
];

const LIVE_CATEGORY_KEYWORDS = [
  '直播',
];

function normalizeName(name: string): string {
  // Strip emoji and decorative chars but keep CJK text
  // Removes: emoji ranges, box drawing chars (┃), whitespace
  return name
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '') // emoji & symbols
    .replace(/[\u{2600}-\u{27BF}]/gu, '') // misc symbols
    .replace(/[┃|]/g, '') // separators
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function detectSourceType(
  source: SourceBean | null | undefined,
  classes?: MovieSort[],
): SourceStyleConfig {
  if (!source) return DEFAULT_VIDEO_STYLE;

  const name = source.name || '';
  const styleStr = source.style || '';
  const normalized = normalizeName(name);

  // 1. If source declares a style JSON, honor ratio + type, but still try
  //    semantic detection for layout flavor.
  if (styleStr) {
    try {
      const parsed = JSON.parse(styleStr);
      const type: string = parsed.type || '';
      const ratio: number = Number(parsed.ratio) || 0;
      const detected = detectByName(normalized) || detectByCategories(classes);
      if (detected) {
        return {
          ...detected,
          layout: type === 'list' ? 'list' : detected.layout,
          ratio: ratio > 0 ? ratio : detected.ratio,
        };
      }
      if (type === 'list') {
        return { ...MUSIC_STYLE, ratio: ratio > 0 ? ratio : MUSIC_STYLE.ratio };
      }
      return { ...DEFAULT_VIDEO_STYLE, ratio: ratio > 0 ? ratio : DEFAULT_VIDEO_STYLE.ratio };
    } catch {
      /* not JSON */
    }
  }

  // 2. Match by name keywords
  const byName = detectByName(normalized);
  if (byName) return byName;

  // 3. Match by category keywords
  const byCat = detectByCategories(classes);
  if (byCat) return byCat;

  return DEFAULT_VIDEO_STYLE;
}

function detectByName(normalizedName: string): SourceStyleConfig | null {
  // Pan sources first — they have very specific "我的夸克" style names
  for (const kw of PAN_NAME_KEYWORDS) {
    if (normalizedName.includes(normalizeName(kw))) return PAN_STYLE;
  }
  // Media servers
  for (const kw of MEDIA_SERVER_NAME_KEYWORDS) {
    if (normalizedName.includes(normalizeName(kw))) return MEDIA_SERVER_STYLE;
  }
  // Live
  for (const kw of LIVE_NAME_KEYWORDS) {
    if (normalizedName.includes(normalizeName(kw))) return LIVE_STYLE;
  }
  // Bilibili
  for (const kw of BILIBILI_NAME_KEYWORDS) {
    if (normalizedName.includes(normalizeName(kw))) return BILIBILI_STYLE;
  }
  // Audio (听书) before music — "听书" is more specific than "音乐"
  for (const kw of AUDIO_NAME_KEYWORDS) {
    if (normalizedName.includes(normalizeName(kw))) return AUDIO_STYLE;
  }
  // Music
  for (const kw of MUSIC_NAME_KEYWORDS) {
    if (normalizedName.includes(normalizeName(kw))) return MUSIC_STYLE;
  }
  // Children
  for (const kw of CHILDREN_NAME_KEYWORDS) {
    if (normalizedName.includes(normalizeName(kw))) return CHILDREN_STYLE;
  }
  // Anime
  for (const kw of ANIME_NAME_KEYWORDS) {
    if (normalizedName.includes(normalizeName(kw))) return ANIME_STYLE;
  }
  // Short play
  for (const kw of SHORT_PLAY_NAME_KEYWORDS) {
    if (normalizedName.includes(normalizeName(kw))) return SHORT_PLAY_STYLE;
  }
  // Sport
  for (const kw of SPORT_NAME_KEYWORDS) {
    if (normalizedName.includes(normalizeName(kw))) return SPORT_STYLE;
  }
  // Education
  for (const kw of EDUCATION_NAME_KEYWORDS) {
    if (normalizedName.includes(normalizeName(kw))) return EDUCATION_STYLE;
  }
  return null;
}

function detectByCategories(classes?: MovieSort[]): SourceStyleConfig | null {
  if (!classes || classes.length === 0) return null;
  const realClasses = classes.filter((c) => c.type_id !== '__recommend__');
  if (realClasses.length === 0) return null;

  const allMatch = (keywords: string[]) =>
    realClasses.every((c) =>
      keywords.some((kw) => (c.type_name || '').includes(kw)),
    );

  if (allMatch(CHILDREN_CATEGORY_KEYWORDS)) return CHILDREN_STYLE;
  if (allMatch(ANIME_CATEGORY_KEYWORDS)) return ANIME_STYLE;
  if (allMatch(SHORT_PLAY_CATEGORY_KEYWORDS)) return SHORT_PLAY_STYLE;
  if (allMatch(SPORT_CATEGORY_KEYWORDS)) return SPORT_STYLE;
  if (allMatch(AUDIO_CATEGORY_KEYWORDS)) return AUDIO_STYLE;
  if (allMatch(MUSIC_CATEGORY_KEYWORDS)) return MUSIC_STYLE;
  if (allMatch(EDUCATION_CATEGORY_KEYWORDS)) return EDUCATION_STYLE;
  if (allMatch(BILIBILI_CATEGORY_KEYWORDS)) return BILIBILI_STYLE;
  if (allMatch(LIVE_CATEGORY_KEYWORDS)) return LIVE_STYLE;

  // Fuzzy: if 60%+ of categories match a type, use it
  const matchRatio = (keywords: string[]) => {
    const matchCount = realClasses.filter((c) =>
      keywords.some((kw) => (c.type_name || '').includes(kw)),
    ).length;
    return matchCount / realClasses.length;
  };

  const fuzzyChecks: [string[], SourceStyleConfig][] = [
    [MUSIC_CATEGORY_KEYWORDS, MUSIC_STYLE],
    [AUDIO_CATEGORY_KEYWORDS, AUDIO_STYLE],
    [CHILDREN_CATEGORY_KEYWORDS, CHILDREN_STYLE],
    [ANIME_CATEGORY_KEYWORDS, ANIME_STYLE],
    [SPORT_CATEGORY_KEYWORDS, SPORT_STYLE],
    [EDUCATION_CATEGORY_KEYWORDS, EDUCATION_STYLE],
  ];
  for (const [kw, style] of fuzzyChecks) {
    if (matchRatio(kw) >= 0.6) return style;
  }

  return null;
}

export function isPanOnlySource(
  source: SourceBean | null | undefined,
  homeVodList: { action?: string; vod_id?: string }[] | undefined,
): boolean {
  if (!source) return false;
  const name = normalizeName(source.name || '');
  for (const kw of PAN_NAME_KEYWORDS) {
    if (name.includes(normalizeName(kw))) return true;
  }
  if (homeVodList && homeVodList.length > 0) {
    return homeVodList.every((v) => !!v.action);
  }
  return false;
}
