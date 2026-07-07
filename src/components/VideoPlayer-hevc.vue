<script setup lang="ts">
/**
 * HEVC视频播放器组件 - 使用hevc.js解码器
 *
 * hevc.js优势：
 * - 单线程解码，不需要SharedArrayBuffer
 * - 不需要COOP/COEP headers
 * - 不需要canvas传输机制
 * - 60fps 1080p性能
 * - MIT license，完全免费
 * - 236KB WASM binary
 */

import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import Hls from 'hls.js';
import initialize from '@hevcjs/core';

// ==================== Props ====================
const props = defineProps<{
  url?: string;
  autoplay?: boolean;
  poster?: string;
  title?: string;
  skipStart?: number;
  skipEnd?: number;
  showSkip?: boolean;
  subtitle?: any[];
  danmuList?: any[];
}>();

// ==================== Emits ====================
const emit = defineEmits<{
  (e: 'timeupdate', time: number): void;
  (e: 'ended'): void;
  (e: 'error', error: any): void;
  (e: 'loadedmetadata'): void;
  (e: 'ready'): void;
  (e: 'firstframe'): void;
}>();

// ==================== State ====================
const videoElement = ref<HTMLVideoElement>();
const playerContainer = ref<HTMLDivElement>();
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
const showDanmu = ref(true);
const danmuOpacity = ref(0.7);
const danmuSpeed = ref(1);
const danmuFontSize = ref(24);
const subtitleEnabled = ref(false);
const currentSubtitleIndex = ref(-1);

// ==================== HEVC Decoder ====================
let hevcDecoder: any = null;
let hevcModule: any = null;
let hlsPlayer: Hls | null = null;
let decoderInitialized = false;

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

    // 初始化HEVC解码器
    if (!decoderInitialized) {
      console.log('[VideoPlayer-hevc] 初始化HEVC解码器...');
      hevcModule = await initialize();
      hevcDecoder = new hevcModule.Decoder();
      decoderInitialized = true;
      console.log('[VideoPlayer-hevc] ✅ HEVC解码器初始化成功');
    }

    // 使用hls.js加载HLS流
    if (Hls.isSupported()) {
      console.log('[VideoPlayer-hevc] 使用hls.js加载HLS流');
      hlsPlayer = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
      });

      hlsPlayer.loadSource(props.url);
      hlsPlayer.attachMedia(videoElement.value);

      hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[VideoPlayer-hevc] ✅ HLS manifest解析成功');
        if (props.autoplay) {
          playVideo();
        }
      });

      hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
        console.error('[VideoPlayer-hevc] ❌ HLS错误:', data);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('[VideoPlayer-hevc] 网络错误，尝试恢复...');
              hlsPlayer?.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('[VideoPlayer-hevc] 媒体错误，尝试恢复...');
              hlsPlayer?.recoverMediaError();
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
    } else if (videoElement.value.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari原生HLS支持
      console.log('[VideoPlayer-hevc] 使用原生HLS支持（Safari）');
      videoElement.value.src = props.url;
      if (props.autoplay) {
        playVideo();
      }
    } else {
      console.error('[VideoPlayer-hevc] ❌ 不支持HLS播放');
      hasError.value = true;
      errorMessage.value = '浏览器不支持HLS播放';
      emit('error', new Error('HLS not supported'));
    }

  } catch (error) {
    console.error('[VideoPlayer-hevc] ❌ 初始化失败:', error);
    hasError.value = true;
    errorMessage.value = `播放器初始化失败: ${error}`;
    emit('error', error);
  }
};

// ==================== HEVC解码处理 ====================
const setupHevcDecoding = async () => {
  if (!videoElement.value || !hevcModule) return;

  try {
    // 检测原生HEVC支持
    const nativeHevcSupport = videoElement.value.canPlayType('video/mp4; codecs="hev1.1.6.L120.90"') !== '';
    console.log('[VideoPlayer-hevc] 原生HEVC支持:', nativeHevcSupport ? '✅' : '❌');

    if (!nativeHevcSupport) {
      // 如果不支持原生HEVC，使用hevc.js解码
      console.log('[VideoPlayer-hevc] 使用hevc.js软解码');

      // 这里需要监听videoElement的流数据，然后传递给hevcDecoder解码
      // hevc.js的具体解码逻辑需要根据官方文档实现

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

  videoElement.value.currentTime = time;
  currentTime.value = time;
  console.log('[VideoPlayer-hevc] 跳转到:', time);
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

// ==================== 事件处理 ====================
const onTimeUpdate = () => {
  if (!videoElement.value) return;

  currentTime.value = videoElement.value.currentTime;
  emit('timeupdate', currentTime.value);
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
  console.log('[VideoPlayer-hevc] ✅ 正在播放');
};

const onPause = () => {
  isPlaying.value = false;
  console.log('[VideoPlayer-hevc] 已暂停');
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
};

// ==================== Lifecycle ====================
onMounted(() => {
  console.log('[VideoPlayer-hevc] 组件挂载');
  initPlayer();
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
});

// ==================== Watch ====================
watch(() => props.url, (newUrl) => {
  if (newUrl) {
    initPlayer();
  }
});

// ==================== Computed ====================
const progressPercent = computed(() => {
  if (duration.value === 0) return 0;
  return (currentTime.value / duration.value) * 100;
});

const bufferedPercent = computed(() => {
  if (duration.value === 0) return 0;
  return (buffered.value / duration.value) * 100;
});

const formattedCurrentTime = computed(() => {
  return formatTime(currentTime.value);
});

const formattedDuration = computed(() => {
  return formatTime(duration.value);
});

// ==================== Helpers ====================
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  } else {
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
</script>

<template>
  <div ref="playerContainer" class="relative w-full h-full bg-black">
    <!-- 视频元素 -->
    <video ref="videoElement" class="w-full h-full" :poster="poster" :autoplay="autoplay" :muted="isMuted"
      :volume="volume" :playbackRate="playbackRate" @timeupdate="onTimeUpdate" @loadedmetadata="onLoadedMetadata"
      @canplay="onCanPlay" @playing="onPlaying" @pause="onPause" @ended="onEnded" @error="onError"
      @progress="onProgress" @loadeddata="onFirstFrame" playsinline webkit-playsinline>
      <!-- 原生HLS支持（Safari） -->
      Your browser does not support the video tag.
    </video>

    <!-- 加载状态 -->
    <div v-if="isLoading" class="absolute inset-0 flex items-center justify-center">
      <div class="text-white text-lg">加载中...</div>
    </div>

    <!-- 错误状态 -->
    <div v-if="hasError" class="absolute inset-0 flex items-center justify-center bg-black/80">
      <div class="text-white text-center">
        <div class="text-2xl mb-2">❌</div>
        <div>{{ errorMessage }}</div>
      </div>
    </div>

    <!-- 控制栏 -->
    <div v-if="showControls && !hasError" class="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/80">
      <!-- 播放控制 -->
      <div class="flex items-center gap-2">
        <button @click="togglePlay" class="p-2 text-white hover:text-gray-300">
          <span v-if="isPlaying">⏸️</span>
          <span v-else>▶️</span>
        </button>

        <!-- 时间显示 -->
        <div class="text-white text-sm">
          {{ formattedCurrentTime }} / {{ formattedDuration }}
        </div>

        <!-- 进度条 -->
        <div class="flex-1 h-1 bg-gray-600 rounded cursor-pointer relative">
          <div class="absolute top-0 left-0 h-full bg-blue-500 rounded" :style="{ width: progressPercent + '%' }"></div>
          <div v-if="bufferedPercent > 0" class="absolute top-0 left-0 h-full bg-gray-400/50 rounded"
            :style="{ width: bufferedPercent + '%' }"></div>
        </div>

        <!-- 音量控制 -->
        <button @click="toggleMute" class="p-2 text-white hover:text-gray-300">
          <span v-if="isMuted">🔇</span>
          <span v-else>🔊</span>
        </button>

        <input v-model="volume" type="range" min="0" max="1" step="0.1" class="w-16 h-1" @input="setVolume(volume)" />

        <!-- 全屏按钮 -->
        <button @click="toggleFullscreen" class="p-2 text-white hover:text-gray-300">
          <span v-if="isFullscreen">⬇️</span>
          <span v-else>⬆️</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 播放器样式 */
</style>