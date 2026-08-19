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
import { Search, ArrowLeft, ArrowRight, ChatDotRound } from '@element-plus/icons-vue';

// 让 Vue 把 <movi-player> 当原生自定义元素渲染，不做组件解析
defineOptions({
  compilerOptions: {
    isCustomElement: (tag: string) => tag === 'movi-player',
  },
});

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

// 字幕/音轨调试信息
const subtitleTracksInfo = ref<string[]>([]);
const audioTracksInfo = ref<string[]>([]);

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

const toggleDanmu = () => {
  danmuEnabled.value = !danmuEnabled.value;
  danmuEngine.setEnabled(danmuEnabled.value);
  localStorage.setItem('tvbox_danmu_enabled', String(danmuEnabled.value));
  if (!danmuEnabled.value) {
    for (const el of activeDanmuEls) el.remove();
    activeDanmuEls.length = 0;
  }
};

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
    if (!isPlaying) {
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
    // detail.subtitle = 内嵌字幕轨（含 MKV/MP4 容器内嵌轨），比 getSubtitleLangs 完整
    const subs: any[] = detail.subtitle ?? el?.getSubtitleLangs?.() ?? [];
    subtitleTracksInfo.value = subs.map((s: any) =>
      `${s.label ?? s.language ?? s.lang ?? s.id ?? ''}${s.subtitleType === 'image' ? ' [图形]' : ''}${s.active ? ' ✓' : ''}`,
    );
    const audios: any[] = detail.audio ?? el?.getAudioLangs?.() ?? [];
    audioTracksInfo.value = audios.map((a: any) =>
      `${a.label ?? a.language ?? a.lang ?? a.id ?? ''}${a.active ? ' ✓' : ''}`,
    );
    if (subs.length > 0) {
      console.log('[MoviPlayer] trackschange 内嵌字幕轨:', subtitleTracksInfo.value);
    }
    if (audios.length > 0) {
      console.log('[MoviPlayer] trackschange 音轨:', audioTracksInfo.value);
    }
  } catch (err) {
    console.warn('[MoviPlayer] trackschange 解析失败:', err);
  }
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
  if (props.poster) el.poster = props.poster;
  if (props.title) el.title = props.title;
  // 引擎优先级：MKV/HEVC/AV1 等原生内核不支持的格式用 wasm 解析；
  // 普通直链(MP4/TS)与 do=stream 代理流直接用 native，避免 wasm 打开失败
  // 再回退导致的错误闪烁与启动变慢。
  const lower = (props.url || '').toLowerCase();
  const needsWasm =
    /\.(mkv|webm|avi|mov|flv|wmv)([?#]|$)/i.test(lower) ||
    /filename[^&]*\.(mkv|webm|avi|mov|flv|wmv)(?:&|$|%26)/i.test(lower);
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
  // movi-player 自动发现内嵌字幕；外部字幕轨直接 append <track>
  const el = mpRef.value;
  if (!el) return;
  for (const s of props.subtitleUrls ?? []) {
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.src = s.url;
    track.label = s.name;
    track.setAttribute('data-format', s.url.endsWith('.srt') ? 'srt' : 'vtt');
    el.appendChild(track);
  }
});
watch(playbackRate, (val) => {
  const el = mpRef.value;
  if (el) el.playbackRate = val;
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
  <div ref="playerContainer" class="video-player-wrapper relative w-full h-full bg-black select-none">
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

    <!-- 顶部工具条 -->
    <div class="absolute top-0 left-0 right-0 z-40 flex items-center justify-between px-4 py-2 pointer-events-none"
      style="background: linear-gradient(to bottom, rgba(0,0,0,0.5), transparent)">
      <div class="flex items-center gap-2 pointer-events-auto">
        <button v-if="props.showSubtitleSearch" class="vp-icon-btn" @click="emit('searchSubtitle')" title="搜索字幕">
          <el-icon :size="18"><Search /></el-icon>
        </button>
      </div>
      <div class="flex items-center gap-2 pointer-events-auto">
        <!-- 弹幕开关 -->
        <button class="vp-icon-btn" @click="toggleDanmu" :title="danmuEnabled ? '关闭弹幕' : '开启弹幕'">
          <el-icon :size="18" :style="{ color: danmuEnabled ? 'var(--color-primary)' : '' }">
            <ChatDotRound />
          </el-icon>
        </button>
      </div>
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
</style>
