<script setup lang="ts">
/**
 * MoviPlayer 播放器组件 - 基于 movi-player (WebCodecs + FFmpeg WASM)
 *
 * 相比原生 <video> 的优势：
 *  1. 可播放 MKV/HEVC/AV1/4K HDR 等原生内核不支持的格式
 *  2. 自动发现 MKV/MP4 容器内嵌字幕轨与多音轨（含 PGS/DVB 图形字幕）
 *  3. 自带完整 UI（字幕菜单、音轨菜单、倍速、画中画、全屏等）
 *  4. headers 属性可为所有媒体请求附加自定义请求头（解决夸克 CDN 的
 *     Referer/Cookie 鉴权 403）
 */
import { ref, onMounted, onUnmounted, watch } from 'vue';
import 'movi-player/element';
import { DanmuEngine } from '../core/DanmuEngine';
import axios from 'axios';
import { checkReplaceProxy, getLocalProxy } from '../core/ConfigParser';
import { useAppStore } from '../store/app';
import type { MediaTrack } from '../core/models';
import { ArrowLeft, ArrowRight } from '@element-plus/icons-vue';

// 注：<movi-player> 作为原生自定义元素渲染的 isCustomElement 配置
// 已在 vite.config.ts 的 vue() 插件中统一设置（runtime-only 构建不支持
// 在组件内通过 defineOptions.compilerOptions 配置，会触发 Vue 警告）。

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
// 是否已真正进入播放（用于判断 wasm 引擎失败后是否回退成功）
const isPlaying = ref(false);

// 弹幕
const danmuEngine = new DanmuEngine();
const danmuEnabled = ref(localStorage.getItem('tvbox_danmu_enabled') === 'true');
const danmuMaxOnScreen = ref(Number(localStorage.getItem('tvbox_danmu_max') || '30'));
const danmuLines = ref(Number(localStorage.getItem('tvbox_danmu_lines') || '8'));
const danmuOpacity = ref(Number(localStorage.getItem('tvbox_danmu_opacity') || '0.7'));
const danmuSpeed = ref(Number(localStorage.getItem('tvbox_danmu_speed') || '8'));
const danmuFontSize = ref(Number(localStorage.getItem('tvbox_danmu_fontsize') || '24'));
const activeDanmuEls: HTMLElement[] = [];
const showDanmuSettings = ref(false);

danmuEngine.setEnabled(danmuEnabled.value);
danmuEngine.setMaxOnScreen(danmuMaxOnScreen.value);
danmuEngine.setOpacity(danmuOpacity.value);
danmuEngine.setSpeed(danmuSpeed.value);
danmuEngine.setFontSize(danmuFontSize.value);

// 字幕/音轨（自建下拉菜单用；movi-player 内部对单音轨/单字幕轨会隐藏自带菜单，
// 但用户仍希望"只有一个也应可选"，因此这里自行暴露）
const subtitleTracksInfo = ref<string[]>([]);
const audioTracksInfo = ref<string[]>([]);
const subtitleMenuItems = ref<{ id: string; label: string; active: boolean }[]>([]);
const audioMenuItems = ref<{ id: string; label: string; active: boolean }[]>([]);

// ==================== 画面比例 / 跳过片头片尾 / 应用全屏 / 更多 ====================
const aspectRatio = ref(localStorage.getItem('tvbox_scale_type') || 'default');
const aspectRatios = [
  { label: '默认', value: 'default' },
  { label: '16:9', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '填充', value: 'fill' },
  { label: '原始', value: 'original' },
  { label: '裁剪', value: 'crop' },
];
const timeStep = ref(Number(localStorage.getItem('tvbox_time_step') || '10'));
const skipIntro = ref(Number(localStorage.getItem('tvbox_skip_intro') || '0'));
const skipOutro = ref(Number(localStorage.getItem('tvbox_skip_outro') || '0'));
const skipIndicator = ref('');
const isAppFullscreen = ref(false);
const showMorePanel = ref(false);

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
    el.style.position = 'absolute';
    el.style.whiteSpace = 'nowrap';
    el.style.fontSize = `${item.fontSize}px`;
    el.style.fontWeight = 'bold';
    el.style.textShadow = '1px 1px 2px rgba(0,0,0,0.8)';
    el.style.color = item.color;
    el.style.opacity = String(danmuOpacity.value);
    el.style.transition = 'transform 0.1s linear';
    if (item.type === 0) {
      el.style.top = `${Math.floor(Math.random() * (danmuContainer.value.clientHeight - 30))}px`;
      el.style.left = `${danmuContainer.value.clientWidth}px`;
      const durationMs = danmuSpeed.value * 1000;
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

const onDanmuToggle = (val: boolean) => {
  danmuEngine.setEnabled(val);
  localStorage.setItem('tvbox_danmu_enabled', String(val));
  if (!val) {
    for (const el of activeDanmuEls) el.remove();
    activeDanmuEls.length = 0;
  }
};

// ==================== movi-player 事件 ====================
// movi-player 会派发标准 ended/play/pause/playing/waiting 事件，
// 以及 statechange（detail 为 PlayerState 字符串）、timeupdate、
// error、trackschange 等自定义事件。ended 两者都会触发，只处理其一。

const onEnded = () => emit('ended');

const onStateChange = (e: any) => {
  const state = e.detail ?? '';
  switch (state) {
    case 'playing':
      isPlaying.value = true;
      isLoading.value = false;
      hasError.value = false;
      break;
    case 'ready':
      isLoading.value = false;
      hasError.value = false;
      if (state === 'ready') emit('ready');
      break;
    case 'error':
      hasError.value = true;
      isLoading.value = false;
      break;
    default:
      break;
    // 注意：ended 由标准 ended 事件处理（元素同时派发两者，避免重复 emit）
  }
};

const onTimeUpdate = (e: any) => {
  const el = mpRef.value;
  const t = typeof e.detail === 'number' ? e.detail : el?.currentTime ?? 0;
  currentTime.value = t;
  duration.value = el?.duration || 0;
  emit('progress', currentTime.value, duration.value);
  if (danmuEnabled.value) renderDanmu(currentTime.value);

  // 自动跳过片尾 → 触发下一集
  if (skipOutro.value > 0 && duration.value > 0 && props.hasNext &&
    currentTime.value + skipOutro.value >= duration.value) {
    emit('next');
    skipOutro.value = 0;
    localStorage.setItem('tvbox_skip_outro', '0');
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
// 策略：收到 error 时延时 1.5s，若期间进入 playing（说明已回退成功）则不提示；
// 仅当 statechange: error（真正的致命错误）才立即显示遮罩。
let errorTimer: ReturnType<typeof setTimeout> | null = null;
const onError = (e: any) => {
  console.warn('[MoviPlayer] error(可能已回退引擎):', e.detail ?? e);
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    // 1.5s 后仍未进入 playing → 判定播放确实失败
    if (!isPlaying.value) {
      hasError.value = true;
      isLoading.value = false;
      emit('error', e.detail ?? e);
    }
  }, 1500);
};

const onTracksChange = (e: any) => {
  const el = mpRef.value;
  const detail = e.detail ?? {};
  try {
    // detail.subtitle = 内嵌字幕轨（含 MKV/MP4 容器内嵌轨）
    const subs: any[] = detail.subtitle ?? el?.getSubtitleTracks?.() ?? [];
    const extSubs: any[] = el?.getSubtitleLangs?.() ?? [];
    // 内嵌轨 + 外部轨合并；外部轨用 lang 区分，内嵌轨用 id
    subtitleTracksInfo.value = [
      ...subs.map((s: any) =>
        `${s.label ?? s.language ?? `字幕 ${s.id}`}${s.subtitleType === 'image' ? ' [图形]' : ''}`,
      ),
      ...extSubs.map((s: any) => `${s.label ?? s.lang ?? ''}`),
    ];
    subtitleMenuItems.value = [
      { id: '__off', label: '关闭字幕', active: false },
      ...subs.map((s: any) => ({
        id: `s${s.id}`,
        label: s.label ?? s.language ?? `字幕 ${s.id}`,
        active: false,
      })),
      ...extSubs.map((s: any) => ({
        id: `l${s.lang}`,
        label: s.label ?? s.lang ?? '',
        active: !!s.active,
      })),
    ];

    const audios: any[] = detail.audio ?? el?.getAudioTracks?.() ?? [];
    const extAudios: any[] = el?.getAudioLangs?.() ?? [];
    audioTracksInfo.value = [
      ...audios.map((a: any) => a.label ?? a.language ?? `音轨 ${a.id}`),
      ...extAudios.map((a: any) => a.label ?? a.lang ?? ''),
    ];
    audioMenuItems.value = [
      ...audios.map((a: any) => ({
        id: `a${a.id}`,
        label: a.label ?? a.language ?? `音轨 ${a.id}`,
        active: false,
      })),
      ...extAudios.map((a: any) => ({
        id: `l${a.lang}`,
        label: a.label ?? a.lang ?? '',
        active: !!a.active,
      })),
    ];
    if (subs.length > 0 || extSubs.length > 0) {
      console.log('[MoviPlayer] trackschange 字幕轨:', subtitleTracksInfo.value);
    }
    if (audios.length > 0 || extAudios.length > 0) {
      console.log('[MoviPlayer] trackschange 音轨:', audioTracksInfo.value);
    }
  } catch (err) {
    console.warn('[MoviPlayer] trackschange 解析失败:', err);
  }
};

// ==================== 字幕/音轨选择 ====================
// 用元素公开 API 切换：内嵌轨走 selectSubtitleTrack/selectAudioTrack(id)，
// 外部/语言轨走 selectSubtitleLang/selectAudioLang(lang)。
const selectSubtitle = async (id: string) => {
  const el = mpRef.value;
  if (!el) return;
  try {
    if (id === '__off') {
      // 关闭所有字幕
      await el.selectSubtitleLang?.(null);
      await el.selectSubtitleTrack?.(-1).catch(() => null);
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
      await el.selectSubtitleLang?.(null);
    } else if (id.startsWith('s')) {
      await el.selectSubtitleTrack?.(Number(id.slice(1)));
    } else if (id.startsWith('l')) {
      await el.selectSubtitleLang?.(id.slice(1));
    }
    // 更新选中状态
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
      await el.selectAudioTrack?.(Number(id.slice(1)));
    } else if (id.startsWith('l')) {
      await el.selectAudioLang?.(id.slice(1));
    }
    audioMenuItems.value = audioMenuItems.value.map((m) => ({
      ...m,
      active: m.id === id,
    }));
  } catch (err) {
    console.warn('[MoviPlayer] 切换音轨失败:', err);
  }
};

// ==================== movi-player 自定义控件栏 ====================
// 复用 movi-player 自带控件栏（进度条/播放/音量/倍速/画中画/全屏），
// 仅把业务按钮（搜索字幕/音轨/字幕/弹幕）注入其控件栏，不重建底层控件。
const MOV_SEARCH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
const MOV_AUDIO_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></svg>';
const MOV_SUBTITLE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><path d="M7 12h4"/><path d="M15 12h2"/><path d="M7 15h2"/><path d="M15 15h2"/></svg>';
const MOV_DANMU_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6a2 2 0 0 1-2-2v-2"/><path d="M6 13h4"/><path d="M6 17h4"/></svg>';
const MOV_NEXT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
const MOV_MORE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
const MOV_APPFS_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';

let controlsRegistered = false;
const registerMoviControls = (el: any) => {
  if (controlsRegistered || !el || typeof el.addControl !== 'function') return;
  controlsRegistered = true;
  // 搜索字幕（普通按钮）
  if (props.showSubtitleSearch) {
    el.addControl({
      id: 'movi-search-sub',
      placement: 'bar',
      title: '搜索字幕',
      icon: MOV_SEARCH_ICON,
      onSelect: () => emit('searchSubtitle'),
    });
  }
  // 音轨（子菜单）
  el.addControl({
    id: 'movi-audio',
    placement: 'both',
    title: '音轨',
    icon: MOV_AUDIO_ICON,
    items: audioMenuItems.value.map((m) => ({ id: m.id, label: m.label })),
    value: audioMenuItems.value.find((m) => m.active)?.id ?? '',
    onPick: (itemId: string) => selectAudio(itemId),
  });
  // 字幕（子菜单）
  el.addControl({
    id: 'movi-subtitle',
    placement: 'both',
    title: '字幕',
    icon: MOV_SUBTITLE_ICON,
    items: subtitleMenuItems.value.map((m) => ({ id: m.id, label: m.label })),
    value: subtitleMenuItems.value.find((m) => m.active)?.id ?? '',
    onPick: (itemId: string) => selectSubtitle(itemId),
  });
  // 弹幕（开关）
  el.addControl({
    id: 'movi-danmu',
    placement: 'bar',
    title: '弹幕',
    icon: MOV_DANMU_ICON,
    toggle: true,
    active: danmuEnabled.value,
    onSelect: (active: boolean) => setDanmu(active),
  });
  // 下一集
  if (props.hasNext) {
    el.addControl({
      id: 'movi-next',
      placement: 'bar',
      title: '下一集',
      icon: MOV_NEXT_ICON,
      onSelect: () => emit('next'),
    });
  }
  // 更多设置（片头/片尾跳过·画面比例·步长）
  el.addControl({
    id: 'movi-more',
    placement: 'bar',
    title: '更多设置',
    icon: MOV_MORE_ICON,
    onSelect: () => { showMorePanel.value = !showMorePanel.value; },
  });
  // 应用全屏（整个窗口铺满）
  el.addControl({
    id: 'movi-appfs',
    placement: 'bar',
    title: '应用全屏',
    icon: MOV_APPFS_ICON,
    toggle: true,
    active: isAppFullscreen.value,
    onSelect: (active: boolean) => toggleAppFullscreen(active),
  });
};

// 选择状态变化时同步到 movi 控件栏（高亮当前项）
const syncMoviControlValues = () => {
  const el = mpRef.value;
  if (!el || typeof el.updateControl !== 'function') return;
  el.updateControl('movi-audio', {
    items: audioMenuItems.value.map((m) => ({ id: m.id, label: m.label })),
    value: audioMenuItems.value.find((m) => m.active)?.id ?? '',
  });
  el.updateControl('movi-subtitle', {
    items: subtitleMenuItems.value.map((m) => ({ id: m.id, label: m.label })),
    value: subtitleMenuItems.value.find((m) => m.active)?.id ?? '',
  });
};

// ==================== 画面比例 / 跳过 / 应用全屏 ====================
const applyVideoFit = (mode: string) => {
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
const changeAspectRatio = (mode: string) => {
  aspectRatio.value = mode;
  localStorage.setItem('tvbox_scale_type', mode);
  applyVideoFit(mode);
};
const setTimeStep = (step: number) => {
  timeStep.value = step;
  localStorage.setItem('tvbox_time_step', String(step));
};
const toggleSkipIntro = () => {
  skipIntro.value = skipIntro.value > 0 ? 0 : Math.floor(currentTime.value);
  localStorage.setItem('tvbox_skip_intro', String(skipIntro.value));
};
const toggleSkipOutro = () => {
  const left = duration.value > 0 ? duration.value - currentTime.value : 0;
  skipOutro.value = skipOutro.value > 0 ? 0 : Math.floor(left);
  localStorage.setItem('tvbox_skip_outro', String(skipOutro.value));
};
const toggleAppFullscreen = (force?: boolean) => {
  isAppFullscreen.value = force ?? !isAppFullscreen.value;
  document.body.style.overflow = isAppFullscreen.value ? 'hidden' : '';
};

// ==================== 初始化 ====================
const initPlayer = () => {
  const el = mpRef.value;
  if (!el || !props.url) return;
  hasError.value = false;
  isPlaying.value = false;
  isLoading.value = true;
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }

  // 基础属性
  el.src = props.url;
  el.controls = true;
  el.autoplay = props.autoplay;
  // 注入自定义控件到 movi-player 自带控件栏（进度条/播放/音量等用自带栏）
  if (typeof el.addControl === 'function') {
    registerMoviControls(el);
  } else {
    customElements.whenDefined('movi-player').then(() => registerMoviControls(el));
  }
  // 应用已保存的画面比例
  applyVideoFit(aspectRatio.value);
  if (props.poster) el.poster = props.poster;
  if (props.title) el.title = props.title;
  // 引擎优先级：MKV/HEVC/AV1 等原生内核不支持的格式用 wasm 解析；
  // 普通直链(MP4/TS)与 do=stream 代理流直接用 native，避免 wasm 打开失败
  // 再回退导致的错误闪烁与启动变慢。
  const lower = (props.url || '').toLowerCase();
  const needsWasm =
    /\.(mkv|webm|avi|mov|flv|wmv)([?#]|$)/i.test(lower) ||
    // goproxy/代理 URL 中文件名是双重编码的（filename%253D...%252Emkv），
    // 需解码两次后匹配（与 store 的 isDirectVideoUrl 逻辑一致）
    (() => {
      try {
        let dec = props.url || '';
        for (let i = 0; i < 2; i++) dec = decodeURIComponent(dec);
        // 仅匹配 filename=/name= 参数；夸克 url= 里的文件名不要匹配，
        // 否则会被误判成 needsWasm=true 从而强制 wasm 优先，而该流的 wasm
        // 解码器在 Demuxer.open 阶段会崩溃（memory access out of bounds）。
        // 走 wasm 兜底（引擎列表末尾）反而能正常播放。
        return /(?:filename|name)=[^&]*\.(mkv|webm|avi|mov|flv|wmv)(?:&|$|%26)/i.test(
          dec,
        );
      } catch {
        return false;
      }
    })();
  el.engine = needsWasm
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

  // 主动查询一次轨道（trackschange 可能在监听绑定前已触发）
  setTimeout(() => {
    try { onTracksChange({ detail: {} }); } catch { /* noop */ }
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
  // movi-player 自动发现内嵌字幕；外部字幕轨直接 append <track> 并加入菜单
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
// 字幕/音轨菜单变化（含 trackschange 重新解析）时同步到 movi 控件栏
watch([audioMenuItems, subtitleMenuItems], syncMoviControlValues, { deep: true });
// 弹幕开关状态同步到 movi 控件栏的开关按钮
watch(danmuEnabled, (on) => {
  const el = mpRef.value;
  if (el && typeof el.updateControl === 'function') {
    el.updateControl('movi-danmu', { active: on });
  }
});
// 应用全屏状态同步到 movi 控件栏的开关按钮
watch(isAppFullscreen, (on) => {
  const el = mpRef.value;
  if (el && typeof el.updateControl === 'function') {
    el.updateControl('movi-appfs', { active: on });
  }
});

// ==================== Mount ====================
onMounted(() => {
  // movi-player 是自定义元素，注册后直接初始化（不派发 ready 事件）
  initPlayer();
  if (props.danmuUrl) loadDanmu(props.danmuUrl);
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
  for (const d of activeDanmuEls) d.remove();
  activeDanmuEls.length = 0;
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
});
</script>

<template>
  <div ref="playerContainer" :class="{ 'app-fullscreen': isAppFullscreen }" class="video-player-wrapper relative w-full h-full bg-black select-none">
    <!-- movi-player 元素（自带完整 UI，不派发 ready 事件，由 onMounted 初始化） -->
    <movi-player ref="mpRef" class="w-full h-full block"></movi-player>

    <!-- 加载遮罩 -->
    <div v-if="isLoading" class="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div class="text-white/70 text-sm flex items-center gap-2">
        <span class="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
        <span>加载中...</span>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="hasError" class="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
      <div class="bg-red-500/80 text-white px-4 py-2 rounded-lg text-sm">播放失败，请重试</div>
    </div>

    <!-- 弹幕层 -->
    <div ref="danmuContainer" class="absolute top-0 left-0 w-full h-3/4 pointer-events-none overflow-hidden z-30">
    </div>

    <!-- 上下集切换（左下角） -->
    <div v-if="props.hasPrev || props.hasNext" class="absolute bottom-14 left-4 z-40 flex items-center gap-2">
      <button v-if="props.hasPrev" class="vp-icon-btn" @click="emit('prev')" title="上一集">
        <el-icon :size="18"><ArrowLeft /></el-icon>
      </button>
      <button v-if="props.hasNext" class="vp-icon-btn" @click="emit('next')" title="下一集">
        <el-icon :size="18"><ArrowRight /></el-icon>
      </button>
    </div>

    <!-- 更多设置面板 -->
    <div v-if="showMorePanel"
      class="absolute bottom-16 right-4 z-[60] w-56 rounded-lg border border-white/10 bg-black/85 p-3 text-sm text-white shadow-xl backdrop-blur">
      <div class="mb-1 text-white/60">画面比例</div>
      <el-select :model-value="aspectRatio" @change="changeAspectRatio" size="small" class="mb-3 w-full">
        <el-option v-for="r in aspectRatios" :key="r.value" :label="r.label" :value="r.value" />
      </el-select>
      <div class="mb-1 text-white/60">快进/快退步长</div>
      <el-select :model-value="String(timeStep)" @change="(v: string) => setTimeStep(Number(v))" size="small" class="mb-3 w-full">
        <el-option v-for="s in [5, 10, 15, 20, 25, 30]" :key="s" :label="s + 's'" :value="String(s)" />
      </el-select>
      <button class="mb-1 w-full rounded px-2 py-1.5 text-left hover:bg-white/10"
        :style="{ color: skipIntro > 0 ? 'var(--color-primary)' : '' }" @click="toggleSkipIntro">
        片头跳过 {{ skipIntro > 0 ? skipIntro + 's' : '关' }}
      </button>
      <button class="w-full rounded px-2 py-1.5 text-left hover:bg-white/10"
        :style="{ color: skipOutro > 0 ? 'var(--color-primary)' : '' }" @click="toggleSkipOutro">
        片尾跳过 {{ skipOutro > 0 ? skipOutro + 's' : '关' }}
      </button>
    </div>

    <!-- 跳过提示 -->
    <div v-if="skipIndicator"
      class="pointer-events-none absolute left-1/2 top-16 z-40 -translate-x-1/2 rounded bg-black/70 px-3 py-1 text-sm text-white">
      {{ skipIndicator }}
    </div>

    <!-- 调试信息（字幕/音轨轨列表） -->
    <div v-if="subtitleTracksInfo.length > 0"
      class="absolute top-12 right-4 z-40 pointer-events-none text-[11px] text-white/80 bg-black/50 rounded px-2 py-1 max-w-[300px]">
      <div>字幕轨: {{ subtitleTracksInfo.join(' | ') }}</div>
      <div v-if="audioTracksInfo.length > 0">音轨: {{ audioTracksInfo.join(' | ') }}</div>
    </div>
  </div>
</template>

<style scoped>
.vp-icon-btn {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: #fff;
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(8px);
  border: none;
  cursor: pointer;
  transition: background 0.2s;
}
.vp-icon-btn:hover {
  background: rgba(255, 255, 255, 0.25);
}
/* 应用全屏：整个播放器窗口铺满视口（区别于 movi 自带的 element 全屏） */
.video-player-wrapper.app-fullscreen {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  z-index: 9999;
}
</style>
