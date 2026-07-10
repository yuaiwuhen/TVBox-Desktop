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
  Rank
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
const playbackRate = ref(1);
const isLoading = ref(true);
const hasError = ref(false);
const errorMessage = ref('');
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
const aspectRatio = ref('default');
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

// Skip intro/outro
const skipIntro = ref(Number(localStorage.getItem('tvbox_skip_intro') || '0'));
const skipOutro = ref(Number(localStorage.getItem('tvbox_skip_outro') || '0'));
const skipIndicator = ref('');

// Screen lock
const screenLocked = ref(false);

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
      hevcDecoder = await HEVCDecoder.create({ wasmBinaryUrl: '/wasm/hevc-decode.wasm' });
      decoderInitialized = true;
      console.log('[VideoPlayer-hevc] ✅ HEVC解码器初始化成功');
    }

    // Detect URL type: m3u8 HLS stream vs direct video file (mp4/mkv/ etc).
    // Quark/UC/Baidu pan CDNs return direct mp4 URLs (not m3u8), which hls.js
    // cannot handle — hls.js expects a manifest playlist. For non-m3u8 URLs,
    // use native video.src which works for mp4 and most video formats.
    // For proxy URLs (http://127.0.0.1:port/proxy?do=xxx&url=...), check the
    // do= parameter: do=m3u8/mxn/proxy with m3u8 content uses hls.js;
    // do=quarkDirect/ucDirect/baiduDirect are direct mp4 streams.
    const urlLower = props.url.toLowerCase();
    const isM3u8Url =
      urlLower.includes('.m3u8') ||
      urlLower.includes('do=m3u8') ||
      urlLower.includes('do=mxn') ||
      urlLower.includes('do=hls') ||
      (urlLower.includes('do=proxy') && !urlLower.includes('do=quarkdirect') && !urlLower.includes('do=ucdirect') && !urlLower.includes('do=baidudirect'));
    const isDirectVideoUrl =
      urlLower.includes('do=quarkdirect') ||
      urlLower.includes('do=ucdirect') ||
      urlLower.includes('do=baidudirect') ||
      /\.(mp4|mkv|webm|avi|mov|flv|m4v)(\?|$)/i.test(props.url);

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
  localStorage.setItem('tvbox_skip_intro', String(skipIntro.value));
};

const toggleSkipOutro = () => {
  if (skipOutro.value > 0) {
    skipOutro.value = 0;
  } else {
    const remaining = duration.value - currentTime.value;
    skipOutro.value = Math.floor(remaining);
  }
  localStorage.setItem('tvbox_skip_outro', String(skipOutro.value));
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
function hideControlsDelayed() {
  if (controlsTimer) clearTimeout(controlsTimer);
  showControls.value = true;
  controlsTimer = setTimeout(() => {
    if (isPlaying.value && !screenLocked.value) showControls.value = false;
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
    showClickFeedback(e.offsetX, e.offsetY, isPlaying.value ? '⏸' : '▶');
  }
};

const showClickFeedback = (x: number, y: number, icon: string) => {
  if (clickFeedbackTimer) clearTimeout(clickFeedbackTimer);
  clickFeedback.value = { x, y, icon };
  clickFeedbackTimer = setTimeout(() => { clickFeedback.value = null }, 800);
};

const onMouseDown = (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  if (target.closest('.el-slider') || target.closest('.ctrl-btn')) {
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
    target.closest('.el-switch')) {
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
    target.closest('.el-dropdown') || target.closest('.el-dropdown-menu')) {
    return;
  }

  hideControlsDelayed();
};

const onMouseLeave = () => {
  // 鼠标移出视频区域后自动隐藏控件
  if (isPlaying.value && !screenLocked.value) {
    if (controlsTimer) clearTimeout(controlsTimer);
    showControls.value = false;
  }
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
    const resp = await axios.get(url, { responseType: 'text', timeout: 10000 });
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

// ==================== Danmu ====================
const loadDanmu = async (url: string) => {
  try {
    const resp = await axios.get(url, { responseType: 'text', timeout: 10000 });
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

// ==================== Lifecycle ====================
onMounted(() => {
  console.log('[VideoPlayer-hevc] 组件挂载');
  initPlayer();
  hideControlsDelayed();

  if (props.subtitleUrl) loadSubtitle(props.subtitleUrl);
  if (props.danmuUrl) loadDanmu(props.danmuUrl);

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
      @mouseup="onMouseUp" @dblclick="onDoubleClick" @mousemove="onMouseMove" @mouseleave="onMouseLeave">
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
        class="absolute bottom-16 left-1/2 -translate-x-1/2 text-center pointer-events-none z-10"
        :style="{ fontSize: subtitleFontSize + 'px', color: subtitleColor }">
        <span class="bg-black/70 px-2 py-1 rounded whitespace-pre-wrap">{{ currentSubtitle.text }}</span>
      </div>

      <!-- Danmu overlay -->
      <div ref="danmuContainer" class="absolute top-0 left-0 w-full h-3/4 pointer-events-none overflow-hidden z-10">
      </div>

      <!-- Screen display info overlay -->
      <div v-if="screenDisplayEnabled && isPlaying"
        class="absolute top-2 left-2 text-xs text-white/70 bg-black/40 px-2 py-1 rounded pointer-events-none z-10 space-y-0.5">
        <div>{{ screenDisplayTime }}</div>
        <div v-if="netSpeedDisplay">{{ netSpeedDisplay }}</div>
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

      <!-- Lock icon -->
      <div v-if="screenLocked" class="absolute top-4 left-1/2 -translate-x-1/2 z-40">
        <button class="w-10 h-10 rounded-full flex items-center justify-center animate-pulse"
          style="background: var(--color-primary)" @click="unlockScreen">
          <el-icon :size="18" style="color: #fff">
            <Unlock />
          </el-icon>
        </button>
      </div>

      <!-- 加载状态 -->
      <div v-if="isLoading" class="absolute inset-0 flex items-center justify-center z-50">
        <div class="flex flex-col items-center gap-2">
          <div class="w-12 h-12 rounded-full border-4 border-white/30 border-t-white animate-spin"></div>
          <div class="text-white text-sm bg-black/60 px-2 py-1 rounded">加载中...</div>
        </div>
      </div>

      <!-- 错误状态 -->
      <div v-if="hasError" class="absolute inset-0 flex items-center justify-center bg-black/80 z-50">
        <div class="text-white text-center">
          <div class="text-2xl mb-2">❌</div>
          <div>{{ errorMessage }}</div>
        </div>
      </div>

      <!-- Controls overlay (hidden when screen locked) -->
      <div v-if="showControls && !screenLocked && !hasError"
        class="absolute inset-0 flex flex-col justify-between pointer-events-none z-30">
        <!-- Top bar -->
        <div class="flex items-center justify-between px-4 py-2 pointer-events-auto" @click.stop
          style="background: linear-gradient(to bottom, rgba(0,0,0,0.7), transparent)">
          <span class="text-white text-sm truncate max-w-[60%]">{{ title }}</span>
          <div class="flex gap-1">
            <button class="ctrl-btn" :class="{ active: danmuEnabled }" @click="toggleDanmu" title="弹幕">
              <el-icon :size="16">
                <ChatDotRound />
              </el-icon>
            </button>
            <button class="ctrl-btn" @click="showDanmuSettings = !showDanmuSettings" title="弹幕设置">
              <el-icon :size="16">
                <Setting />
              </el-icon>
            </button>
            <button class="ctrl-btn" :class="{ active: subtitleEnabled }" @click="toggleSubtitle" title="字幕">
              <el-icon :size="16">
                <Document />
              </el-icon>
            </button>
            <button v-if="subtitleEnabled" class="ctrl-btn" @click="adjustSubtitleDelay(-0.5)" title="字幕延迟-0.5s">
              <el-icon :size="14">
                <DArrowLeft />
              </el-icon>
            </button>
            <button v-if="subtitleEnabled" class="ctrl-btn" @click="adjustSubtitleDelay(0.5)" title="字幕延迟+0.5s">
              <el-icon :size="14">
                <DArrowRight />
              </el-icon>
            </button>
            <button v-if="showSubtitleSearch" class="ctrl-btn" @click="onSearchSubtitleClick" title="搜索字幕">
              <el-icon :size="16">
                <Search />
              </el-icon>
            </button>
            <button class="ctrl-btn" @click="lockScreen" title="锁屏">
              <el-icon :size="16">
                <Lock />
              </el-icon>
            </button>
            <button class="ctrl-btn" @click="togglePiP" title="画中画">
              <el-icon :size="16">
                <Monitor />
              </el-icon>
            </button>
          </div>
        </div>

        <!-- Bottom bar -->
        <div class="px-4 py-3 pointer-events-auto" @click.stop
          style="background: linear-gradient(to top, rgba(0,0,0,0.8), transparent)">
          <!-- Progress bar -->
          <div class="flex items-center gap-3 mb-2">
            <span class="text-white/80 text-xs w-14 text-right">{{ formattedCurrentTime }}</span>
            <el-slider v-model="progressPercent" :show-tooltip="false" class="flex-1" @input="onProgressInput"
              @change="onProgressChange" />
            <span class="text-white/80 text-xs w-14">{{ formattedDuration }}</span>
          </div>

          <!-- Control buttons -->
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-1">
              <button v-if="hasPrev" class="ctrl-btn" @click="emit('prev')" title="上一集">
                <el-icon :size="18">
                  <Back />
                </el-icon>
              </button>
              <button class="ctrl-btn" @click="skipBackward" :title="`快退${timeStep}秒`">
                <el-icon :size="16">
                  <RefreshLeft />
                </el-icon>
              </button>
              <button class="ctrl-btn play-btn" @click="togglePlay" :title="isPlaying ? '暂停' : '播放'">
                <el-icon :size="22">
                  <component :is="isPlaying ? VideoPause : VideoPlay" />
                </el-icon>
              </button>
              <button class="ctrl-btn" @click="skipForward" :title="`快进${timeStep}秒`">
                <el-icon :size="16">
                  <RefreshRight />
                </el-icon>
              </button>
              <button v-if="hasNext" class="ctrl-btn" @click="emit('next')" title="下一集">
                <el-icon :size="18">
                  <Right />
                </el-icon>
              </button>
            </div>

            <div class="flex items-center gap-1">
              <button class="ctrl-btn" @click="toggleMute" :title="isMuted ? '取消静音' : '静音'">
                <el-icon :size="16">
                  <component :is="isMuted ? Mute : Microphone" />
                </el-icon>
              </button>

              <!-- Playback rate dropdown -->
              <el-dropdown @command="changeSpeed" trigger="click">
                <button class="ctrl-btn text-xs">{{ playbackRate }}x</button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-for="s in [0.5, 0.75, 1, 1.25, 1.5, 2, 3]" :key="s" :command="s">{{ s
                      }}x</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>

              <!-- Time step dropdown -->
              <el-dropdown @command="setTimeStep" trigger="click">
                <button class="ctrl-btn text-xs">{{ timeStep }}s</button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-for="s in [5, 10, 15, 20, 25, 30]" :key="s" :command="s">{{ s
                      }}s</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>

              <!-- More options dropdown -->
              <el-dropdown trigger="click">
                <button class="ctrl-btn" title="更多">
                  <el-icon :size="16">
                    <MoreFilled />
                  </el-icon>
                </button>
                <template #dropdown>
                  <el-dropdown-menu>
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
                          <el-dropdown-menu>
                            <el-dropdown-item v-for="r in aspectRatios" :key="r.value" :command="r.value">{{ r.label
                              }}</el-dropdown-item>
                          </el-dropdown-menu>
                        </template>
                      </el-dropdown>
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>

              <!-- 应用全屏按钮 -->
              <button class="ctrl-btn" @click="toggleAppFullscreen" :title="isAppFullscreen ? '退出应用全屏' : '应用全屏'">
                <el-icon :size="16">
                  <Rank />
                </el-icon>
              </button>

              <!-- 全屏按钮 -->
              <button class="ctrl-btn" @click="toggleFullscreen" :title="isFullscreen ? '退出全屏' : '全屏'">
                <el-icon :size="16">
                  <FullScreen />
                </el-icon>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Danmu settings panel -->
      <div v-if="showDanmuSettings" class="absolute top-12 right-2 p-3 rounded-lg z-20 w-56 space-y-2 text-sm"
        style="background: rgba(0,0,0,0.85); backdrop-filter: blur(8px); color: #fff">
        <div class="flex justify-between items-center">
          <span>弹幕开关</span>
          <el-switch v-model="danmuEnabled" size="small" @change="onDanmuToggle" />
        </div>
        <div>
          <span>速度</span>
          <el-slider v-model="danmuSpeedIndex" :min="0" :max="3" :step="1"
            :format-tooltip="(v: number) => danmuSpeedOptions[v].label" @change="onDanmuSpeedChange" />
        </div>
        <div>
          <span>透明度 {{ danmuOpacity }}%</span>
          <el-slider v-model="danmuOpacity" :min="10" :max="100" :step="10" @change="onDanmuOpacityChange" />
        </div>
        <div class="flex justify-between items-center">
          <span>行数</span>
          <div class="flex items-center gap-1">
            <el-button size="small" @click="adjustDanmuLines(-1)">-</el-button>
            <span class="w-6 text-center">{{ danmuLines }}</span>
            <el-button size="small" @click="adjustDanmuLines(1)">+</el-button>
          </div>
        </div>
        <div class="flex justify-between items-center">
          <span>颜色</span>
          <el-select v-model="danmuColorMode" size="small" style="width:80px">
            <el-option label="默认" value="default" />
            <el-option label="随机" value="random" />
          </el-select>
        </div>
        <el-button size="small" @click="showDanmuSettings = false" class="w-full">关闭</el-button>
      </div>

      <!-- Long press speed indicator -->
      <div v-if="longPressActive"
        class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white text-4xl font-bold pointer-events-none z-20">
        {{ playbackRate }}x <el-icon :size="32">
          <DArrowRight />
        </el-icon>
      </div>

      <!-- Buffering / seeking indicator -->
      <div v-if="isBuffering && !longPressActive"
        class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-20 flex flex-col items-center gap-2">
        <div class="w-12 h-12 rounded-full border-4 border-white/30 border-t-white animate-spin"></div>
        <span class="text-white text-sm bg-black/60 px-2 py-1 rounded">缓冲中…</span>
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

.ctrl-btn {
  background: transparent;
  border: none;
  color: white;
  padding: 6px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ctrl-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.ctrl-btn.active {
  background: var(--color-primary);
}

.play-btn {
  padding: 8px;
}

@keyframes danmu-scroll {
  from {
    transform: translateX(0);
  }

  to {
    transform: translateX(calc(-100% - 100vw));
  }
}
</style>