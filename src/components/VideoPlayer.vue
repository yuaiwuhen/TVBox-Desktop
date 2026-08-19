<script setup lang="ts">
/**
 * HEVC视频播放器组件 - 使用hevc.js解码器 + hls.js
 * 迁移自 xgplayer 版本的所有 UI 控件和交互功能
 */

import { ref, onMounted, onUnmounted, watch, computed, nextTick } from 'vue';
import Hls from 'hls.js';
import axios from 'axios';
import { HEVCDecoder } from '@hevcjs/core';
import { SubtitleEngine, type SubtitleCue } from '../core/SubtitleEngine';
import { DanmuEngine, type DanmuItem } from '../core/DanmuEngine';
import { checkReplaceProxy, getSpiderApiBaseUrl, getLocalProxy } from '../core/ConfigParser';
import { useAppStore } from '../store/app';
import {
  ChatDotRound,
  Setting,
  Document,
  DArrowLeft,
  DArrowRight,
  Search,
  Lock,
  Unlock,
  Monitor,
  FullScreen,
  Back,
  RefreshLeft,
  VideoPause,
  VideoPlay,
  RefreshRight,
  Right,
  Microphone,
  Mute,
  MoreFilled,
  Rank,
  ArrowLeft,
  CaretLeft,
  CaretRight,
  Headset,
  DocumentCopy
} from '@element-plus/icons-vue';

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
  audioUrls?: string[];
  /** TVBox `sub` field: external subtitle track URLs */
  subtitleUrls?: string[];
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
  (e: 'timeupdate', time: number): void;
  (e: 'ended'): void;
  (e: 'error', error: any): void;
  (e: 'loadedmetadata'): void;
  (e: 'ready'): void;
  (e: 'firstframe'): void;
  (e: 'prev'): void;
  (e: 'next'): void;
  (e: 'progress', time: number, duration: number): void;
  (e: 'searchSubtitle'): void;
  (e: 'netSpeed', speed: string): void;
}>();

// ==================== State ====================
const videoElement = ref<HTMLVideoElement>();
const playerContainer = ref<HTMLDivElement>();
const danmuContainer = ref<HTMLDivElement>();
const isPlaying = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const buffered = ref(0);
const volume = ref(1);
const isMuted = ref(false);
// Pinia store — kept in sync with the Settings page so that playback
// preferences changed in one place (Settings page or in-player menu)
// propagate to the other, and also push to the Android spider server.
const appStore = useAppStore();
const playbackRate = ref(appStore.playSpeed);
const isLoading = ref(true);
const hasError = ref(false);
const errorMessage = ref('');
const unsupportedFormat = ref<{
  format: string;
  directUrl: string;
} | null>(null);
const showControls = ref(true);
const isFullscreen = ref(false);
const isAppFullscreen = ref(false);
let controlsTimer: ReturnType<typeof setTimeout> | null = null;

// HEVC Decoder
let hevcDecoder: HEVCDecoder | null = null;
let hlsPlayer: Hls | null = null;
let decoderInitialized = false;

// Seeking state
const isSeeking = ref(false);
const isBuffering = ref(false);
let seekDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let seekSafetyTimer: ReturnType<typeof setTimeout> | null = null;
let danmuRenderTimer: ReturnType<typeof setTimeout> | null = null;
let subtitleUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let wasPlayingBeforeSeek = false;

// Aspect ratio
const aspectRatio = ref(appStore.scaleType);
const aspectRatios = [
  { label: '默认', value: 'default' },
  { label: '16:9', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '填充', value: 'fill' },
  { label: '原始', value: 'original' },
  { label: '裁剪', value: 'crop' },
];

// Time step
const timeStep = ref(Number(localStorage.getItem('tvbox_time_step') || '10'));

// Skip intro/outro — initialized from the store so Settings page and
// in-player long-press menu stay in sync.
const skipIntro = ref(appStore.skipIntro);
const skipOutro = ref(appStore.skipOutro);
const skipIndicator = ref('');

// Screen lock
const screenLocked = ref(false);

// External player for unsupported formats
const openWithExternalPlayer = async () => {
  if (!unsupportedFormat.value?.directUrl) return;

  const url = unsupportedFormat.value.directUrl;

  // Check if VLC path is configured
  const vlcPath = localStorage.getItem('tvbox_vlc_path');

  if (vlcPath) {
    try {
      // Use Electron's shell.openExternal or spawn VLC
      const { ipcRenderer } = window.require('electron');
      await ipcRenderer.invoke('open-external-player', vlcPath, url);
      console.log('[VideoPlayer-hevc] 已使用VLC打开:', vlcPath, url);
    } catch (e) {
      console.error('[VideoPlayer-hevc] 启动VLC失败:', e);
      // Fallback: copy to clipboard
      copyVideoUrl();
    }
  } else {
    // No VLC configured, copy URL to clipboard
    copyVideoUrl();
  }
};

const copyVideoUrl = async () => {
  if (!unsupportedFormat.value?.directUrl) return;

  try {
    await navigator.clipboard.writeText(unsupportedFormat.value.directUrl);
    console.log('[VideoPlayer-hevc] URL已复制到剪贴板');
    // Show a brief notification
    alert('视频链接已复制到剪贴板，请粘贴到播放器中打开');
  } catch (e) {
    console.error('[VideoPlayer-hevc] 复制失败:', e);
    // Fallback: show URL in a prompt
    prompt('请复制以下链接到播放器中打开:', unsupportedFormat.value.directUrl);
  }
};

// Double-click / long-press
const clickFeedback = ref<{ x: number; y: number; icon: string } | null>(null);
let clickFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
const longPressActive = ref(false);
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let savedPlaybackRate = 1;
let mouseDownTime = 0;
let mouseDownX = 0;
let mouseDownY = 0;

// Net speed tracking
let fragLoadedBytes = 0;
let netSpeedLastTime = Date.now();
let netSpeedInterval: ReturnType<typeof setInterval> | null = null;
const netSpeedDisplay = ref('');
const screenDisplayEnabled = ref(localStorage.getItem('tvbox_screen_display') !== 'false');
const screenDisplayTime = ref('');

// Subtitle
const subtitleEngine = new SubtitleEngine();
const subtitleEnabled = ref(localStorage.getItem('tvbox_subtitle_enabled') === 'true');
const subtitleFontSize = ref(Number(localStorage.getItem('tvbox_subtitle_size') || '24'));
const subtitleColor = ref(localStorage.getItem('tvbox_subtitle_color') || '#ffffff');
const subtitleDelay = ref(Number(localStorage.getItem('tvbox_subtitle_delay') || '0'));
const currentSubtitle = ref<SubtitleCue | null>(null);
/** Available external subtitle tracks (from TVBox `sub` field + search) */
const subtitleTrackList = ref<string[]>([]);
const activeSubtitleTrack = ref(-1); // -1 = off
/** Available in-stream subtitle tracks (HLS subtitleTracks) */
const hlsSubtitleTracks = ref<{ id: number; label: string }[]>([]);
const activeHlsSubtitleTrack = ref(-1); // -1 = off

// Audio tracks
/** Available audio tracks (HLS audioTracks or TVBox `audio` field) */
const audioTrackList = ref<{ id: number; label: string; url?: string }[]>([]);
const activeAudioTrack = ref(0);

// Danmu
const danmuEngine = new DanmuEngine();
const danmuEnabled = ref(localStorage.getItem('tvbox_danmu_enabled') === 'true');
const danmuMaxOnScreen = ref(Number(localStorage.getItem('tvbox_danmu_max') || '30'));
const activeDanmuEls: HTMLElement[] = [];
const showDanmuSettings = ref(false);
const danmuSpeedIndex = ref(Number(localStorage.getItem('tvbox_danmu_speed_idx') || '2'));
const danmuSpeedOptions = [
  { label: '超慢', value: 12 },
  { label: '慢', value: 9 },
  { label: '适中', value: 6 },
  { label: '快', value: 4 },
];
const danmuOpacity = ref(Number(localStorage.getItem('tvbox_danmu_opacity') || '100'));
const danmuLines = ref(Number(localStorage.getItem('tvbox_danmu_lines') || '8'));
const danmuColorMode = ref(localStorage.getItem('tvbox_danmu_color') || 'default');

// Initialize engine settings
danmuEngine.setEnabled(danmuEnabled.value);
danmuEngine.setMaxOnScreen(danmuMaxOnScreen.value);
subtitleEngine.setFontSize(subtitleFontSize.value);
subtitleEngine.setFontColor(subtitleColor.value);
subtitleEngine.setDelay(subtitleDelay.value);

// ==================== Computed ====================
const progressPercent = computed({
  get: () => {
    if (duration.value === 0) return 0;
    return (currentTime.value / duration.value) * 100;
  },
  set: (val: number) => {
    // 由 onProgressInput 处理
  }
});

const bufferedPercent = computed(() => {
  if (duration.value === 0) return 0;
  return (buffered.value / duration.value) * 100;
});

const formattedCurrentTime = computed(() => formatTime(currentTime.value));
const formattedDuration = computed(() => formatTime(duration.value));

// Custom seek bar state
const seekBarRef = ref<HTMLDivElement>();
const isDragging = ref(false);
const hoverPercent = ref(0);
const showHoverTime = ref(false);

const onSeekBarMouseDown = (e: MouseEvent) => {
  if (!seekBarRef.value || !duration.value) return;
  isDragging.value = true;
  wasPlayingBeforeSeek = isPlaying.value;
  if (wasPlayingBeforeSeek) pauseVideo();
  handleSeek(e);
  window.addEventListener('mousemove', handleSeek);
  window.addEventListener('mouseup', onSeekBarMouseUp);
};

const handleSeek = (e: MouseEvent) => {
  if (!seekBarRef.value || !duration.value) return;
  const rect = seekBarRef.value.getBoundingClientRect();
  const percent = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
  hoverPercent.value = percent;
  if (isDragging.value) {
    onProgressInput(percent);
  }
};

const onSeekBarMouseUp = () => {
  if (isDragging.value) {
    isDragging.value = false;
    onProgressChange(hoverPercent.value);
  }
  window.removeEventListener('mousemove', handleSeek);
  window.removeEventListener('mouseup', onSeekBarMouseUp);
};

const onSeekBarMouseMove = (e: MouseEvent) => {
  if (!seekBarRef.value || !duration.value) return;
  const rect = seekBarRef.value.getBoundingClientRect();
  hoverPercent.value = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
  showHoverTime.value = true;
};

const onSeekBarMouseLeave = () => {
  showHoverTime.value = false;
};

const getHoverTime = computed(() => {
  if (!duration.value) return '0:00';
  return formatTime((hoverPercent.value / 100) * duration.value);
});

// Volume slider
const volumeSliderRef = ref<HTMLDivElement>();
const isVolumeDragging = ref(false);

const onVolumeSliderMouseDown = (e: MouseEvent) => {
  if (!volumeSliderRef.value) return;
  isVolumeDragging.value = true;
  handleVolume(e);
  window.addEventListener('mousemove', handleVolume);
  window.addEventListener('mouseup', onVolumeSliderMouseUp);
};

const handleVolume = (e: MouseEvent) => {
  if (!volumeSliderRef.value) return;
  const rect = volumeSliderRef.value.getBoundingClientRect();
  const percent = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
  setVolume(percent / 100);
};

const onVolumeSliderMouseUp = () => {
  isVolumeDragging.value = false;
  window.removeEventListener('mousemove', handleVolume);
  window.removeEventListener('mouseup', onVolumeSliderMouseUp);
};

// ==================== 初始化播放器 ====================
const initPlayer = async () => {
  if (!props.url || !videoElement.value) {
    console.warn('[VideoPlayer-hevc] 缺少必要参数');
    return;
  }

  try {
    console.log('[VideoPlayer-hevc] 🎬 初始化播放器, url=', props.url);
    isLoading.value = true;
    hasError.value = false;

    // 诊断：检查HEVC支持
    const v = document.createElement('video');
    console.log('[VideoPlayer-hevc] 原生HEVC支持检测:');
    ['hev1.1.6.L120.90', 'hvc1.1.6.L120.90', 'hev1.1.6.L150.90'].forEach(c => {
      console.log('  video/mp4; codecs="' + c + '":', v.canPlayType('video/mp4; codecs="' + c + '"') || '不支持');
    });
    console.log('[VideoPlayer-hevc] MSE HEVC支持:');
    ['hev1.1.6.L120.90', 'hvc1.1.6.L120.90'].forEach(c => {
      console.log('  video/mp4; codecs="' + c + '":', MediaSource.isTypeSupported('video/mp4; codecs="' + c + '"') ? 'YES' : 'NO');
    });

    // 初始化HEVC解码器（备选方案）
    if (!decoderInitialized) {
      console.log('[VideoPlayer-hevc] 初始化HEVC解码器...');
      // Use URL constructor to properly resolve WASM path relative to current page
      // This works for both http:// (dev server) and file:// (Electron production)
      const wasmUrl = new URL('wasm/hevc-decode.wasm', window.location.href).href;
      console.log('[VideoPlayer-hevc] Loading WASM from:', wasmUrl);
      hevcDecoder = await HEVCDecoder.create({ wasmBinaryUrl: wasmUrl });
      decoderInitialized = true;
      console.log('[VideoPlayer-hevc] ✅ HEVC解码器初始化成功');
    }

    // Detect URL type: m3u8 HLS stream vs direct video file (mp4/mkv/ etc).
    // For non-m3u8 URLs, use native video.src which works for mp4 and most
    // video formats. For proxy URLs (http://127.0.0.1:port/proxy?do=xxx&url=...),
    // check the do= parameter: do=m3u8/mxn/hls/hxq/proxy with m3u8 content
    // uses hls.js; do=ali or other direct-stream types use native video.src.
    const urlLower = props.url.toLowerCase();
    const isM3u8Url =
      urlLower.includes('.m3u8') ||
      urlLower.includes('do=m3u8') ||
      urlLower.includes('do=mxn') ||
      urlLower.includes('do=hls') ||
      urlLower.includes('do=hxq') ||
      (urlLower.includes('do=proxy') && !urlLower.includes('do=ali'));
    const isDirectVideoUrl =
      urlLower.includes('do=ali') ||
      /\.(mp4|mkv|webm|avi|mov|flv|m4v)(\?|$|&)/i.test(props.url) ||
      // goproxy / proxy URLs carry the real filename in the query, e.g.
      //   http://127.0.0.1:19978/goproxy?url=http%3A%2F%2F127.0.0.1%3A7989%3Furl%3Dhttps%253A...%26filename%253DS01E01.mp4%26...
      // The inner URL is double-encoded, so decode TWICE before matching
      // filename=...mp4 so Quark/UC direct streams play natively (not hls.js).
      (() => {
        try {
          let dec = props.url;
          for (let i = 0; i < 2; i++) dec = decodeURIComponent(dec);
          return /(?:filename|name)=[^&]*\.(mp4|mkv|webm|avi|mov|flv|m4v)(?:&|$|%26)/i.test(
            dec,
          );
        } catch {
          return false;
        }
      })();

    console.log('[VideoPlayer-hevc] URL type detection:', {
      url: props.url.substring(0, 100),
      isM3u8Url,
      isDirectVideoUrl,
    });

    // For direct video URLs (mp4/mkv/etc), use native video.src — hls.js
    // cannot parse non-manifest responses and will emit fatal NETWORK_ERROR.
    if (isDirectVideoUrl) {
      console.log('[VideoPlayer-hevc] 使用原生 video.src 加载直链视频');
      if (videoElement.value) {
        videoElement.value.pause();
        isPlaying.value = false;
      }
      if (hlsPlayer) {
        hlsPlayer.destroy();
        hlsPlayer = null;
      }

      // First, probe the URL to check if the format is supported
      // The server may return 415 UNSUPPORTED_FORMAT for MKV/AVI etc.
      try {
        console.log('[VideoPlayer-hevc] 探测视频格式...');
        const probeRes = await fetch(props.url, { method: 'HEAD' });
        if (probeRes.status === 415) {
          // Server indicated unsupported format, get the error details
          const errorJson = await fetch(props.url).then(r => r.json()).catch(() => null);
          if (errorJson?.error === 'UNSUPPORTED_FORMAT') {
            console.warn('[VideoPlayer-hevc] 不支持的视频格式:', errorJson.format);
            hasError.value = true;
            errorMessage.value = '此视频格式不支持网页播放';
            unsupportedFormat.value = {
              format: errorJson.format || '未知格式',
              directUrl: errorJson.directUrl || props.url,
            };
            isLoading.value = false;
            return;
          }
        }
      } catch (e) {
        console.warn('[VideoPlayer-hevc] 探测请求失败，继续尝试加载:', e);
        // Continue to try loading the video
      }

      videoElement.value.src = props.url;
      videoElement.value.load();
      videoElement.value.currentTime = 0;

      const onLoadedMetadata = () => {
        console.log('[VideoPlayer-hevc] ✅ 直链视频 metadata 加载成功');
        console.log(`[VideoPlayer-hevc] resumeProgress=${props.resumeProgress}s`);
        if (props.resumeProgress > 0) {
          const startPos = Math.max(props.resumeProgress, skipIntro.value);
          console.log(`[VideoPlayer-hevc] 跳转到 ${startPos}s 开始播放`);
          seekTo(startPos);
        } else if (skipIntro.value > 0) {
          seekTo(skipIntro.value);
        }
        if (props.autoplay) {
          isLoading.value = false;
          playVideo();
        }
        videoElement.value?.removeEventListener('loadedmetadata', onLoadedMetadata);
      };
      videoElement.value.addEventListener('loadedmetadata', onLoadedMetadata);

      const onError = (e: Event) => {
        console.error('[VideoPlayer-hevc] ❌ 直链视频加载失败:', (e.target as HTMLVideoElement)?.error);
        hasError.value = true;
        errorMessage.value = '视频加载失败';
        emit('error', (e.target as HTMLVideoElement)?.error);
        videoElement.value?.removeEventListener('error', onError);
      };
      videoElement.value.addEventListener('error', onError);
    } else if (Hls.isSupported()) {
      console.log('[VideoPlayer-hevc] 使用hls.js加载HLS流');

      // 先暂停视频，确保状态正确
      if (videoElement.value) {
        videoElement.value.pause();
        isPlaying.value = false;
      }

      if (hlsPlayer) {
        hlsPlayer.destroy();
        hlsPlayer = null;
      }

      hlsPlayer = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 60 * 1000 * 1000, // 60MB
        maxBufferHole: 0.5,
        highBufferWatchdogPeriod: 2,
        // 处理HEVC编码
        stretchShortVideoTrack: true,
        forceKeyFrameOnDiscontinuity: true,
        // 禁用 HLS.js 自动恢复进度，使用我们自己的 resumeProgress
        startPosition: -1,
      });

      hlsPlayer.loadSource(props.url);
      hlsPlayer.attachMedia(videoElement.value);

      // 清除 Media Session API 缓存的播放位置
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setPositionState(null);
        console.log('[VideoPlayer-hevc] 已清除 Media Session 播放位置缓存');
      }

      // 立即重置播放位置，避免浏览器原生进度恢复干扰
      // 等待 MANIFEST_PARSED 后再根据 resumeProgress 设置正确位置
      videoElement.value.currentTime = 0;
      console.log('[VideoPlayer-hevc] 已重置 currentTime 为 0，等待 resumeProgress 设置');

      hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[VideoPlayer-hevc] ✅ HLS manifest解析成功');
        console.log(`[VideoPlayer-hevc] resumeProgress=${props.resumeProgress}s (从props接收的值)`);
        // Refresh audio/subtitle track lists (multi-track HLS streams).
        refreshHlsTracks();
        // Resume progress (skip intro if needed)
        if (props.resumeProgress > 0) {
          const startPos = Math.max(props.resumeProgress, skipIntro.value);
          console.log(`[VideoPlayer-hevc] 跳转到 ${startPos}s 开始播放`);
          seekTo(startPos);
        } else if (skipIntro.value > 0) {
          seekTo(skipIntro.value);
        }

        // 确保自动播放
        if (props.autoplay) {
          isLoading.value = false;
          playVideo();
        }
      });

      hlsPlayer.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        refreshHlsTracks();
      });
      hlsPlayer.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
        refreshHlsTracks();
      });

      hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
        console.error('[VideoPlayer-hevc] ❌ HLS错误:', data);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('[VideoPlayer-hevc] 网络错误，尝试恢复...');
              // 网络错误时重新加载
              setTimeout(() => hlsPlayer?.startLoad(), 1000);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('[VideoPlayer-hevc] 媒体错误，尝试恢复...');
              // mediaError可能是解码问题，先尝试recoverMediaError
              // 如果多次失败，则尝试重新加载整个流
              const recovered = hlsPlayer?.recoverMediaError();
              if (!recovered) {
                console.log('[VideoPlayer-hevc] recoverMediaError失败，尝试重新加载流...');
                setTimeout(() => {
                  hlsPlayer?.destroy();
                  hlsPlayer = new Hls({
                    enableWorker: true,
                    lowLatencyMode: true,
                    backBufferLength: 90,
                    maxBufferLength: 30,
                    maxMaxBufferLength: 60,
                    maxBufferSize: 60 * 1000 * 1000,
                  });
                  hlsPlayer.loadSource(props.url);
                  hlsPlayer.attachMedia(videoElement.value);
                }, 2000);
              }
              break;
            default:
              console.error('[VideoPlayer-hevc] ❌ 无法恢复的致命错误');
              hasError.value = true;
              errorMessage.value = '视频加载失败';
              emit('error', data);
              break;
          }
        }
      });

      // 监听分片加载事件，统计网速（比 performance API 更可靠）
      hlsPlayer.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        const stats = (data as any)?.frag?.stats;
        const payload = (data as any)?.payload;
        const payloadLen = payload ? (payload.byteLength || payload.length || 0) : 0;
        console.log(
          '[VideoPlayer] FRAG_LOADED:',
          'stats.total=',
          stats?.total,
          'stats.loaded=',
          stats?.loaded,
          'payloadLen=',
          payloadLen,
          'statsKeys=',
          stats ? Object.keys(stats) : 'null',
        );
        if (stats && stats.total) {
          fragLoadedBytes += stats.total;
        } else if (payloadLen) {
          // Fallback: use payload length if stats.total is not available
          fragLoadedBytes += payloadLen;
        }
      });
    } else if (videoElement.value.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari原生HLS支持
      console.log('[VideoPlayer-hevc] 使用原生HLS支持（Safari）');
      videoElement.value.src = props.url;

      // Resume progress (skip intro if needed)
      if (props.resumeProgress > 0) {
        const startPos = Math.max(props.resumeProgress, skipIntro.value);
        seekTo(startPos);
      } else if (skipIntro.value > 0) {
        seekTo(skipIntro.value);
      }

      if (props.autoplay) {
        playVideo();
      }
    } else {
      console.error('[VideoPlayer-hevc] ❌ 不支持HLS播放');
      hasError.value = true;
      errorMessage.value = '浏览器不支持HLS播放';
      emit('error', new Error('HLS not supported'));
    }

    // Fullscreen event listener
    const onFullscreenChange = () => {
      isFullscreen.value = !!document.fullscreenElement;
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);

    // Net speed tracking
    fragLoadedBytes = 0;
    netSpeedLastTime = Date.now();
    if (netSpeedInterval) clearInterval(netSpeedInterval);
    netSpeedInterval = setInterval(() => {
      try {
        const now = new Date();
        screenDisplayTime.value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

        const nowMs = Date.now();
        const elapsed = (nowMs - netSpeedLastTime) / 1000;
        if (elapsed >= 1) {
          const bps = fragLoadedBytes / elapsed;
          const speed = bps > 1048576
            ? (bps / 1048576).toFixed(1) + ' MB/s'
            : bps > 1024
              ? (bps / 1024).toFixed(0) + ' KB/s'
              : bps.toFixed(0) + ' B/s';
          emit('netSpeed', speed);
          netSpeedDisplay.value = speed;
          fragLoadedBytes = 0;
          netSpeedLastTime = nowMs;
        }
      } catch { /* ignore */ }
    }, 1000);

  } catch (error) {
    console.error('[VideoPlayer-hevc] ❌ 初始化失败:', error);
    hasError.value = true;
    errorMessage.value = `播放器初始化失败: ${error}`;
    emit('error', error);
  }
};

// ==================== HEVC解码处理 ====================
const setupHevcDecoding = async () => {
  if (!videoElement.value || !hevcDecoder) return;

  try {
    // 检测原生HEVC支持
    const nativeHevcSupport = videoElement.value.canPlayType('video/mp4; codecs="hev1.1.6.L120.90"') !== '';
    console.log('[VideoPlayer-hevc] 原生HEVC支持:', nativeHevcSupport ? '✅' : '❌');

    if (!nativeHevcSupport) {
      // 如果不支持原生HEVC，使用hevc.js解码
      console.log('[VideoPlayer-hevc] 使用hevc.js软解码');

      // TODO: 实现HEVC流的解码逻辑
      // 1. 拦截HLS的TS片段数据
      // 2. 提取HEVC NAL units
      // 3. 使用hevcDecoder.pushData(chunk, pts)推送数据
      // 4. 使用hevcDecoder.decode()解码
      // 5. 使用hevcDecoder.getNextPicture()获取解码后的图片
      // 6. 渲染到canvas或videoElement
    }
  } catch (error) {
    console.error('[VideoPlayer-hevc] ❌ HEVC解码设置失败:', error);
  }
};

// ==================== 播放控制 ====================
const playVideo = async () => {
  if (!videoElement.value) return;

  try {
    await videoElement.value.play();
    isPlaying.value = true;
    console.log('[VideoPlayer-hevc] ✅ 开始播放');
    hideControlsDelayed();
  } catch (error) {
    console.error('[VideoPlayer-hevc] ❌ 播放失败:', error);
    hasError.value = true;
    errorMessage.value = '播放失败';
    emit('error', error);
  }
};

const pauseVideo = () => {
  if (!videoElement.value) return;

  videoElement.value.pause();
  isPlaying.value = false;
  console.log('[VideoPlayer-hevc] 暂停播放');
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
  if (!videoElement.value) return;

  // 打印调用栈以追踪进度恢复来源
  const stack = new Error().stack?.split('\n').slice(2, 5).join('\n') || '';
  console.log(`[VideoPlayer-hevc] seekTo(${time}s) 被调用，调用栈:\n${stack}`);

  videoElement.value.currentTime = time;
  currentTime.value = time;
};

const setVolume = (vol: number) => {
  if (!videoElement.value) return;

  volume.value = vol;
  videoElement.value.volume = vol;
  isMuted.value = vol === 0;
  console.log('[VideoPlayer-hevc] 设置音量:', vol);
};

const toggleMute = () => {
  if (!videoElement.value) return;

  isMuted.value = !isMuted.value;
  videoElement.value.muted = isMuted.value;
  console.log('[VideoPlayer-hevc]', isMuted.value ? '静音' : '取消静音');
};

const setPlaybackRate = (rate: number) => {
  if (!videoElement.value) return;

  playbackRate.value = rate;
  videoElement.value.playbackRate = rate;
  // Persist + sync to Android via store setter
  appStore.setPlaySpeed(rate);
  console.log('[VideoPlayer-hevc] 设置播放速度:', rate);
};

const toggleFullscreen = async () => {
  if (!playerContainer.value) return;

  try {
    if (!document.fullscreenElement) {
      await playerContainer.value.requestFullscreen();
      isFullscreen.value = true;
      console.log('[VideoPlayer-hevc] 进入全屏');
    } else {
      await document.exitFullscreen();
      isFullscreen.value = false;
      console.log('[VideoPlayer-hevc] 退出全屏');
    }
  } catch (error) {
    console.error('[VideoPlayer-hevc] ❌ 全屏切换失败:', error);
  }
};

// 应用全屏（视频充满当前窗口，不调用 Electron IPC）
const toggleAppFullscreen = () => {
  isAppFullscreen.value = !isAppFullscreen.value;
  // 应用全屏时禁止 body 滚动，退出时恢复
  document.body.style.overflow = isAppFullscreen.value ? 'hidden' : '';
  console.log('[VideoPlayer-hevc] 应用全屏切换:', isAppFullscreen.value);
};

const togglePiP = async () => {
  if (!videoElement.value) return;

  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled) {
      await videoElement.value.requestPictureInPicture();
    }
  } catch (error) {
    console.error('[VideoPlayer-hevc] ❌ 画中画失败:', error);
  }
};

// ==================== 进度控制 ====================
const onProgressInput = (percent: number) => {
  isSeeking.value = true;

  if (!duration.value) return;

  const targetTime = Math.max(0, Math.min(duration.value, (percent / 100) * duration.value));

  if (isNaN(targetTime) || !isFinite(targetTime)) {
    console.warn('[VideoPlayer-hevc] Invalid seek time:', targetTime);
    isSeeking.value = false;
    return;
  }

  if (seekDebounceTimer) {
    clearTimeout(seekDebounceTimer);
  }

  seekDebounceTimer = setTimeout(() => {
    console.log('[VideoPlayer-hevc] seeking to', targetTime, 's (duration:', duration.value, ')');
    seekTo(targetTime);
    seekDebounceTimer = null;
  }, 50);
};

const onProgressChange = (percent: number) => {
  if (!duration.value) return;

  const targetTime = Math.max(0, Math.min(duration.value, (percent / 100) * duration.value));

  if (isNaN(targetTime) || !isFinite(targetTime)) {
    isSeeking.value = false;
    return;
  }

  if (seekDebounceTimer) {
    clearTimeout(seekDebounceTimer);
    seekDebounceTimer = null;
  }

  seekTo(targetTime);
  playVideo();

  if (seekSafetyTimer) {
    clearTimeout(seekSafetyTimer);
  }
  seekSafetyTimer = setTimeout(() => {
    isSeeking.value = false;
    isBuffering.value = false;
    seekSafetyTimer = null;
  }, 15000);
};

const skipForward = () => {
  if (!videoElement.value) return;
  seekTo(Math.min(currentTime.value + timeStep.value, duration.value));
};

const skipBackward = () => {
  if (!videoElement.value) return;
  seekTo(Math.max(currentTime.value - timeStep.value, 0));
};

const changeSpeed = (rate: number) => {
  setPlaybackRate(rate);
};

const setTimeStep = (step: number) => {
  timeStep.value = step;
  localStorage.setItem('tvbox_time_step', String(step));
};

const changeAspectRatio = (mode: string) => {
  aspectRatio.value = mode;
  appStore.setScaleType(mode);
  if (!videoElement.value) return;

  switch (mode) {
    case '16:9':
      videoElement.value.style.objectFit = 'contain';
      videoElement.value.style.aspectRatio = '16/9';
      break;
    case '4:3':
      videoElement.value.style.objectFit = 'contain';
      videoElement.value.style.aspectRatio = '4/3';
      break;
    case 'fill':
      videoElement.value.style.objectFit = 'fill';
      videoElement.value.style.aspectRatio = '';
      break;
    case 'original':
      videoElement.value.style.objectFit = 'none';
      videoElement.value.style.aspectRatio = '';
      break;
    case 'crop':
      videoElement.value.style.objectFit = 'cover';
      videoElement.value.style.aspectRatio = '';
      break;
    default:
      videoElement.value.style.objectFit = 'contain';
      videoElement.value.style.aspectRatio = '';
  }
};

// ==================== Skip intro/outro ====================
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
  if (skipIntro.value > 0) {
    seekTo(skipIntro.value);
  }
};

const skipToOutroEnd = () => {
  if (duration.value > 0) {
    seekTo(duration.value);
    emit('next');
  }
};

// ==================== Screen lock ====================
const lockScreen = () => {
  screenLocked.value = true;
  showControls.value = false;
};

const unlockScreen = () => {
  screenLocked.value = false;
  showControls.value = true;
  hideControlsDelayed();
};

// ==================== Controls visibility ====================
// 是否有打开的悬浮层（Element Plus 下拉菜单会被 teleport 到 body，
// 悬浮层打开时不应自动隐藏控制栏，否则用户在选速度/音轨时面板会消失）
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
    // 仅在播放中、未锁屏、且没有打开的悬浮层/弹幕设置面板时才自动隐藏
    if (isPlaying.value && !screenLocked.value && !hasOpenPopper() && !showDanmuSettings.value) {
      showControls.value = false;
    }
  }, 5000);
}

// ==================== Event handlers ====================
const onTimeUpdate = () => {
  if (!videoElement.value || isSeeking.value) return;

  currentTime.value = videoElement.value.currentTime;
  emit('timeupdate', currentTime.value);
  emit('progress', currentTime.value, duration.value);

  // Subtitle - debounced
  if (subtitleEnabled.value && !subtitleUpdateTimer) {
    subtitleUpdateTimer = setTimeout(() => {
      currentSubtitle.value = subtitleEngine.getCueAtTime(currentTime.value);
      subtitleUpdateTimer = null;
    }, 100);
  }

  // Danmu - debounced
  if (danmuEnabled.value && !danmuRenderTimer) {
    danmuRenderTimer = setTimeout(() => {
      renderDanmu(currentTime.value);
      danmuRenderTimer = null;
    }, 100);
  }

  // Auto-skip outro
  if (skipOutro.value > 0 && duration.value > 0 && props.hasNext &&
    (currentTime.value + skipOutro.value) >= duration.value) {
    emit('next');
    skipOutro.value = 0;
    localStorage.setItem('tvbox_skip_outro', '0');
  }

  // Show skip intro indicator
  if (skipIntro.value > 0 && currentTime.value < skipIntro.value && currentTime.value > 2) {
    skipIndicator.value = '跳过片头';
  } else if (skipOutro.value > 0 && duration.value > 0 && (currentTime.value + skipOutro.value) >= duration.value) {
    skipIndicator.value = '跳过片尾';
  } else {
    skipIndicator.value = '';
  }
};

const onLoadedMetadata = () => {
  if (!videoElement.value) return;

  duration.value = videoElement.value.duration;
  isLoading.value = false;
  console.log('[VideoPlayer-hevc] ✅ 视频信息加载完成, duration=', duration.value);

  // Apply persisted playback settings (speed / aspect ratio) so they take
  // effect on the freshly-loaded media element.
  try {
    videoElement.value.playbackRate = playbackRate.value;
  } catch (e) {
    console.warn('[VideoPlayer-hevc] apply playbackRate failed:', e);
  }
  changeAspectRatio(aspectRatio.value);

  emit('loadedmetadata');

  // 设置HEVC解码
  setupHevcDecoding();
};

const onCanPlay = () => {
  isLoading.value = false;
  console.log('[VideoPlayer-hevc] ✅ 视频可以播放');
  emit('ready');
};

const onPlaying = () => {
  isPlaying.value = true;
  isLoading.value = false;
  isBuffering.value = false;
  console.log('[VideoPlayer-hevc] ✅ 正在播放');
  hideControlsDelayed();
};

const onPause = () => {
  isPlaying.value = false;
  console.log('[VideoPlayer-hevc] 已暂停');
  showControls.value = true;
};

const onEnded = () => {
  isPlaying.value = false;
  console.log('[VideoPlayer-hevc] 播放结束');
  emit('ended');
};

const onError = (event: Event) => {
  const error = (event.target as HTMLVideoElement).error;
  console.error('[VideoPlayer-hevc] ❌ 视频错误:', error);
  hasError.value = true;
  errorMessage.value = '视频播放错误';
  emit('error', error);
};

const onProgress = () => {
  if (!videoElement.value) return;

  const bufferedRanges = videoElement.value.buffered;
  if (bufferedRanges.length > 0) {
    buffered.value = bufferedRanges.end(bufferedRanges.length - 1);
  }
};

const onFirstFrame = () => {
  console.log('[VideoPlayer-hevc] ✅ 第一帧已显示');
  emit('firstframe');
  hideControlsDelayed();
};

const onWaiting = () => {
  isBuffering.value = true;
};

const onSeeking = () => {
  isBuffering.value = true;
  wasPlayingBeforeSeek = isPlaying.value;
  if (wasPlayingBeforeSeek) {
    pauseVideo();
  }
};

const onSeeked = () => {
  isSeeking.value = false;
  isBuffering.value = false;
  if (seekSafetyTimer) {
    clearTimeout(seekSafetyTimer);
    seekSafetyTimer = null;
  }
  if (wasPlayingBeforeSeek) {
    playVideo();
  }
};

// ==================== Double-click / Long-press gestures ====================
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
    // Center the pause/play feedback icon on double-click.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showClickFeedback(rect.width / 2, rect.height / 2, isPlaying.value ? '⏸' : '▶');
  }
};

const showClickFeedback = (x: number, y: number, icon: string) => {
  if (clickFeedbackTimer) clearTimeout(clickFeedbackTimer);
  clickFeedback.value = { x, y, icon };
  clickFeedbackTimer = setTimeout(() => { clickFeedback.value = null }, 800);
};

const onMouseDown = (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  if (target.closest('.el-slider') || target.closest('.ctrl-btn') ||
    target.closest('.vp-icon-btn') || target.closest('.vp-control-btn') ||
    target.closest('.vp-episode-btn') || target.closest('.vp-speed-btn') ||
    target.closest('.vp-play-btn') || target.closest('.vp-seek-bar') ||
    target.closest('.vp-volume-slider') || target.closest('.el-dropdown') ||
    target.closest('.el-dropdown-menu') ||     target.closest('.el-switch') ||
    target.closest('.vp-danmu-panel') ||
    target.closest('.vp-volume-group')) {
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

  if (target.closest('.ctrl-btn') || target.closest('.el-slider') ||
    target.closest('.el-dropdown') || target.closest('.el-dropdown-menu') ||
    target.closest('.el-switch') || target.closest('.vp-seek-bar') ||
    target.closest('.vp-volume-slider') || target.closest('.vp-icon-btn') ||
    target.closest('.vp-control-btn') || target.closest('.vp-episode-btn') ||
    target.closest('.vp-speed-btn') || target.closest('.vp-play-btn') ||
    target.closest('.vp-danmu-panel') ||
    target.closest('.vp-volume-group') ||
    target.closest('.vp-overlay-top') || target.closest('.vp-overlay-bottom')) {
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

const onMouseMove = (e: MouseEvent) => {
  if (screenLocked.value) return;

  const target = e.target as HTMLElement;
  if (target.closest('.ctrl-btn') || target.closest('.el-slider') ||
    target.closest('.el-dropdown') || target.closest('.el-dropdown-menu') ||
    target.closest('.vp-seek-bar') || target.closest('.vp-icon-btn') ||
    target.closest('.vp-control-btn') || target.closest('.vp-episode-btn') ||
    target.closest('.vp-speed-btn') || target.closest('.vp-play-btn') ||
    target.closest('.vp-volume-slider') || target.closest('.vp-danmu-panel') ||
    target.closest('.vp-volume-group') ||
    target.closest('.vp-overlay-top') || target.closest('.vp-overlay-bottom')) {
    return;
  }

  hideControlsDelayed();
};

// ==================== Keyboard Shortcuts ====================
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
    case 'c': toggleSubtitle(); e.preventDefault(); break;
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

// ==================== Remote control ====================
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

// ==================== Subtitle ====================
const loadSubtitle = async (url: string) => {
  try {
    // Rewrite JAR-internal proxy URLs and route external subtitle URLs
    // through the local CORS-free proxy (same as danmu).
    const target = checkReplaceProxy(url);
    const isAndroidProxy =
      target.startsWith(getSpiderApiBaseUrl()) ||
      target.includes('/proxy?') ||
      target.startsWith('proxy://');
    let finalUrl = target;
    if (!isAndroidProxy) {
      let origin = '';
      try { origin = new URL(target).origin; } catch { /* ignore */ }
      finalUrl = `${getLocalProxy()}/proxy?do=danmu&url=${encodeURIComponent(target)}${origin ? `&referer=${encodeURIComponent(origin + '/')}` : ''}`;
    }
    const resp = await axios.get(finalUrl, { responseType: 'text', timeout: 10000 });
    subtitleEngine.load(resp.data);
    subtitleEnabled.value = true;
    localStorage.setItem('tvbox_subtitle_enabled', 'true');
  } catch (e) {
    console.warn('[VideoPlayer-hevc] Failed to load subtitle:', e);
  }
};

const toggleSubtitle = () => {
  subtitleEnabled.value = !subtitleEnabled.value;
  localStorage.setItem('tvbox_subtitle_enabled', String(subtitleEnabled.value));
  if (!subtitleEnabled.value) currentSubtitle.value = null;
};

const adjustSubtitleDelay = (delta: number) => {
  subtitleDelay.value = Math.max(-5, Math.min(5, subtitleDelay.value + delta));
  subtitleEngine.setDelay(subtitleDelay.value);
  localStorage.setItem('tvbox_subtitle_delay', String(subtitleDelay.value));
};

const onSearchSubtitleClick = () => {
  emit('searchSubtitle');
};

/**
 * Populate audio/subtitle track lists from:
 *  1. HLS in-stream tracks (hls.js audioTracks / subtitleTracks)
 *  2. TVBox `audio` / `sub` fields passed via props
 */
const refreshHlsTracks = () => {
  // HLS audio tracks (multi-audio renditions)
  if (hlsPlayer) {
    try {
      const audioTracks = (hlsPlayer as any).audioTracks || [];
      const hlsAudio: { id: number; label: string }[] = audioTracks.map(
        (t: any, i: number) => ({
          id: i,
          label: t.name || t.lang || `音轨 ${i + 1}`,
        }),
      );
      if (hlsAudio.length > 0) {
        audioTrackList.value = hlsAudio;
        if (activeAudioTrack.value >= hlsAudio.length) {
          activeAudioTrack.value = 0;
        }
      }
    } catch (e) {
      console.warn('[VideoPlayer-hevc] 读取HLS音轨失败:', e);
    }
    // HLS subtitle tracks (in-stream)
    try {
      const subTracks = (hlsPlayer as any).subtitleTracks || [];
      hlsSubtitleTracks.value = subTracks.map((t: any, i: number) => ({
        id: i,
        label: t.name || `字幕 ${i + 1}`,
      }));
    } catch (e) {
      console.warn('[VideoPlayer-hevc] 读取HLS字幕轨失败:', e);
    }
  }

  // TVBox `audio` field: alternate audio URLs (only when HLS has no audio
  // track list — jar-provided tracks take precedence via the dropdown).
  if (props.audioUrls && props.audioUrls.length > 0 && audioTrackList.value.length === 0) {
    audioTrackList.value = props.audioUrls.map((u, i) => ({
      id: i,
      label: `音轨 ${i + 1}`,
      url: u,
    }));
  }
  // TVBox `sub` field: external subtitle URLs (merged after any in-stream).
  if (props.subtitleUrls && props.subtitleUrls.length > 0) {
    subtitleTrackList.value = props.subtitleUrls.map((u, i) => u);
    // Don't auto-load; the user picks from the dropdown.
  }
};

/** Switch audio track. id >= 0 indexes audioTrackList (HLS or jar URL). */
const switchAudioTrack = (id: number) => {
  const track = audioTrackList.value[id];
  if (!track) return;
  activeAudioTrack.value = id;
  if (hlsPlayer && track.url === undefined) {
    // HLS in-stream audio track
    try {
      (hlsPlayer as any).audioTrack = id;
      console.log('[VideoPlayer-hevc] 切换音轨(HLS):', track.label);
    } catch (e) {
      console.warn('[VideoPlayer-hevc] 切换HLS音轨失败:', e);
    }
  } else if (track.url) {
    // Jar-provided alternate audio URL: reload video with that URL
    console.log('[VideoPlayer-hevc] 切换音轨(URL):', track.url);
    loadAudioTrack(track.url);
  }
};

/** Load an alternate audio URL — keeps current time and resumes. */
const loadAudioTrack = (url: string) => {
  const resume = currentTime.value;
  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }
  videoElement.value?.pause();
  videoElement.value!.src = url;
  videoElement.value!.load();
  videoElement.value!.addEventListener(
    'loadedmetadata',
    () => {
      videoElement.value!.currentTime = resume;
      videoElement.value!.play().catch(() => {});
    },
    { once: true },
  );
};

/** Switch external subtitle track. id=-1 turns subtitles off. */
const switchSubtitleTrack = async (id: number) => {
  if (id === -1) {
    activeSubtitleTrack.value = -1;
    subtitleEnabled.value = false;
    currentSubtitle.value = null;
    return;
  }
  const url = subtitleTrackList.value[id];
  if (!url) return;
  activeSubtitleTrack.value = id;
  await loadSubtitle(url);
};

/** Switch in-stream subtitle track. id=-1 turns off, >=0 selects HLS track. */
const switchHlsSubtitleTrack = (id: number) => {
  activeHlsSubtitleTrack.value = id;
  if (!hlsPlayer) return;
  try {
    (hlsPlayer as any).subtitleTrack = id;
    console.log('[VideoPlayer-hevc] 切换内嵌字幕轨:', id);
  } catch (e) {
    console.warn('[VideoPlayer-hevc] 切换内嵌字幕轨失败:', e);
  }
};

/** Dropdown command for the subtitle-track menu. */
const onSubtitleTrackCommand = (cmd: number) => {
  if (cmd === -1) {
    // Off: disable both external and in-stream subtitles
    activeSubtitleTrack.value = -1;
    activeHlsSubtitleTrack.value = -1;
    subtitleEnabled.value = false;
    currentSubtitle.value = null;
    if (hlsPlayer) {
      try { (hlsPlayer as any).subtitleTrack = -1; } catch { /* ignore */ }
    }
    return;
  }
  if (cmd >= 200) {
    switchHlsSubtitleTrack(cmd - 200);
    // Turning on an in-stream track keeps external subtitles off
    subtitleEnabled.value = false;
    return;
  }
  if (cmd >= 100) {
    switchSubtitleTrack(cmd - 100);
    activeHlsSubtitleTrack.value = -1;
    return;
  }
};

// ==================== Danmu ====================
const loadDanmu = async (url: string) => {
  try {
    // JAR-internal proxy URLs (proxy:// or 127.0.0.1:9978) must reach the
    // Android API base first (adb forward) — mirroring Android DefaultConfig.
    // All other feeds go through the local /proxy?do=danmu endpoint so the
    // renderer gets a unified CORS-free, UA/Referer-tagged response.
    const target = checkReplaceProxy(url);
    const isAndroidProxy =
      target.startsWith(getSpiderApiBaseUrl()) ||
      target.includes('/proxy?') ||
      target.startsWith('proxy://');
    let finalUrl = target;
    if (!isAndroidProxy) {
      const origin = (() => {
        try {
          return new URL(target).origin;
        } catch {
          return '';
        }
      })();
      finalUrl = `${getLocalProxy()}/proxy?do=danmu&url=${encodeURIComponent(target)}${origin ? `&referer=${encodeURIComponent(origin + '/')}` : ''}`;
    }
    const resp = await axios.get(finalUrl, { responseType: 'text', timeout: 10000 });
    danmuEngine.load(resp.data);
    danmuEnabled.value = true;
    danmuEngine.setEnabled(true);
    localStorage.setItem('tvbox_danmu_enabled', 'true');
  } catch (e) {
    console.warn('[VideoPlayer-hevc] Failed to load danmu:', e);
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

const onDanmuSpeedChange = (idx: number) => {
  danmuSpeedIndex.value = idx;
  localStorage.setItem('tvbox_danmu_speed_idx', String(idx));
};

const onDanmuOpacityChange = (val: number) => {
  localStorage.setItem('tvbox_danmu_opacity', String(val));
};

const adjustDanmuLines = (delta: number) => {
  danmuLines.value = Math.max(1, Math.min(15, danmuLines.value + delta));
  localStorage.setItem('tvbox_danmu_lines', String(danmuLines.value));
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
    const speed = speedOption.value;
    let topPercent: number;
    if (item.type === 1) {
      topPercent = 5 + Math.random() * Math.min(15, danmuLines.value * 4);
    } else if (item.type === 2) {
      topPercent = 65 + Math.random() * 10;
    } else {
      topPercent = Math.random() * Math.min(70, danmuLines.value * 8);
    }
    const opacity = danmuOpacity.value / 100;
    let color = item.color || '#ffffff';
    if (danmuColorMode.value === 'random' && !item.color) {
      const colors = ['#ffffff', '#ff0000', '#00ff00', '#ffff00', '#00ffff', '#ff69b4', '#ffa500'];
      color = colors[Math.floor(Math.random() * colors.length)];
    }
    el.style.cssText = `
      position: absolute;
      ${item.type === 0 ? 'right: -200px;' : 'left: 50%; transform: translateX(-50%);'}
      top: ${topPercent}%;
      color: ${color};
      font-size: ${item.fontSize || 24}px;
      white-space: nowrap;
      pointer-events: none;
      opacity: ${opacity};
      text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
      ${item.type === 0 ? `animation: danmu-scroll ${speed}s linear forwards;` : ''}
    `;
    danmuContainer.value.appendChild(el);
    activeDanmuEls.push(el);
    const removeHandler = () => {
      el.remove();
      const idx = activeDanmuEls.indexOf(el);
      if (idx > -1) activeDanmuEls.splice(idx, 1);
    };
    if (item.type === 0) {
      el.addEventListener('animationend', removeHandler);
    } else {
      setTimeout(removeHandler, 4000);
    }
  }
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
// When playback settings change on the Settings page (or via another
// component), reflect the new value into the local refs that the in-player
// UI binds to. We avoid loops by only writing when the value actually
// differs from the local ref.
watch(
  () => appStore.playSpeed,
  (v) => {
    if (Math.abs(v - playbackRate.value) > 1e-3) {
      playbackRate.value = v;
      if (videoElement.value) videoElement.value.playbackRate = v;
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

// ==================== Lifecycle ====================
onMounted(() => {
  console.log('[VideoPlayer-hevc] 组件挂载');
  initPlayer();
  hideControlsDelayed();

  if (props.subtitleUrl) loadSubtitle(props.subtitleUrl);
  if (props.danmuUrl) loadDanmu(props.danmuUrl);

  // Register TVBox `sub`/`audio` track lists (populate dropdowns).
  if (props.subtitleUrls && props.subtitleUrls.length > 0) {
    subtitleTrackList.value = props.subtitleUrls;
  }
  if (props.audioUrls && props.audioUrls.length > 0) {
    audioTrackList.value = props.audioUrls.map((u, i) => ({
      id: i,
      label: `音轨 ${i + 1}`,
      url: u,
    }));
  }

  window.addEventListener('remote-control', onRemoteControl);
});

onUnmounted(() => {
  console.log('[VideoPlayer-hevc] 组件卸载');

  // 清理HLS播放器
  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }

  // 清理HEVC解码器
  if (hevcDecoder) {
    hevcDecoder.destroy();
    hevcDecoder = null;
  }

  // 清理全屏状态
  if (document.fullscreenElement) {
    document.exitFullscreen();
  }

  // 恢复 body 滚动（防止应用全屏状态下卸载导致 body 锁定）
  document.body.style.overflow = '';

  // 清理所有timer
  if (controlsTimer) clearTimeout(controlsTimer);
  if (netSpeedInterval) clearInterval(netSpeedInterval);
  if (longPressTimer) clearTimeout(longPressTimer);
  if (clickFeedbackTimer) clearTimeout(clickFeedbackTimer);
  if (seekDebounceTimer) clearTimeout(seekDebounceTimer);
  if (seekSafetyTimer) clearTimeout(seekSafetyTimer);
  if (danmuRenderTimer) clearTimeout(danmuRenderTimer);
  if (subtitleUpdateTimer) clearTimeout(subtitleUpdateTimer);

  window.removeEventListener('remote-control', onRemoteControl);

  // 清理弹幕元素
  for (const el of activeDanmuEls) el.remove();
  activeDanmuEls.length = 0;
});

// ==================== Watch ====================
watch(() => props.url, (newUrl) => {
  if (newUrl) {
    nextTick(() => initPlayer());
  }
});

watch(() => props.subtitleUrl, (newUrl) => {
  if (newUrl) loadSubtitle(newUrl);
});

watch(() => props.danmuUrl, (newUrl) => {
  if (newUrl) loadDanmu(newUrl);
});

watch(subtitleFontSize, (val) => {
  subtitleEngine.setFontSize(val);
  localStorage.setItem('tvbox_subtitle_size', String(val));
});

watch(subtitleColor, (val) => {
  subtitleEngine.setFontColor(val);
  localStorage.setItem('tvbox_subtitle_color', val);
});

watch(subtitleDelay, (val) => {
  subtitleEngine.setDelay(val);
  localStorage.setItem('tvbox_subtitle_delay', String(val));
});

watch(danmuMaxOnScreen, (val) => {
  danmuEngine.setMaxOnScreen(val);
  localStorage.setItem('tvbox_danmu_max', String(val));
});

// ==================== Expose ====================
defineExpose({
  loadSubtitleContent(content: string) {
    subtitleEngine.load(content);
    subtitleEnabled.value = true;
    localStorage.setItem('tvbox_subtitle_enabled', 'true');
  },
  getSubtitleEngine() {
    return subtitleEngine;
  }
});
</script>

<template>
  <Teleport to="body" :disabled="!isAppFullscreen">
    <div ref="playerContainer" class="video-player-wrapper relative w-full h-full bg-black select-none"
      :class="{ 'app-fullscreen': isAppFullscreen }" tabindex="0" @keydown="onKeyDown" @mousedown="onMouseDown"
      @mouseup="onMouseUp" @dblclick="onDoubleClick" @mousemove="onMouseMove">
      <!-- 视频元素 -->
      <video ref="videoElement" class="w-full h-full" :poster="poster" :autoplay="autoplay" :muted="isMuted"
        :volume="volume" :playbackRate="playbackRate" @timeupdate="onTimeUpdate" @loadedmetadata="onLoadedMetadata"
        @canplay="onCanPlay" @playing="onPlaying" @pause="onPause" @ended="onEnded" @error="onError"
        @progress="onProgress" @loadeddata="onFirstFrame" @waiting="onWaiting" @seeking="onSeeking" @seeked="onSeeked"
        playsinline webkit-playsinline>
        Your browser does not support the video tag.
      </video>

      <!-- Subtitle overlay -->
      <div v-if="currentSubtitle && subtitleEnabled"
        class="absolute bottom-24 left-1/2 -translate-x-1/2 text-center pointer-events-none z-10"
        :style="{ fontSize: subtitleFontSize + 'px', color: subtitleColor }">
        <span class="px-2 py-1 rounded whitespace-pre-wrap" style="background: rgba(0,0,0,0.7);">{{ currentSubtitle.text
          }}</span>
      </div>

      <!-- Danmu overlay -->
      <div ref="danmuContainer" class="absolute top-0 left-0 w-full h-3/4 pointer-events-none overflow-hidden z-10">
      </div>

      <!-- OSD info overlay (top-left, below top bar) -->
      <div v-if="screenDisplayEnabled && isPlaying" class="vp-osd-info absolute z-20 pointer-events-none">
        <div class="flex items-center gap-2 px-3 py-1.5 rounded-md"
          style="background: rgba(10,11,16,0.6); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);">
          <span class="text-xs whitespace-nowrap"
            style="color: var(--color-text-tertiary); font-variant-numeric: tabular-nums;">H.264 1080p</span>
          <span style="color: var(--color-border);">|</span>
          <span v-if="netSpeedDisplay" class="text-xs whitespace-nowrap"
            style="color: var(--color-text-tertiary); font-variant-numeric: tabular-nums;">{{ netSpeedDisplay }}</span>
        </div>
      </div>

      <!-- Current time + date display (top-right corner) -->
      <div v-if="screenDisplayEnabled" class="vp-time-display absolute z-20 pointer-events-none">
        <span class="text-xs whitespace-nowrap"
          style="color: var(--color-text-tertiary); font-variant-numeric: tabular-nums; opacity: 0.7;">{{
          screenDisplayTime }}</span>
      </div>

      <!-- Skip intro/outro indicator -->
      <div v-if="skipIndicator"
        class="absolute bottom-28 right-8 text-sm px-3 py-1.5 rounded pointer-events-auto cursor-pointer z-20"
        style="background: var(--color-primary); color: #fff"
        @click="skipIndicator === '跳过片头' ? skipToIntroEnd() : skipToOutroEnd()">
        {{ skipIndicator }}
      </div>

      <!-- Double-click feedback -->
      <div v-if="clickFeedback" class="absolute pointer-events-none z-20"
        :style="{ left: clickFeedback.x + 'px', top: clickFeedback.y + 'px' }">
        <div
          class="text-white text-2xl font-bold bg-black/50 w-12 h-12 rounded-full flex items-center justify-center -translate-x-1/2 -translate-y-1/2">
          {{ clickFeedback.icon }}
        </div>
      </div>

      <!-- Center play button (shown when paused) -->
      <div v-if="!isPlaying && !isLoading && !hasError && !screenLocked"
        class="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
        <button class="vp-center-play pointer-events-auto flex items-center justify-center rounded-full"
          @click="togglePlay" aria-label="播放">
          <el-icon :size="32" style="color: #ffffff; margin-left: 3px;">
            <component :is="isPlaying ? VideoPause : VideoPlay" />
          </el-icon>
        </button>
      </div>

      <!-- Locked screen overlay -->
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

      <!-- Buffering indicator -->
      <div v-if="isBuffering && !longPressActive"
        class="vp-buffering-overlay absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
        <div class="flex flex-col items-center gap-3">
          <div class="vp-buffering-spinner"></div>
          <span class="text-xs whitespace-nowrap" style="color: var(--color-text-tertiary);">缓冲中...</span>
        </div>
      </div>

      <!-- Loading state -->
      <div v-if="isLoading" class="absolute inset-0 flex items-center justify-center z-50">
        <div class="flex flex-col items-center gap-3">
          <div class="vp-buffering-spinner"></div>
          <div class="text-sm" style="color: rgba(255,255,255,0.8);">加载中...</div>
        </div>
      </div>

      <!-- Error state -->
      <div v-if="hasError" class="absolute inset-0 flex items-center justify-center z-50"
        style="background: rgba(10,11,16,0.92); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);">
        <div class="text-center px-6 py-8 rounded-xl max-w-sm"
          style="background: var(--color-bg-glass); backdrop-filter: var(--glass-blur-heavy); -webkit-backdrop-filter: var(--glass-blur-heavy); border: var(--glass-border);">
          <div class="flex items-center justify-center w-14 h-14 rounded-full mx-auto mb-5"
            style="background: rgba(248,113,113,0.12);">
            <svg class="w-7 h-7" style="color: var(--state-error);" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <div class="text-base font-medium mb-1" style="color: #ffffff;">{{ errorMessage }}</div>
          <div class="text-sm mb-5" style="color: var(--color-text-tertiary);">视频播放出现错误</div>

          <!-- Unsupported format specific UI -->
          <div v-if="unsupportedFormat" class="space-y-3">
            <div class="text-sm" style="color: rgba(255,255,255,0.8);">
              格式: {{ unsupportedFormat.format }}
            </div>
            <div class="flex gap-3 justify-center">
              <button @click="openWithExternalPlayer"
                class="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
                style="background: var(--color-primary); color: var(--color-primary-foreground);">
                <el-icon :size="16">
                  <Monitor />
                </el-icon>
                外部播放器
              </button>
              <button @click="copyVideoUrl"
                class="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm transition-colors"
                style="background: rgba(255,255,255,0.06); color: var(--color-text-primary); border: 1px solid var(--color-border);">
                复制链接
              </button>
            </div>
            <div class="text-xs mt-2" style="color: var(--color-text-tertiary);">
              提示: 可在设置中配置VLC播放器路径
            </div>
          </div>
        </div>
      </div>

      <!-- Controls overlay -->
      <div v-if="showControls && !screenLocked && !hasError"
        class="absolute inset-0 flex flex-col justify-between pointer-events-none z-30">

        <!-- Top bar (glass gradient) -->
        <div class="vp-overlay-top flex items-center px-4 md:px-6 lg:px-8 pointer-events-auto" @click.stop>
          <!-- Left: back button -->
          <button class="vp-icon-btn shrink-0 flex items-center justify-center" @click="emit('prev')" v-if="hasPrev"
            title="返回">
            <el-icon :size="20" style="color: #ffffff;">
              <ArrowLeft />
            </el-icon>
          </button>
          <div v-else class="w-9 h-9 shrink-0"></div>

          <!-- Center: episode prev/next with title -->
          <div class="flex items-center justify-center flex-1 min-w-0 gap-3">
            <button v-if="hasPrev" class="vp-episode-btn shrink-0 flex items-center justify-center gap-1"
              @click="emit('prev')" title="上一集">
              <el-icon :size="16" style="color: rgba(255,255,255,0.8);">
                <CaretLeft />
              </el-icon>
              <span class="vp-episode-text">上一集</span>
            </button>
            <span class="vp-title truncate text-sm md:text-base font-medium text-center" :title="title">{{ title
              }}</span>
            <button v-if="hasNext" class="vp-episode-btn shrink-0 flex items-center justify-center gap-1"
              @click="emit('next')" title="下一集">
              <span class="vp-episode-text">下一集</span>
              <el-icon :size="16" style="color: rgba(255,255,255,0.8);">
                <CaretRight />
              </el-icon>
            </button>
          </div>

          <!-- Right: action buttons -->
          <div class="flex items-center gap-1 shrink-0">
            <!-- Subtitle toggle -->
            <button class="vp-icon-btn" :class="{ active: subtitleEnabled }" @click="toggleSubtitle" title="字幕">
              <el-icon :size="20">
                <Document />
              </el-icon>
            </button>
            <!-- Subtitle search -->
            <button v-if="showSubtitleSearch" class="vp-icon-btn" @click="onSearchSubtitleClick" title="搜索字幕">
              <el-icon :size="20">
                <Search />
              </el-icon>
            </button>
            <!-- Danmu toggle -->
            <button class="vp-icon-btn" :class="{ active: danmuEnabled }" @click="toggleDanmu" title="弹幕">
              <el-icon :size="20">
                <ChatDotRound />
              </el-icon>
            </button>
            <!-- Lock screen -->
            <button class="vp-icon-btn" @click="lockScreen" title="锁屏">
              <el-icon :size="20">
                <Lock />
              </el-icon>
            </button>
            <!-- Picture-in-Picture -->
            <button class="vp-icon-btn" @click="togglePiP" title="画中画">
              <el-icon :size="20">
                <Monitor />
              </el-icon>
            </button>
            <!-- Fullscreen -->
            <button class="vp-icon-btn" @click="toggleFullscreen" title="全屏">
              <el-icon :size="20">
                <FullScreen />
              </el-icon>
            </button>
          </div>
        </div>

        <!-- Bottom control bar (glass gradient) -->
        <div class="vp-overlay-bottom px-4 md:px-6 lg:px-8 pb-2 pt-5 pointer-events-auto" @click.stop>
          <!-- Seek bar -->
          <div ref="seekBarRef" class="vp-seek-bar group relative w-full mb-3 cursor-pointer"
            @mousedown="onSeekBarMouseDown" @mousemove="onSeekBarMouseMove" @mouseleave="onSeekBarMouseLeave">
            <!-- Track background -->
            <div class="vp-seek-track absolute left-0 right-0">
              <div class="vp-seek-track-bg absolute left-0 right-0 h-full"></div>
              <!-- Buffered range -->
              <div class="vp-seek-buffered absolute left-0 top-0 h-full" :style="{ width: bufferedPercent + '%' }">
              </div>
              <!-- Progress fill -->
              <div class="vp-seek-progress absolute left-0 top-0 h-full" :style="{ width: progressPercent + '%' }">
              </div>
            </div>
            <!-- Thumb -->
            <div class="vp-seek-thumb absolute" :style="{ left: progressPercent + '%' }">
            </div>
            <!-- Hover time tooltip -->
            <div v-if="showHoverTime" class="vp-seek-tooltip absolute" :style="{ left: hoverPercent + '%' }">
              {{ getHoverTime }}
            </div>
          </div>

          <!-- Time display -->
          <div class="flex items-center justify-center mb-2.5 pointer-events-none">
            <span class="text-xs whitespace-nowrap tabular-nums" style="color: rgba(255,255,255,0.8);">
              <span style="color: #ffffff;">{{ formattedCurrentTime }}</span> / {{ formattedDuration
              }}
            </span>
          </div>

          <!-- Controls row -->
          <div class="flex items-center gap-2">
            <!-- LEFT SIDE: playback controls -->
            <div class="flex items-center gap-1 shrink-0">
              <!-- Skip back -->
              <button class="vp-control-btn flex items-center justify-center gap-1" @click="skipBackward"
                :title="`快退${timeStep}秒`">
                <el-icon :size="20" style="color: #ffffff;">
                  <RefreshLeft />
                </el-icon>
                <span class="vp-control-text">{{ timeStep }}s</span>
              </button>
              <!-- Play/Pause -->
              <button class="vp-play-btn flex items-center justify-center" @click="togglePlay"
                :title="isPlaying ? '暂停' : '播放'">
                <el-icon :size="24" style="color: #ffffff;">
                  <component :is="isPlaying ? VideoPause : VideoPlay" />
                </el-icon>
              </button>
              <!-- Skip forward -->
              <button class="vp-control-btn flex items-center justify-center gap-1" @click="skipForward"
                :title="`快进${timeStep}秒`">
                <el-icon :size="20" style="color: #ffffff;">
                  <RefreshRight />
                </el-icon>
                <span class="vp-control-text">{{ timeStep }}s</span>
              </button>
              <!-- Divider -->
              <div class="vp-divider mx-1 hidden md:block"></div>
              <!-- Next Episode -->
              <button v-if="hasNext" class="vp-control-btn flex items-center justify-center gap-1.5"
                @click="emit('next')" title="下一集">
                <el-icon :size="16" style="color: #ffffff;">
                  <Right />
                </el-icon>
                <span class="vp-episode-text">下一集</span>
              </button>
            </div>

            <!-- Center spacer -->
            <div class="flex-1"></div>

            <!-- RIGHT SIDE: utility controls -->
            <div class="flex items-center gap-1 shrink-0">
              <!-- Volume group (icon + expandable slider) -->
              <div class="vp-volume-group hidden sm:flex items-center gap-0.5 relative">
                <button class="vp-icon-btn" @click="toggleMute" :title="isMuted ? '取消静音' : '静音'">
                  <el-icon :size="20" style="color: #ffffff;">
                    <component :is="isMuted ? Mute : Microphone" />
                  </el-icon>
                </button>
                <div class="vp-volume-slider flex items-center">
                  <div ref="volumeSliderRef"
                    class="vp-volume-track relative w-20 h-full flex items-center cursor-pointer"
                    @mousedown="onVolumeSliderMouseDown">
                    <div class="absolute left-0 right-0"
                      style="height: 3px; background: rgba(255,255,255,0.12); border-radius: 2px;">
                      <div class="absolute left-0 top-0 h-full"
                        style="background: var(--color-primary); border-radius: 2px;"
                        :style="{ width: (isMuted ? 0 : volume * 100) + '%' }"></div>
                    </div>
                    <div class="absolute"
                      style="width: 12px; height: 12px; border-radius: 50%; background: #ffffff;"
                      :style="{ left: (isMuted ? 0 : volume * 100) + '%', top: '50%', transform: 'translate(-50%, -50%)' }">
                    </div>
                  </div>
                </div>
              </div>

              <!-- Divider -->
              <div class="vp-divider mx-0.5 hidden sm:block"></div>

              <!-- Playback speed dropdown -->
              <el-dropdown @command="changeSpeed" trigger="click">
                <button class="vp-speed-btn flex items-center justify-center" title="播放速度">
                  {{ playbackRate }}x
                </button>
                <template #dropdown>
                  <el-dropdown-menu class="vp-dropdown-menu">
                    <el-dropdown-item v-for="s in [0.5, 0.75, 1, 1.25, 1.5, 2, 3]" :key="s" :command="s">{{ s
                      }}x</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>

              <!-- Danmu settings -->
              <button class="vp-icon-btn" :class="{ active: showDanmuSettings }"
                @click="showDanmuSettings = !showDanmuSettings" title="弹幕设置">
                <el-icon :size="20">
                  <Setting />
                </el-icon>
              </button>

              <!-- Audio track dropdown -->
              <el-dropdown v-if="audioTrackList.length > 0" @command="switchAudioTrack" trigger="click">
                <button class="vp-icon-btn" :class="{ active: activeAudioTrack > 0 }" title="音轨">
                  <el-icon :size="20">
                    <Headset />
                  </el-icon>
                </button>
                <template #dropdown>
                  <el-dropdown-menu class="vp-dropdown-menu">
                    <el-dropdown-item v-for="(t, i) in audioTrackList" :key="t.id" :command="i">
                      <span :style="{ color: i === activeAudioTrack ? 'var(--color-primary)' : '' }">{{ t.label
                        }}</span>
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>

              <!-- Subtitle track dropdown (external `sub` + in-stream) -->
              <el-dropdown
                v-if="subtitleTrackList.length > 0 || hlsSubtitleTracks.length > 0"
                @command="onSubtitleTrackCommand" trigger="click">
                <button class="vp-icon-btn" :class="{ active: subtitleEnabled || activeHlsSubtitleTrack >= 0 }"
                  title="字幕轨">
                  <el-icon :size="20">
                    <DocumentCopy />
                  </el-icon>
                </button>
                <template #dropdown>
                  <el-dropdown-menu class="vp-dropdown-menu">
                    <el-dropdown-item :command="-1">
                      <span :style="{ color: (activeSubtitleTrack === -1 && activeHlsSubtitleTrack === -1) ? 'var(--color-primary)' : '' }">关闭</span>
                    </el-dropdown-item>
                    <template v-if="subtitleTrackList.length > 0">
                      <el-dropdown-item v-for="(u, i) in subtitleTrackList" :key="'s' + i" :command="100 + i">
                        <span :style="{ color: i === activeSubtitleTrack ? 'var(--color-primary)' : '' }">外挂字幕 {{
                          i + 1 }}</span>
                      </el-dropdown-item>
                    </template>
                    <template v-if="hlsSubtitleTracks.length > 0">
                      <el-dropdown-item v-for="t in hlsSubtitleTracks" :key="'h' + t.id" :command="200 + t.id">
                        <span :style="{ color: t.id === activeHlsSubtitleTrack ? 'var(--color-primary)' : '' }">{{
                          t.label }}</span>
                      </el-dropdown-item>
                    </template>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>

              <!-- More options dropdown -->
              <el-dropdown trigger="click">
                <button class="vp-icon-btn" title="更多">
                  <el-icon :size="20">
                    <MoreFilled />
                  </el-icon>
                </button>
                <template #dropdown>
                  <el-dropdown-menu class="vp-dropdown-menu">
                    <el-dropdown-item @click="toggleSkipIntro">
                      <span :style="{ color: skipIntro > 0 ? 'var(--color-primary)' : '' }">片头跳过 {{ skipIntro > 0 ?
                        skipIntro + 's' : '关' }}</span>
                    </el-dropdown-item>
                    <el-dropdown-item @click="toggleSkipOutro">
                      <span :style="{ color: skipOutro > 0 ? 'var(--color-primary)' : '' }">片尾跳过 {{ skipOutro > 0 ?
                        skipOutro + 's' : '关' }}</span>
                    </el-dropdown-item>
                    <el-dropdown-item divided>
                      <el-dropdown @command="changeAspectRatio" trigger="hover" placement="left-start">
                        <span>画面比例</span>
                        <template #dropdown>
                          <el-dropdown-menu class="vp-dropdown-menu">
                            <el-dropdown-item v-for="r in aspectRatios" :key="r.value" :command="r.value">{{ r.label
                              }}</el-dropdown-item>
                          </el-dropdown-menu>
                        </template>
                      </el-dropdown>
                    </el-dropdown-item>
                    <el-dropdown-item divided>
                      <el-dropdown @command="setTimeStep" trigger="hover" placement="left-start">
                        <span>快进/快退步长</span>
                        <template #dropdown>
                          <el-dropdown-menu class="vp-dropdown-menu">
                            <el-dropdown-item v-for="s in [5, 10, 15, 20, 25, 30]" :key="s" :command="s">{{ s
                              }}s</el-dropdown-item>
                          </el-dropdown-menu>
                        </template>
                      </el-dropdown>
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>

              <!-- App fullscreen button -->
              <button class="vp-icon-btn" @click="toggleAppFullscreen" :title="isAppFullscreen ? '退出应用全屏' : '应用全屏'">
                <el-icon :size="20">
                  <Rank />
                </el-icon>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Danmu settings panel -->
      <div v-if="showDanmuSettings && showControls && !screenLocked"
        class="vp-danmu-panel absolute p-3 rounded-lg z-40 w-56 space-y-2 text-sm">
        <div class="flex justify-between items-center">
          <span style="color: var(--color-text-primary);">弹幕开关</span>
          <el-switch v-model="danmuEnabled" size="small" @change="onDanmuToggle" />
        </div>
        <div>
          <span style="color: var(--color-text-secondary);">速度</span>
          <el-slider v-model="danmuSpeedIndex" :min="0" :max="3" :step="1"
            :format-tooltip="(v: number) => danmuSpeedOptions[v].label" @change="onDanmuSpeedChange" />
        </div>
        <div>
          <span style="color: var(--color-text-secondary);">透明度 {{ danmuOpacity }}%</span>
          <el-slider v-model="danmuOpacity" :min="10" :max="100" :step="10" @change="onDanmuOpacityChange" />
        </div>
        <div class="flex justify-between items-center">
          <span style="color: var(--color-text-secondary);">行数</span>
          <div class="flex items-center gap-1">
            <el-button size="small" @click="adjustDanmuLines(-1)">-</el-button>
            <span class="w-6 text-center" style="color: var(--color-text-primary);">{{ danmuLines }}</span>
            <el-button size="small" @click="adjustDanmuLines(1)">+</el-button>
          </div>
        </div>
        <div class="flex justify-between items-center">
          <span style="color: var(--color-text-secondary);">颜色</span>
          <el-select v-model="danmuColorMode" size="small" style="width:80px">
            <el-option label="默认" value="default" />
            <el-option label="随机" value="random" />
          </el-select>
        </div>
        <el-button size="small" @click="showDanmuSettings = false" class="w-full">关闭</el-button>
      </div>

      <!-- Long press speed indicator -->
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

/* ===== Top Bar ===== */
.vp-overlay-top {
  height: 56px;
  /* Player overlay always uses dark glass regardless of app theme so control
     text stays readable over the black video surface. */
  background: linear-gradient(180deg, rgba(10, 11, 16, 0.82) 0%, transparent 100%);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  transition: opacity var(--duration-slow, 400ms) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
}

/* ===== Icon Button ===== */
.vp-icon-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 150ms ease;
}

.vp-icon-btn:hover {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.06);
}

.vp-icon-btn:active {
  background: rgba(255, 255, 255, 0.1);
}

.vp-icon-btn.active {
  color: var(--color-primary);
}

/* ===== Episode Button ===== */
.vp-episode-btn {
  padding: 6px 12px;
  border-radius: 6px;
  border: none;
  background: transparent;
  cursor: pointer;
  transition: all 150ms ease;
}

.vp-episode-btn:hover {
  background: rgba(255, 255, 255, 0.06);
}

.vp-episode-btn:active {
  background: rgba(255, 255, 255, 0.1);
}

.vp-episode-text {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
  white-space: nowrap;
  display: none;
}

@media (min-width: 640px) {
  .vp-episode-text {
    display: inline;
  }
}

/* ===== Title ===== */
.vp-title {
  max-width: 400px;
  color: #ffffff;
  font-family: var(--font-display, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
}

/* ===== Bottom Control Bar ===== */
.vp-overlay-bottom {
  background: linear-gradient(0deg, rgba(10, 11, 16, 0.82) 0%, transparent 100%);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  transition: opacity var(--duration-slow, 400ms) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
}

/* ===== Seek Bar ===== */
.vp-seek-bar {
  height: 20px;
  display: flex;
  align-items: center;
}

.vp-seek-track {
  height: 3px;
  top: 50%;
  transform: translateY(-50%);
  border-radius: 2px;
}

.vp-seek-track-bg {
  height: 100%;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 2px;
}

.vp-seek-buffered {
  height: 100%;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
}

.vp-seek-progress {
  height: 100%;
  background: var(--color-primary);
  border-radius: 2px;
}

.vp-seek-thumb {
  top: 50%;
  transform: translate(-50%, -50%);
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--color-primary);
  box-shadow: 0 0 10px var(--color-primary-glow), 0 0 20px rgba(232, 145, 58, 0.25);
  opacity: 0;
  transition: opacity 150ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
}

.vp-seek-bar:hover .vp-seek-thumb {
  opacity: 1;
}

.vp-seek-bar:active .vp-seek-thumb {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1.2);
}

.vp-seek-tooltip {
  top: -24px;
  transform: translateX(-50%);
  background: var(--color-bg-glass-heavy);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--color-text-primary);
  font-variant-numeric: tabular-nums;
  border: var(--glass-border);
}

/* ===== Control Buttons ===== */
.vp-control-btn {
  padding: 8px;
  border-radius: 6px;
  border: none;
  background: transparent;
  cursor: pointer;
  transition: all 150ms ease;
}

.vp-control-btn:hover {
  background: rgba(255, 255, 255, 0.06);
}

.vp-control-btn:active {
  background: rgba(255, 255, 255, 0.1);
}

.vp-control-text {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
  white-space: nowrap;
  display: none;
}

@media (min-width: 768px) {
  .vp-control-text {
    display: inline;
  }
}

.vp-play-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: none;
  background: transparent;
  cursor: pointer;
  transition: all 150ms ease;
}

.vp-play-btn:hover {
  background: rgba(255, 255, 255, 0.06);
}

.vp-play-btn:active {
  background: rgba(255, 255, 255, 0.1);
}

/* ===== Divider ===== */
.vp-divider {
  width: 1px;
  height: 16px;
  background: rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

/* ===== Speed Button ===== */
.vp-speed-btn {
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: transparent;
  color: #ffffff;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 150ms ease;
}

.vp-speed-btn:hover {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.06);
}

/* ===== Volume Slider ===== */
.vp-volume-group:hover .vp-volume-slider {
  width: 80px;
}

.vp-volume-slider {
  position: absolute;
  right: calc(100% + 6px);
  top: 50%;
  transform: translateY(-50%);
  width: 0;
  height: 28px;
  overflow: hidden;
  padding: 0;
  border-radius: 8px;
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: var(--glass-border);
  transition: width 200ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)),
              padding 200ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
}

.vp-volume-group.expanded .vp-volume-slider {
  width: 92px;
  padding: 0 10px;
}

/* ===== Center Play Button ===== */
.vp-center-play {
  width: 72px;
  height: 72px;
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur-heavy);
  -webkit-backdrop-filter: var(--glass-blur-heavy);
  border: var(--glass-border);
  transition: transform 250ms ease;
  cursor: pointer;
}

.vp-center-play:hover {
  transform: scale(1.08);
}

.vp-center-play:active {
  transform: scale(0.95);
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

/* ===== OSD Info ===== */
.vp-osd-info {
  top: 64px;
  left: 16px;
}

@media (min-width: 768px) {
  .vp-osd-info {
    left: 24px;
  }
}

@media (min-width: 1024px) {
  .vp-osd-info {
    left: 32px;
  }
}

/* ===== Time Display ===== */
.vp-time-display {
  top: 64px;
  right: 16px;
}

@media (min-width: 768px) {
  .vp-time-display {
    right: 24px;
  }
}

@media (min-width: 1024px) {
  .vp-time-display {
    right: 32px;
  }
}

/* ===== Danmu Panel ===== */
.vp-danmu-panel {
  top: 48px;
  right: 8px;
  background: var(--color-bg-elevated);
  backdrop-filter: var(--glass-blur-heavy);
  -webkit-backdrop-filter: var(--glass-blur-heavy);
  border: var(--glass-border);
  box-shadow: var(--surface-floating-shadow);
}

.vp-dropdown-menu {
  background: var(--color-bg-elevated) !important;
  border: 1px solid var(--color-border) !important;
}

/* ===== Danmu Scroll Animation ===== */
@keyframes danmu-scroll {
  from {
    transform: translateX(0);
  }

  to {
    transform: translateX(calc(-100% - 100vw));
  }
}

/* ===== Reduced Motion ===== */
@media (prefers-reduced-motion: reduce) {

  .vp-center-play,
  .vp-overlay-top,
  .vp-overlay-bottom,
  .vp-seek-thumb,
  .vp-buffering-spinner,
  .vp-volume-slider {
    transition: none !important;
    animation: none !important;
  }
}
</style>
