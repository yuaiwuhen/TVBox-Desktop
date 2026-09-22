<script setup lang="ts">
/**
 * MoviPlayer 播放器组件 - 基于 movi-player (WebCodecs + FFmpeg WASM)
 *
 * 相比原生 <video> 的优势：
 *  1. 可播放 MKV/HEVC/AV1/4K HDR 等原生内核不支持的格式
 *  2. 自动发现 MKV/MP4 容器内嵌字幕轨与多音轨（含 PGS/DVB 图形字幕）
 *  3. headers 属性可为所有媒体请求附加自定义请求头（解决夸克 CDN 的
 *     Referer/Cookie 鉴权 403）
 *
 * 控制栏：关闭 movi-player 自带控件栏，自建「顶栏 + 底栏」，样式与交互
 * 对齐 VideoPlayer.vue。顶栏/底栏/弹幕面板拆分为独立子组件，通过
 * provide/inject 共享状态与动作。
 */
import { ref, reactive, provide, computed, onMounted, onUnmounted, watch } from 'vue';
import 'movi-player/element';
import { DanmuEngine } from '../core/DanmuEngine';
import axios from 'axios';
import { checkReplaceProxy, getLocalProxy } from '../core/ConfigParser';
import { useAppStore } from '../store/app';
import type { MediaTrack } from '../core/models';
import { DArrowRight, Unlock, VideoPause, VideoPlay, FullScreen } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import PlayerTopBar from './PlayerTopBar.vue';
import PlayerBottomBar from './PlayerBottomBar.vue';
import PlayerDanmuPanel from './PlayerDanmuPanel.vue';

// 注：<movi-player> 作为原生自定义元素渲染的 isCustomElement 配置
// 已在 vite.config.ts 的 vue() 插件中统一设置（runtime-only 构建不支持
// 在组件内通过 defineOptions.compilerOptions 配置，会触发 Vue 警告）。

export interface PlayerCtx {
  // 播放状态
  showControls: boolean;
  screenLocked: boolean;
  hasError: boolean;
  isLoading: boolean;
  isPlaying: boolean;
  isAppFullscreen: boolean;
  isFullscreen: boolean;
  currentTime: number;
  duration: number;
  buffered: number;
  volume: number;
  isMuted: boolean;
  progressPercent: number;
  formattedCurrentTime: string;
  formattedDuration: string;
  // 业务状态
  playbackRate: number;
  timeStep: number;
  aspectRatio: string;
  aspectRatios: { label: string; value: string }[];
  skipIntro: number;
  skipOutro: number;
  skipIndicator: string;
  showMorePanel: boolean;
  // 弹幕
  danmuEnabled: boolean;
  danmuOpacity: number;
  danmuSpeedIndex: number;
  danmuSpeedOptions: { label: string; value: number }[];
  danmuLines: number;
  danmuColorMode: string;
  showDanmuSettings: boolean;
  // 字幕/音轨
  audioMenuItems: { id: string; label: string; active: boolean }[];
  subtitleMenuItems: { id: string; label: string; active: boolean }[];
  // props 派生
  title: string;
  hasPrev: boolean;
  hasNext: boolean;
  showSubtitleSearch: boolean;
  // 动作
  emitPrev: () => void;
  emitNext: () => void;
  emitSearchSubtitle: () => void;
  togglePlay: () => void;
  playVideo: () => Promise<void>;
  pauseVideo: () => void;
  seekTo: (t: number) => void;
  skipForward: () => void;
  skipBackward: () => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  changeSpeed: (r: number) => void;
  setTimeStep: (s: number) => void;
  changeAspectRatio: (m: string) => void;
  toggleSkipIntro: () => void;
  toggleSkipOutro: () => void;
  togglePiP: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
  toggleAppFullscreen: () => void;
  lockScreen: () => void;
  toggleDanmu: () => void;
  selectAudio: (id: string) => Promise<void>;
  selectSubtitle: (id: string) => Promise<void>;
}

// ==================== Props ====================
const props = withDefaults(defineProps<{
  url?: string;
  autoplay?: boolean;
  poster?: string;
  title?: string;
  headers?: Record<string, string>;
  subtitleUrl?: string;
  danmuUrl?: string;
  /** TVBox `audio` field: alternate audio track URLs */
  audioUrls?: MediaTrack[];
  /** TVBox `sub` field: external subtitle track URLs */
  subtitleUrls?: MediaTrack[];
  hasPrev?: boolean;
  hasNext?: boolean;
  resumeProgress?: number;
  showSubtitleSearch?: boolean;
}>(), {
  autoplay: true,
  title: '',
  hasPrev: false,
  hasNext: false,
  resumeProgress: 0,
  showSubtitleSearch: false
});

// ==================== Emits ====================
const emit = defineEmits<{
  (e: 'ended'): void;
  (e: 'error', error: any): void;
  (e: 'ready'): void;
  (e: 'prev'): void;
  (e: 'next'): void;
  (e: 'progress', time: number, duration: number): void;
  (e: 'searchSubtitle'): void;
}>();

// ==================== State ====================
const mpRef = ref<any>();
const playerContainer = ref<HTMLDivElement>();
const danmuContainer = ref<HTMLDivElement>();
const appStore = useAppStore();
const playbackRate = ref(appStore.playSpeed);
const isLoading = ref(true);
const hasError = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const buffered = ref(0);
const isPlaying = ref(false);
const volume = ref(1);
const isMuted = ref(false);
const showControls = ref(true);
const isFullscreen = ref(false);
const isAppFullscreen = ref(false);
const screenLocked = ref(false);
let controlsTimer: ReturnType<typeof setTimeout> | null = null;

// 弹幕
const danmuEngine = new DanmuEngine();
const danmuEnabled = ref(localStorage.getItem('tvbox_danmu_enabled') === 'true');
const danmuMaxOnScreen = ref(Number(localStorage.getItem('tvbox_danmu_max') || '30'));
const danmuLines = ref(Number(localStorage.getItem('tvbox_danmu_lines') || '8'));
// 透明度兼容旧值（旧版存 0~1，新版与 VideoPlayer 一致存 10~100）
const danmuOpacity = ref((() => {
  const v = localStorage.getItem('tvbox_danmu_opacity');
  if (!v) return 100;
  const n = Number(v);
  return n <= 1 ? Math.round(n * 100) : n;
})());
const danmuFontSize = ref(Number(localStorage.getItem('tvbox_danmu_fontsize') || '24'));
const danmuSpeedOptions = [
  { label: '超慢', value: 12 },
  { label: '慢', value: 9 },
  { label: '适中', value: 6 },
  { label: '快', value: 4 },
];
const danmuSpeedIndex = ref(Number(localStorage.getItem('tvbox_danmu_speed_idx') || '2'));
const danmuColorMode = ref(localStorage.getItem('tvbox_danmu_color') || 'default');
const activeDanmuEls: HTMLElement[] = [];
const showDanmuSettings = ref(false);

danmuEngine.setEnabled(danmuEnabled.value);
danmuEngine.setMaxOnScreen(danmuMaxOnScreen.value);
danmuEngine.setOpacity(danmuOpacity.value / 100);
danmuEngine.setSpeed(danmuSpeedOptions[danmuSpeedIndex.value]?.value ?? 6);
danmuEngine.setFontSize(danmuFontSize.value);

// 字幕/音轨
const subtitleTracksInfo = ref<string[]>([]);
const audioTracksInfo = ref<string[]>([]);
const subtitleMenuItems = ref<{ id: string; label: string; active: boolean }[]>([]);
const audioMenuItems = ref<{ id: string; label: string; active: boolean }[]>([]);

// ==================== 画面比例 / 跳过片头片尾 ====================
const aspectRatio = ref(appStore.scaleType || 'default');
const aspectRatios = [
  { label: '默认', value: 'default' },
  { label: '16:9', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '填充', value: 'fill' },
  { label: '原始', value: 'original' },
  { label: '裁剪', value: 'crop' },
];
const timeStep = ref(Number(localStorage.getItem('tvbox_time_step') || '10'));
const skipIntro = ref(appStore.skipIntro);
const skipOutro = ref(appStore.skipOutro);
const skipIndicator = ref('');
const showMorePanel = ref(false);

// 手势反馈
const clickFeedback = ref<{ x: number; y: number; icon: string } | null>(null);
let clickFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
const longPressActive = ref(false);
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let savedPlaybackRate = 1;
let mouseDownTime = 0;
let mouseDownX = 0;
let mouseDownY = 0;

// ==================== Computed ====================
const progressPercent = computed(() => {
  if (duration.value === 0) return 0;
  return (currentTime.value / duration.value) * 100;
});
const formattedCurrentTime = computed(() => formatTime(currentTime.value));
const formattedDuration = computed(() => formatTime(duration.value));

// ==================== 弹幕 ====================
const loadDanmu = async (url: string) => {
  try {
    let finalUrl = url;
    const origin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return '';
      }
    })();
    if (url.startsWith('proxy://')) {
      const target = url.replace('proxy://', '');
      finalUrl = `${getLocalProxy()}/proxy?do=danmu&url=${encodeURIComponent(target)}${origin ? `&referer=${encodeURIComponent(origin + '/')}` : ''}`;
    } else {
      finalUrl = `${getLocalProxy()}/proxy?do=danmu&url=${encodeURIComponent(checkReplaceProxy(url))}${origin ? `&referer=${encodeURIComponent(origin + '/')}` : ''}`;
    }
    const resp = await axios.get(finalUrl, { responseType: 'text', timeout: 10000 });
    danmuEngine.load(resp.data);
    danmuEnabled.value = true;
    danmuEngine.setEnabled(true);
    localStorage.setItem('tvbox_danmu_enabled', 'true');
  } catch (e) {
    console.warn('[MoviPlayer] Failed to load danmu:', e);
  }
};

const renderDanmu = (time: number) => {
  if (!danmuContainer.value) return;
  const maxCount = Math.min(danmuMaxOnScreen.value, danmuLines.value * 3);
  const items = danmuEngine.getItemsAtTime(time, 8);
  for (const item of items) {
    if (activeDanmuEls.length >= maxCount) break;
    const el = document.createElement('div');
    el.textContent = item.text;
    const speedOption = danmuSpeedOptions[danmuSpeedIndex.value] || danmuSpeedOptions[2];
    const durationMs = speedOption.value * 1000;
    el.style.position = 'absolute';
    el.style.whiteSpace = 'nowrap';
    el.style.fontSize = `${item.fontSize || danmuFontSize.value}px`;
    el.style.fontWeight = 'bold';
    el.style.textShadow = '1px 1px 2px rgba(0,0,0,0.8)';
    let color = item.color || '#ffffff';
    if (danmuColorMode.value === 'random' && !item.color) {
      const colors = ['#ffffff', '#ff0000', '#00ff00', '#ffff00', '#00ffff', '#ff69b4', '#ffa500'];
      color = colors[Math.floor(Math.random() * colors.length)];
    }
    el.style.color = color;
    el.style.opacity = String(danmuOpacity.value / 100);
    el.style.transition = 'transform 0.1s linear';
    if (item.type === 0) {
      el.style.top = `${Math.floor(Math.random() * (danmuContainer.value.clientHeight - 30))}px`;
      el.style.left = `${danmuContainer.value.clientWidth}px`;
      requestAnimationFrame(() => {
        el.style.transform = `translateX(-${danmuContainer.value!.clientWidth + el.clientWidth}px)`;
        el.style.transition = `transform ${durationMs}ms linear`;
      });
      setTimeout(() => {
        el.remove();
        const idx = activeDanmuEls.indexOf(el);
        if (idx !== -1) activeDanmuEls.splice(idx, 1);
      }, durationMs + 50);
    } else {
      el.style.top = item.type === 1 ? '20px' : `${danmuContainer.value.clientHeight - 30}px`;
      el.style.left = '50%';
      el.style.transform = 'translateX(-50%)';
      setTimeout(() => {
        el.remove();
        const idx = activeDanmuEls.indexOf(el);
        if (idx !== -1) activeDanmuEls.splice(idx, 1);
      }, 5000);
    }
    danmuContainer.value.appendChild(el);
    activeDanmuEls.push(el);
  }
};

const setDanmu = (on: boolean) => {
  if (danmuEnabled.value === on) return;
  danmuEnabled.value = on;
  danmuEngine.setEnabled(on);
  localStorage.setItem('tvbox_danmu_enabled', String(on));
  if (!on) {
    for (const el of activeDanmuEls) el.remove();
    activeDanmuEls.length = 0;
  }
};
const toggleDanmu = () => setDanmu(!danmuEnabled.value);

// 弹幕参数持久化：无论从顶栏按钮、弹幕面板（子组件直接修改 ctx 值）还是
// 本组件内修改，都统一写 localStorage 并同步 DanmuEngine。
watch(danmuSpeedIndex, (idx) => {
  localStorage.setItem('tvbox_danmu_speed_idx', String(idx));
  danmuEngine.setSpeed(danmuSpeedOptions[idx]?.value ?? 6);
});
watch(danmuOpacity, (val) => {
  localStorage.setItem('tvbox_danmu_opacity', String(val));
  danmuEngine.setOpacity(val / 100);
});
watch(danmuLines, (val) => {
  localStorage.setItem('tvbox_danmu_lines', String(val));
});
watch(danmuColorMode, (val) => {
  localStorage.setItem('tvbox_danmu_color', String(val));
});
watch(danmuEnabled, (on) => {
  localStorage.setItem('tvbox_danmu_enabled', String(on));
  danmuEngine.setEnabled(on);
  if (!on) {
    for (const el of activeDanmuEls) el.remove();
    activeDanmuEls.length = 0;
  }
});

// ==================== movi-player 事件 ====================
const onEnded = () => {
  isPlaying.value = false;
  emit('ended');
};

// 打印实际使用的播放引擎（native / hlsjs / shaka / wasm）。
// movi-player 用内部 _engineTried 集合记录本次加载实际尝试过的引擎，
// 最后一个即当前生效引擎；同一 URL 只打印一次，避免每次播放状态变化重复刷屏。
let engineLoggedKey = '';
const logActiveEngine = () => {
  const el = mpRef.value;
  if (!el || !props.url || engineLoggedKey === props.url) return;
  engineLoggedKey = props.url;
  try {
    const tried: string[] = Array.from((el as any)._engineTried ?? []);
    console.log(
      `[MoviPlayer] 播放引擎: 配置="${el.engine ?? '(未配置)'}" | 实际尝试=${tried.length ? tried.join(' → ') : '(未记录)'}`,
    );
  } catch (e) {
    console.warn('[MoviPlayer] 读取引擎信息失败:', e);
  }
};

const onStateChange = (e: any) => {
  const state = e.detail ?? '';
  switch (state) {
    case 'playing':
      isPlaying.value = true;
      isLoading.value = false;
      hasError.value = false;
      logActiveEngine();
      hideControlsDelayed();
      break;
    case 'paused':
      isPlaying.value = false;
      showControls.value = true;
      break;
    case 'ready':
      isLoading.value = false;
      hasError.value = false;
      logActiveEngine();
      emit('ready');
      break;
    case 'error':
      hasError.value = true;
      isLoading.value = false;
      break;
    case 'ended':
      isPlaying.value = false;
      break;
    default:
      break;
  }
};

const onTimeUpdate = (e: any) => {
  const el = mpRef.value;
  const t = typeof e.detail === 'number' ? e.detail : el?.currentTime ?? 0;
  currentTime.value = t;
  duration.value = el?.duration || 0;
  try {
    if (el?.buffered?.length) {
      buffered.value = el.buffered.end(el.buffered.length - 1);
    }
  } catch { /* noop */ }
  emit('progress', currentTime.value, duration.value);
  if (danmuEnabled.value) renderDanmu(currentTime.value);

  // 自动跳过片尾 → 触发下一集
  if (skipOutro.value > 0 && duration.value > 0 && props.hasNext &&
    currentTime.value + skipOutro.value >= duration.value) {
    emit('next');
    skipOutro.value = 0;
    appStore.setSkipOutro(0);
  }
  // 跳过提示
  if (skipIntro.value > 0 && currentTime.value > 2 && currentTime.value < skipIntro.value) {
    skipIndicator.value = '跳过片头';
  } else if (skipOutro.value > 0 && duration.value > 0 && currentTime.value + skipOutro.value >= duration.value) {
    skipIndicator.value = '跳过片尾';
  } else {
    skipIndicator.value = '';
  }
};

// wasm 引擎打开失败后 movi-player 会自动回退到 native/hlsjs 引擎继续播放，
// 此时 error 事件会触发但播放实际成功，不能显示"播放失败"遮罩。
let errorTimer: ReturnType<typeof setTimeout> | null = null;
const onError = (e: any) => {
  console.warn('[MoviPlayer] error(可能已回退引擎):', e.detail ?? e);
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    if (!isPlaying.value) {
      hasError.value = true;
      isLoading.value = false;
      emit('error', e.detail ?? e);
    }
  }, 1500);
};

// 轨道数据源说明：
//  - 内嵌轨（muxed，来自 MKV/MP4 容器）：从 `trackschange` 事件的
//    detail.subtitle / detail.audio 获取（detail.subtitle 即元素公开的
//    getSubtitleTracks() 返回的内嵌轨数组）。
//  - 外部语言轨（<track> 声明 / 多语言 source）：用元素公开的
//    getSubtitleLangs() / getAudioLangs() 查询。
//
// 内嵌字幕轨名字的坑：MP4 容器里字幕轨的 handler_name 默认就是
// "SubtitleHandler"，夸克等转码 MP4 的所有字幕轨都叫这个名字，直接当
// label 显示会全是"subtitlehandler"。这里过滤掉这类无意义名字，改用
// 语言名（映射成中文）或"字幕 N"，并去重（同语言+同类型+同编码只留一条）。
const LANG_NAMES: Record<string, string> = {
  zh: '中文', 'zh-cn': '中文(简)', 'zh-tw': '中文(繁)', 'zh-hans': '中文(简)',
  'zh-hant': '中文(繁)', chi: '中文', zho: '中文',
  en: '英文', eng: '英文', 'en-us': '英文', 'en-gb': '英文',
  ja: '日文', jpn: '日文', ko: '韩文', kor: '韩文',
  fr: '法文', fra: '法文', de: '德文', deu: '德文', ger: '德文',
  es: '西班牙文', spa: '西班牙文', ru: '俄文', rus: '俄文',
  th: '泰文', tha: '泰文', vi: '越南文', vie: '越南文',
  it: '意大利文', ita: '意大利文', pt: '葡萄牙文', por: '葡萄牙文',
};
const isHandlerName = (l?: string) =>
  !l || /^subtitle\s*handler$/i.test(String(l).trim());
const subtitleLabel = (s: any, idx: number) => {
  const raw = String(s.label ?? '').trim();
  const lang = String(s.language ?? '').toLowerCase();
  const langName = LANG_NAMES[lang] || (lang ? lang.toUpperCase() : '');
  const base = !isHandlerName(raw) ? raw : langName || `字幕 ${idx + 1}`;
  return `${base}${s.subtitleType === 'image' ? ' [图形]' : ''}`;
};

const onTracksChange = (e: any) => {
  const el = mpRef.value;
  const detail = e?.detail ?? {};
  try {
    const subs: any[] = detail.subtitle ?? [];
    const audios: any[] = detail.audio ?? [];
    const extSubs: any[] = el?.getSubtitleLangs?.() ?? [];
    const extAudios: any[] = el?.getAudioLangs?.() ?? [];

    // 内嵌轨去重：同 language+subtitleType+codec 只保留第一条
    const seen = new Set<string>();
    const deduped = subs.filter((s: any) => {
      const key = `${s.subtitleType}|${String(s.language ?? '').toLowerCase()}|${String(s.codec ?? '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 字幕：内嵌轨 + 外部轨合并；外部轨用 lang 区分，内嵌轨用 id
    subtitleTracksInfo.value = [
      ...deduped.map((s: any, i: number) => subtitleLabel(s, i)),
      ...extSubs.map((s: any) => `${s.label ?? s.lang ?? ''}`),
    ];
    subtitleMenuItems.value = [
      { id: '__off', label: '关闭字幕', active: false },
      ...deduped.map((s: any, i: number) => ({
        id: `s${s.id}`,
        label: subtitleLabel(s, i),
        active: false,
      })),
      ...extSubs.map((s: any) => ({
        id: `l${s.lang}`,
        label: s.label ?? s.lang ?? '',
        active: !!s.active,
      })),
    ];

    // 音轨：内嵌轨 + 外部轨合并
    audioTracksInfo.value = [
      ...audios.map((a: any) => a.label ?? a.language ?? `音轨 ${a.id}`),
      ...extAudios.map((a: any) => a.label ?? a.lang ?? ''),
    ];
    audioMenuItems.value = [
      ...audios.map((a: any) => ({
        id: `a${a.id}`,
        label: a.label ?? a.language ?? `音轨 ${a.id}`,
        active: !!a.enabled,
      })),
      ...extAudios.map((a: any) => ({
        id: `l${a.lang}`,
        label: a.label ?? a.lang ?? '',
        active: !!a.active,
      })),
    ];
  } catch (err) {
    console.warn('[MoviPlayer] trackschange 解析失败:', err);
  }
};

// ==================== 字幕/音轨选择 ====================
const selectSubtitle = async (id: string) => {
  const el = mpRef.value;
  if (!el) return;
  try {
    if (id === '__off') {
      // 关闭字幕：
      //  - 内嵌轨用内部 player.selectSubtitleTrack(null) 关闭（元素公开 API 只有
      //    selectSubtitleLang，只管外部 <track>，关不掉内嵌轨）；
      //  - 外挂 <track> 用公开 selectSubtitleLang(null) + 禁用全部 track。
      await (el as any).player?.selectSubtitleTrack?.(null);
      await el.selectSubtitleLang?.(null).catch?.(() => null);
      el.querySelectorAll?.('track').forEach((t: any) => { t.track.mode = 'disabled'; });
    } else if (id.startsWith('ext')) {
      // 外挂 <track>：启用目标、禁用其他
      const idx = Number(id.slice(3));
      const tracks = el.querySelectorAll?.('track') ?? [];
      const extTracks = (props.subtitleUrls ?? []).length > 0
        ? Array.from(tracks).slice(-(props.subtitleUrls?.length ?? 0))
        : [];
      extTracks.forEach((t: any, i: number) => {
        t.track.mode = i === idx ? 'showing' : 'disabled';
      });
      await el.selectSubtitleLang?.(null).catch?.(() => null);
    } else if (id.startsWith('s')) {
      // 内嵌字幕轨切换：正确 API 是内部 player.selectSubtitleTrack(trackId)。
      // 注意：之前误用 el.selectSubtitleTrack —— 元素公开 API 里根本没有这个
      // 方法（它属于 private 的 player 内部对象），导致选择静默失败、
      // 任何视频都切不动字幕。trackId 是数字（可能为 0），必须转成数字——
      // `Number('0')` 是 0（falsy），不能用 `|| tid` 回退成字符串。
      const tid = Number(id.slice(1));
      const ok = await (el as any).player?.selectSubtitleTrack?.(
        Number.isFinite(tid) ? tid : null,
      ).catch?.(() => false);
      if (ok === false) {
        console.warn('[MoviPlayer] selectSubtitleTrack 失败:', id);
        // 选择失败：不要误标 active，并提示引擎限制
        subtitleMenuItems.value = subtitleMenuItems.value.map((m) => ({
          ...m,
          active: false,
        }));
        if (!isFullscreen.value) {
          ElMessage.warning(
            '当前播放引擎不支持切换内嵌字幕；可在设置中开启 WASM 引擎后重试',
          );
        } else {
          console.warn('[MoviPlayer] 引擎不支持内嵌字幕切换，已忽略');
        }
        return;
      }
    } else if (id.startsWith('l')) {
      // 外部语言轨
      await el.selectSubtitleLang?.(id.slice(1)).catch?.(() => null);
    }
    subtitleMenuItems.value = subtitleMenuItems.value.map((m) => ({
      ...m,
      active: m.id === id,
    }));
  } catch (err) {
    console.warn('[MoviPlayer] 切换字幕失败:', err);
  }
};

const selectAudio = async (id: string) => {
  const el = mpRef.value;
  if (!el) return;
  try {
    if (id.startsWith('a')) {
      // 内嵌音轨切换：正确 API 是内部 player.selectAudioTrack(trackId)。
      // 元素公开 API 没有 selectAudioTrack（只有 selectAudioLang 管外部轨），
      // 之前误用导致切换静默失败。trackId 是数字，可能为 0，
      // 必须转数字不能用 `|| tid` 回退。
      const tid = Number(id.slice(1));
      await (el as any).player?.selectAudioTrack?.(
        Number.isFinite(tid) ? tid : null,
      ).catch?.(() => null);
    } else if (id.startsWith('l')) {
      // 外部语言轨
      await el.selectAudioLang?.(id.slice(1)).catch?.(() => null);
    }
    audioMenuItems.value = audioMenuItems.value.map((m) => ({
      ...m,
      active: m.id === id,
    }));
  } catch (err) {
    console.warn('[MoviPlayer] 切换音轨失败:', err);
  }
};

// ==================== 播放控制 ====================
const playVideo = async () => {
  const el = mpRef.value;
  if (!el) return;
  try {
    await el.play();
    isPlaying.value = true;
    hideControlsDelayed();
  } catch (error) {
    console.warn('[MoviPlayer] play() 失败:', error);
    hasError.value = true;
    emit('error', error);
  }
};

const pauseVideo = () => {
  const el = mpRef.value;
  if (!el) return;
  try { el.pause(); } catch { /* noop */ }
  isPlaying.value = false;
  showControls.value = true;
};

const togglePlay = () => {
  if (isPlaying.value) {
    pauseVideo();
  } else {
    playVideo();
  }
};

const seekTo = (time: number) => {
  const el = mpRef.value;
  if (!el) return;
  try { el.currentTime = time; } catch { /* noop */ }
  currentTime.value = time;
};

const skipForward = () => {
  seekTo(Math.min(currentTime.value + timeStep.value, duration.value || currentTime.value + timeStep.value));
};

const skipBackward = () => {
  seekTo(Math.max(currentTime.value - timeStep.value, 0));
};

const setVolume = (vol: number) => {
  const el = mpRef.value;
  volume.value = vol;
  if (el) {
    el.volume = vol;
    el.muted = vol === 0;
  }
  isMuted.value = vol === 0;
};

const toggleMute = () => {
  const el = mpRef.value;
  isMuted.value = !isMuted.value;
  if (el) el.muted = isMuted.value;
};

const changeSpeed = (rate: number) => {
  playbackRate.value = rate;
  const el = mpRef.value;
  if (el) el.playbackRate = rate;
  appStore.setPlaySpeed(rate);
};

const toggleFullscreen = async () => {
  if (!playerContainer.value) return;
  try {
    if (!document.fullscreenElement) {
      await playerContainer.value.requestFullscreen();
      isFullscreen.value = true;
    } else {
      await document.exitFullscreen();
      isFullscreen.value = false;
    }
  } catch (error) {
    console.warn('[MoviPlayer] 全屏切换失败:', error);
  }
};

const toggleAppFullscreen = () => {
  isAppFullscreen.value = !isAppFullscreen.value;
  document.body.style.overflow = isAppFullscreen.value ? 'hidden' : '';
};

const togglePiP = async () => {
  const el = mpRef.value;
  if (!el) return;
  try {
    // movi-player 自带控件栏用的同一方法：内部会区分 native <video> 与
    // WASM(canvas) 两种引擎，分别走原生 PiP 或 Document PiP。元素暴露的
    // requestPictureInPicture() 兼容路径是坏的（会抛 NotSupportedError）。
    await el.togglePiP();
  } catch (error) {
    console.warn('[MoviPlayer] 画中画失败:', error);
  }
};

// ==================== 画面比例 / 跳过片头片尾 ====================
const changeAspectRatio = (mode: string) => {
  aspectRatio.value = mode;
  appStore.setScaleType(mode);
  const el = mpRef.value;
  if (!el) return;
  switch (mode) {
    case '16:9': el.style.objectFit = 'contain'; el.style.aspectRatio = '16 / 9'; break;
    case '4:3': el.style.objectFit = 'contain'; el.style.aspectRatio = '4 / 3'; break;
    case 'fill': el.style.objectFit = 'fill'; el.style.aspectRatio = ''; break;
    case 'original': el.style.objectFit = 'none'; el.style.aspectRatio = ''; break;
    case 'crop': el.style.objectFit = 'cover'; el.style.aspectRatio = ''; break;
    default: el.style.objectFit = 'contain'; el.style.aspectRatio = ''; break;
  }
};

const setTimeStep = (step: number) => {
  timeStep.value = step;
  localStorage.setItem('tvbox_time_step', String(step));
};

const toggleSkipIntro = () => {
  if (skipIntro.value > 0) {
    skipIntro.value = 0;
  } else {
    skipIntro.value = Math.floor(currentTime.value);
  }
  appStore.setSkipIntro(skipIntro.value);
};

const toggleSkipOutro = () => {
  if (skipOutro.value > 0) {
    skipOutro.value = 0;
  } else {
    const remaining = duration.value - currentTime.value;
    skipOutro.value = Math.floor(remaining);
  }
  appStore.setSkipOutro(skipOutro.value);
};

const skipToIntroEnd = () => {
  if (skipIntro.value > 0) seekTo(skipIntro.value);
};

const skipToOutroEnd = () => {
  if (duration.value > 0) {
    seekTo(duration.value);
    emit('next');
  }
};

// ==================== 锁屏 ====================
const lockScreen = () => {
  screenLocked.value = true;
  showControls.value = false;
};

const unlockScreen = () => {
  screenLocked.value = false;
  showControls.value = true;
  hideControlsDelayed();
};

// ==================== 控制栏显隐 ====================
function hasOpenPopper() {
  const poppers = document.querySelectorAll('.el-popper');
  for (const p of poppers) {
    const style = getComputedStyle(p);
    if (style.display !== 'none' && p.getBoundingClientRect().width > 0) return true;
  }
  return false;
}

function hideControlsDelayed() {
  if (controlsTimer) clearTimeout(controlsTimer);
  showControls.value = true;
  controlsTimer = setTimeout(() => {
    if (isPlaying.value && !screenLocked.value && !hasOpenPopper() && !showDanmuSettings.value) {
      showControls.value = false;
    }
  }, 5000);
}

// ==================== 双击 / 长按手势 ====================
const onDoubleClick = (e: MouseEvent) => {
  if (screenLocked.value) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const x = e.clientX - rect.left;
  const third = rect.width / 3;

  if (x < third) {
    skipBackward();
    showClickFeedback(e.offsetX, e.offsetY, '⏪');
  } else if (x > third * 2) {
    skipForward();
    showClickFeedback(e.offsetX, e.offsetY, '⏩');
  } else {
    togglePlay();
    const r2 = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showClickFeedback(r2.width / 2, r2.height / 2, isPlaying.value ? '⏸' : '▶');
  }
};

const showClickFeedback = (x: number, y: number, icon: string) => {
  if (clickFeedbackTimer) clearTimeout(clickFeedbackTimer);
  clickFeedback.value = { x, y, icon };
  clickFeedbackTimer = setTimeout(() => { clickFeedback.value = null }, 800);
};

const onMouseDown = (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  if (target.closest('.vp-icon-btn') || target.closest('.vp-episode-btn') ||
    target.closest('.el-dropdown') || target.closest('.el-dropdown-menu') ||
    target.closest('.el-switch') || target.closest('.vp-danmu-panel') ||
    target.closest('.el-slider') || target.closest('.el-button') ||
    target.closest('.vp-overlay-top') || target.closest('.el-select') ||
    target.closest('.vp-seek-bar') || target.closest('.vp-volume-slider') ||
    target.closest('.vp-overlay-bottom')) {
    return;
  }

  mouseDownTime = Date.now();
  mouseDownX = e.clientX;
  mouseDownY = e.clientY;

  longPressTimer = setTimeout(() => {
    if (screenLocked.value) return;
    longPressActive.value = true;
    savedPlaybackRate = playbackRate.value;
    if (savedPlaybackRate < 3) {
      changeSpeed(3);
    }
  }, 500);
};

const onMouseUp = (e: MouseEvent) => {
  const target = e.target as HTMLElement;

  if (target.closest('.vp-icon-btn') || target.closest('.vp-episode-btn') ||
    target.closest('.el-dropdown') || target.closest('.el-dropdown-menu') ||
    target.closest('.el-switch') || target.closest('.vp-danmu-panel') ||
    target.closest('.el-slider') || target.closest('.el-button') ||
    target.closest('.vp-overlay-top') || target.closest('.el-select') ||
    target.closest('.vp-seek-bar') || target.closest('.vp-volume-slider') ||
    target.closest('.vp-overlay-bottom')) {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (longPressActive.value) {
      longPressActive.value = false;
      changeSpeed(savedPlaybackRate);
    }
    return;
  }

  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  if (longPressActive.value) {
    longPressActive.value = false;
    changeSpeed(savedPlaybackRate);
    return;
  }

  const moved = Math.abs(e.clientX - mouseDownX) + Math.abs(e.clientY - mouseDownY);
  if (moved < 10 && Date.now() - mouseDownTime < 300) {
    if (screenLocked.value) {
      showControls.value = true;
      setTimeout(() => { showControls.value = false }, 2000);
    } else {
      showControls.value = !showControls.value;
      if (showControls.value) hideControlsDelayed();
    }
  }
};

// 注：控制栏显隐只通过点击切换（onMouseUp），不再监听鼠标移动悬浮显示。

// ==================== 键盘快捷键 ====================
const onKeyDown = (e: KeyboardEvent) => {
  if (screenLocked.value && e.key !== 'Escape' && e.key !== 'q') return;
  switch (e.key) {
    case ' ':
    case 'k': togglePlay(); e.preventDefault(); break;
    case 'ArrowRight': skipForward(); e.preventDefault(); break;
    case 'ArrowLeft': skipBackward(); e.preventDefault(); break;
    case 'ArrowUp': setVolume(Math.min(1, volume.value + 0.1)); e.preventDefault(); break;
    case 'ArrowDown': setVolume(Math.max(0, volume.value - 0.1)); e.preventDefault(); break;
    case 'f':
    case 'F11': toggleFullscreen(); e.preventDefault(); break;
    case 'm': toggleMute(); e.preventDefault(); break;
    case 'd': toggleDanmu(); e.preventDefault(); break;
    case 'Escape':
      if (screenLocked.value) unlockScreen();
      else if (isFullscreen.value) toggleFullscreen();
      break;
    case 'q': if (screenLocked.value) unlockScreen(); break;
    case 'n': emit('next'); e.preventDefault(); break;
    case 'p': emit('prev'); e.preventDefault(); break;
    case 'l': lockScreen(); e.preventDefault(); break;
  }
};

// ==================== 遥控器 ====================
const onRemoteControl = (e: Event) => {
  const detail = (e as CustomEvent).detail;
  if (!detail?.action) return;
  switch (detail.action) {
    case 'play': playVideo(); break;
    case 'pause':
      if (isPlaying.value) pauseVideo();
      break;
    case 'toggle': togglePlay(); break;
    case 'forward': skipForward(); break;
    case 'backward': skipBackward(); break;
    case 'next': emit('next'); break;
    case 'prev': emit('prev'); break;
    case 'fullscreen': toggleFullscreen(); break;
    case 'mute': toggleMute(); break;
  }
};

const onFullscreenChange = () => {
  isFullscreen.value = !!document.fullscreenElement;
};

// ==================== Helpers ====================
function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ==================== Store <-> Local sync watchers ====================
watch(
  () => appStore.playSpeed,
  (v) => {
    if (Math.abs(v - playbackRate.value) > 1e-3) {
      playbackRate.value = v;
      const el = mpRef.value;
      if (el) el.playbackRate = v;
    }
  },
);
watch(
  () => appStore.scaleType,
  (v) => {
    if (v !== aspectRatio.value) {
      aspectRatio.value = v;
      changeAspectRatio(v);
    }
  },
);
watch(
  () => appStore.skipIntro,
  (v) => {
    if (v !== skipIntro.value) skipIntro.value = v;
  },
);
watch(
  () => appStore.skipOutro,
  (v) => {
    if (v !== skipOutro.value) skipOutro.value = v;
  },
);

// ==================== 初始化 ====================
const initPlayer = () => {
  const el = mpRef.value;
  if (!el || !props.url) return;
  hasError.value = false;
  isPlaying.value = false;
  isLoading.value = true;
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }

  // 基础属性（关闭自带控件栏，使用自建控制栏）
  el.src = props.url;
  el.controls = false;
  el.autoplay = props.autoplay;
  el.nohotkeys = true;
  if (props.poster) el.poster = props.poster;
  if (props.title) el.title = props.title;
  // 引擎优先级：MKV/HEVC/AV1 等原生内核不支持的格式用 wasm 解析；
  // 普通直链(MP4/TS)与 do=stream 代理流默认用 native，避免 wasm 打开失败
  // 再回退导致的错误闪烁与启动变慢。
  const lower = (props.url || '').toLowerCase();
  // 代理/直链 URL 中文件名可能是双重编码的（filename%253D...%252Emkv），
  // 解码两次后在整个 URL 上匹配视频扩展名（不限定 filename/name 参数，
  // 夸克 url= 参数内的文件名同样参与判定，由 wasm 引擎正常接管）。
  const needsWasm =
    /\.(mkv|webm|avi|mov|flv|wmv)([?#]|$)/i.test(lower) ||
    (() => {
      try {
        let dec = props.url || '';
        for (let i = 0; i < 2; i++) dec = decodeURIComponent(dec);
        return /\.(mkv|webm|avi|mov|flv|wmv)(?:[?#&]|$)/i.test(dec);
      } catch {
        return false;
      }
    })();
  // 设置项：设置页「直链 WASM 引擎」（localStorage['tvbox_prefer_wasm']）开启时，
  // do=stream 的 MP4 直链也强制 wasm 优先，以获得内嵌字幕轨切换
  // （native 的 Chromium <video> 不支持）。wasm 打开失败时 movi-player 会
  // 自动回退到后续引擎，播放不受影响。
  const preferWasmForStream =
    typeof localStorage !== 'undefined' &&
    localStorage.getItem('tvbox_prefer_wasm') === 'true' &&
    /\/proxy\?/i.test(props.url);
  el.engine =
    needsWasm || preferWasmForStream
      ? 'wasm hlsjs shaka native'
      : 'native hlsjs shaka wasm';
  // 断点续播
  if (props.resumeProgress > 0) el.startat = props.resumeProgress;
  // 夸克等 CDN 鉴权头（Referer/Cookie）——注意 headers 是「对象属性」，不是 JSON 字符串
  if (props.headers && Object.keys(props.headers).length > 0) {
    el.headers = { ...props.headers };
  }

  // 事件监听（movi-player 事件；先移除避免重复绑定）
  el.removeEventListener('ended', onEnded);
  el.removeEventListener('statechange', onStateChange);
  el.removeEventListener('timeupdate', onTimeUpdate);
  el.removeEventListener('error', onError);
  el.removeEventListener('trackschange', onTracksChange);
  el.addEventListener('ended', onEnded);
  el.addEventListener('statechange', onStateChange);
  el.addEventListener('timeupdate', onTimeUpdate);
  el.addEventListener('error', onError);
  el.addEventListener('trackschange', onTracksChange);

  // 主动查询一次外部语言轨（trackschange 事件可能已在监听绑定前触发，
  // 或部分容器不派发该事件；外部轨可用元素公开 API 兜底查询）
  setTimeout(() => {
    try {
      const el2 = mpRef.value;
      if (!el2) return;
      const extSubs: any[] = el2.getSubtitleLangs?.() ?? [];
      const extAudios: any[] = el2.getAudioLangs?.() ?? [];
      if (extSubs.length > 0 || extAudios.length > 0) {
        onTracksChange({ detail: { subtitle: [], audio: [] } });
      }
    } catch { /* noop */ }
  }, 1500);
};

// ==================== Expose ====================
const loadSubtitleContent = (content: string) => {
  const el = mpRef.value;
  if (!el || !content) return;
  try {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.src = url;
    track.label = '外部字幕';
    track.setAttribute('srclang', 'zh');
    track.setAttribute('data-format', 'srt');
    track.setAttribute('data-default', '');
    el.appendChild(track);
    console.log('[MoviPlayer] 外部字幕已注入:', url);
  } catch (e) {
    console.warn('[MoviPlayer] 字幕注入失败:', e);
  }
};

defineExpose({
  loadSubtitleContent,
  toggleDanmu,
  get element() { return mpRef.value; },
});

// ==================== Watchers ====================
watch(() => props.url, () => { initPlayer(); });
watch(() => props.danmuUrl, (newUrl) => {
  if (newUrl) loadDanmu(newUrl);
});
watch(() => props.subtitleUrls, () => {
  const el = mpRef.value;
  if (!el) return;
  const existing = props.subtitleUrls ?? [];
  for (const s of existing) {
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.src = s.url;
    track.label = s.name;
    track.setAttribute('data-format', s.url.endsWith('.srt') ? 'srt' : 'vtt');
    el.appendChild(track);
  }
  if (existing.length > 0) {
    subtitleMenuItems.value = [
      { id: '__off', label: '关闭字幕', active: false },
      ...existing.map((s, i) => ({
        id: `ext${i}`,
        label: s.name,
        active: false,
      })),
    ];
  }
});
watch(playbackRate, (val) => {
  const el = mpRef.value;
  if (el) el.playbackRate = val;
});

// ==================== Provide 上下文（供控制栏子组件共享） ====================
const ctx: PlayerCtx = reactive({
  // 播放状态
  showControls,
  screenLocked,
  hasError,
  isLoading,
  isPlaying,
  isAppFullscreen,
  isFullscreen,
  currentTime,
  duration,
  buffered,
  volume,
  isMuted,
  progressPercent,
  formattedCurrentTime,
  formattedDuration,
  // 业务状态
  playbackRate,
  timeStep,
  aspectRatio,
  aspectRatios,
  skipIntro,
  skipOutro,
  skipIndicator,
  showMorePanel,
  // 弹幕
  danmuEnabled,
  danmuOpacity,
  danmuSpeedIndex,
  danmuSpeedOptions,
  danmuLines,
  danmuColorMode,
  showDanmuSettings,
  // 字幕/音轨
  audioMenuItems,
  subtitleMenuItems,
  // props 派生
  get title() { return props.title; },
  get hasPrev() { return props.hasPrev; },
  get hasNext() { return props.hasNext; },
  get showSubtitleSearch() { return props.showSubtitleSearch; },
  // 动作
  emitPrev: () => emit('prev'),
  emitNext: () => emit('next'),
  emitSearchSubtitle: () => emit('searchSubtitle'),
  togglePlay,
  playVideo,
  pauseVideo,
  seekTo,
  skipForward,
  skipBackward,
  setVolume,
  toggleMute,
  changeSpeed,
  setTimeStep,
  changeAspectRatio,
  toggleSkipIntro,
  toggleSkipOutro,
  togglePiP,
  toggleFullscreen,
  toggleAppFullscreen,
  lockScreen,
  toggleDanmu,
  selectAudio,
  selectSubtitle,
});
provide('moviPlayerCtx', ctx);

// ==================== Mount ====================
onMounted(() => {
  initPlayer();
  hideControlsDelayed();
  if (props.danmuUrl) loadDanmu(props.danmuUrl);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  window.addEventListener('remote-control', onRemoteControl);
});

onUnmounted(() => {
  const el = mpRef.value;
  if (el) {
    el.removeEventListener('ended', onEnded);
    el.removeEventListener('statechange', onStateChange);
    el.removeEventListener('timeupdate', onTimeUpdate);
    el.removeEventListener('error', onError);
    el.removeEventListener('trackschange', onTracksChange);
    try { el.destroy?.(); } catch { /* noop */ }
  }
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  window.removeEventListener('remote-control', onRemoteControl);
  for (const d of activeDanmuEls) d.remove();
  activeDanmuEls.length = 0;
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
  if (controlsTimer) clearTimeout(controlsTimer);
  if (longPressTimer) clearTimeout(longPressTimer);
  if (clickFeedbackTimer) clearTimeout(clickFeedbackTimer);
  document.body.style.overflow = '';
});
</script>

<template>
  <!-- 应用全屏时 Teleport 到 body，使 .app-fullscreen 的 position:fixed 铺满窗口 -->
  <Teleport to="body" :disabled="!isAppFullscreen">
    <div ref="playerContainer" class="video-player-wrapper relative w-full h-full bg-black select-none"
      :class="{ 'app-fullscreen': isAppFullscreen }" tabindex="0" @keydown="onKeyDown" @mousedown="onMouseDown"
      @mouseup="onMouseUp" @dblclick="onDoubleClick">
      <!-- movi-player 元素（关闭自带控件栏，由自建控制栏接管） -->
      <movi-player ref="mpRef" class="w-full h-full block"></movi-player>

    <!-- 弹幕层 -->
    <div ref="danmuContainer" class="absolute top-0 left-0 w-full h-3/4 pointer-events-none overflow-hidden z-10">
    </div>

    <!-- 加载遮罩 -->
    <div v-if="isLoading" class="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
      <div class="flex flex-col items-center gap-3">
        <div class="vp-buffering-spinner"></div>
        <div class="text-sm" style="color: rgba(255,255,255,0.8);">加载中...</div>
      </div>
    </div>

    <!-- 错误遮罩 -->
    <div v-if="hasError" class="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
      <div class="bg-red-500/80 text-white px-4 py-2 rounded-lg text-sm">播放失败，请重试</div>
    </div>

    <!-- 跳过提示 -->
    <div v-if="skipIndicator"
      class="absolute bottom-28 right-8 text-sm px-3 py-1.5 rounded pointer-events-auto cursor-pointer z-20"
      style="background: var(--color-primary); color: #fff"
      @click="skipIndicator === '跳过片头' ? skipToIntroEnd() : skipToOutroEnd()">
      {{ skipIndicator }}
    </div>

    <!-- 双击反馈 -->
    <div v-if="clickFeedback" class="absolute pointer-events-none z-20"
      :style="{ left: clickFeedback.x + 'px', top: clickFeedback.y + 'px' }">
      <div
        class="text-white text-2xl font-bold bg-black/50 w-12 h-12 rounded-full flex items-center justify-center -translate-x-1/2 -translate-y-1/2">
        {{ clickFeedback.icon }}
      </div>
    </div>

    <!-- 锁屏 overlay -->
    <div v-if="screenLocked"
      class="vp-locked-overlay absolute inset-0 z-35 flex items-center justify-center pointer-events-none"
      style="background: rgba(10,11,16,0.3);">
      <div class="flex items-center gap-6">
        <button class="vp-locked-btn pointer-events-auto flex items-center justify-center rounded-full"
          @click="unlockScreen" aria-label="解锁">
          <el-icon :size="24" style="color: #ffffff;">
            <Unlock />
          </el-icon>
        </button>
        <button class="vp-locked-btn pointer-events-auto flex items-center justify-center rounded-full"
          @click="togglePlay" aria-label="播放">
          <el-icon :size="24" style="color: #ffffff;">
            <component :is="isPlaying ? VideoPause : VideoPlay" />
          </el-icon>
        </button>
        <button class="vp-locked-btn pointer-events-auto flex items-center justify-center rounded-full"
          @click="toggleFullscreen" aria-label="全屏">
          <el-icon :size="24" style="color: #ffffff;">
            <FullScreen />
          </el-icon>
        </button>
      </div>
    </div>

    <!-- 长按快进提示 -->
    <div v-if="longPressActive"
      class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-20">
      <div class="flex items-center gap-2 px-4 py-2 rounded-lg"
        style="background: var(--color-bg-glass-heavy); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur); border: var(--glass-border);">
        <el-icon :size="20" style="color: var(--color-primary);">
          <DArrowRight />
        </el-icon>
        <span class="text-sm font-medium" style="color: #ffffff;">{{ playbackRate }}x 快进</span>
      </div>
    </div>

      <!-- 顶栏 + 底栏 + 弹幕设置（自建控制栏，显隐同步） -->
      <PlayerTopBar v-if="showControls && !screenLocked && !hasError" />
      <PlayerBottomBar v-if="showControls && !screenLocked && !hasError" />
      <PlayerDanmuPanel v-if="showDanmuSettings && showControls && !screenLocked" />
    </div>
  </Teleport>
</template>

<style scoped>
.video-player-wrapper {
  outline: none;
}

.video-player-wrapper.app-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 9999;
  border-radius: 0;
}

/* ===== Buffering Spinner ===== */
.vp-buffering-spinner {
  width: 40px;
  height: 40px;
  border: 2.5px solid rgba(255, 255, 255, 0.1);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: vp-spin 0.8s linear infinite;
}

@keyframes vp-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ===== Locked Overlay ===== */
.vp-locked-overlay {
  z-index: 35;
}

.vp-locked-btn {
  width: 56px;
  height: 56px;
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur-heavy);
  -webkit-backdrop-filter: var(--glass-blur-heavy);
  border: var(--glass-border);
  cursor: pointer;
  transition: all 150ms ease;
}

.vp-locked-btn:hover {
  background: var(--color-bg-glass-light);
  transform: scale(1.05);
}
</style>
