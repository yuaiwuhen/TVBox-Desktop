<template>
  <div class="video-player-wrapper relative w-full h-full bg-black select-none" tabindex="0" @keydown="onKeyDown"
       @mousedown="onMouseDown" @mouseup="onMouseUp" @dblclick="onDoubleClick" @mousemove="onMouseMove">
    <div ref="playerContainer" class="w-full h-full"></div>

    <!-- Subtitle overlay -->
    <div v-if="currentSubtitle" class="absolute bottom-16 left-1/2 -translate-x-1/2 text-center pointer-events-none z-10"
         :style="{ fontSize: subtitleFontSize + 'px', color: subtitleColor }">
      <span class="bg-black/70 px-2 py-1 rounded whitespace-pre-wrap">{{ currentSubtitle.text }}</span>
    </div>

    <!-- Danmu overlay -->
    <div ref="danmuContainer" class="absolute top-0 left-0 w-full h-3/4 pointer-events-none overflow-hidden z-10"></div>

    <!-- Screen display info overlay -->
    <div v-if="screenDisplayEnabled && isPlaying" class="absolute top-2 left-2 text-xs text-white/70 bg-black/40 px-2 py-1 rounded pointer-events-none z-10 space-y-0.5">
      <div>{{ screenDisplayTime }}</div>
      <div v-if="netSpeedDisplay">{{ netSpeedDisplay }}</div>
    </div>

    <!-- Skip intro/outro indicator -->
    <div v-if="skipIndicator" class="absolute bottom-28 right-8 text-sm px-3 py-1.5 rounded pointer-events-auto cursor-pointer z-20"
         style="background: var(--color-primary); color: #fff"
         @click="skipIndicator === '跳过片头' ? skipToIntroEnd() : skipToOutroEnd()">
      {{ skipIndicator }}
    </div>

    <!-- Double-click feedback -->
    <div v-if="clickFeedback" class="absolute pointer-events-none z-20"
         :style="{ left: clickFeedback.x + 'px', top: clickFeedback.y + 'px' }">
      <div class="text-white text-2xl font-bold bg-black/50 w-12 h-12 rounded-full flex items-center justify-center -translate-x-1/2 -translate-y-1/2">
        {{ clickFeedback.icon }}
      </div>
    </div>

    <!-- Lock icon -->
    <div v-if="screenLocked" class="absolute top-4 left-1/2 -translate-x-1/2 z-30">
      <button class="w-10 h-10 rounded-full flex items-center justify-center animate-pulse" style="background: var(--color-primary)" @click="unlockScreen">
        <el-icon :size="18" style="color: #fff"><Unlock /></el-icon>
      </button>
    </div>

    <!-- Controls overlay (hidden when screen locked) -->
    <div v-if="showControls && !screenLocked" class="absolute inset-0 flex flex-col justify-end pointer-events-none">
      <!-- Top bar -->
      <div class="flex items-center justify-between px-4 py-2 pointer-events-auto" style="background: linear-gradient(to bottom, rgba(0,0,0,0.7), transparent)">
        <span class="text-white text-sm truncate max-w-[60%]">{{ title }}</span>
        <div class="flex gap-1">
          <button class="ctrl-btn" :class="{ active: danmuEnabled }" @click="toggleDanmu" title="弹幕">
            <el-icon :size="16"><ChatDotRound /></el-icon>
          </button>
          <button class="ctrl-btn" @click="showDanmuSettings = !showDanmuSettings" title="弹幕设置">
            <el-icon :size="16"><Setting /></el-icon>
          </button>
          <button class="ctrl-btn" :class="{ active: subtitleEnabled }" @click="toggleSubtitle" title="字幕">
            <el-icon :size="16"><Document /></el-icon>
          </button>
          <button v-if="subtitleEnabled" class="ctrl-btn" @click="adjustSubtitleDelay(-0.5)" title="字幕延迟-0.5s">
            <el-icon :size="14"><DArrowLeft /></el-icon>
          </button>
          <button v-if="subtitleEnabled" class="ctrl-btn" @click="adjustSubtitleDelay(0.5)" title="字幕延迟+0.5s">
            <el-icon :size="14"><DArrowRight /></el-icon>
          </button>
          <button v-if="showSubtitleSearch" class="ctrl-btn" @click="emit('searchSubtitle')" title="搜索字幕">
            <el-icon :size="16"><Search /></el-icon>
          </button>
          <button class="ctrl-btn" @click="lockScreen" title="锁屏">
            <el-icon :size="16"><Lock /></el-icon>
          </button>
          <button class="ctrl-btn" @click="togglePiP" title="画中画">
            <el-icon :size="16"><Monitor /></el-icon>
          </button>
          <button class="ctrl-btn" @click="toggleFullscreen" :title="isFullscreen ? '退出全屏' : '全屏'">
            <el-icon :size="16"><FullScreen /></el-icon>
          </button>
        </div>
      </div>
      <!-- Bottom bar -->
      <div class="px-4 py-3 pointer-events-auto" style="background: linear-gradient(to top, rgba(0,0,0,0.8), transparent)">
        <div class="flex items-center gap-3 mb-2">
          <span class="text-white/80 text-xs w-14 text-right">{{ formatTime(currentTime) }}</span>
          <el-slider v-model="progressPercent" :show-tooltip="false" class="flex-1" @change="seekTo" />
          <span class="text-white/80 text-xs w-14">{{ formatTime(duration) }}</span>
        </div>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1">
            <button v-if="hasPrev" class="ctrl-btn" @click="$emit('prev')" title="上一集">
              <el-icon :size="18"><Back /></el-icon>
            </button>
            <button class="ctrl-btn" @click="skipBackward" :title="`快退${timeStep}秒`">
              <el-icon :size="16"><RefreshLeft /></el-icon>
            </button>
            <button class="ctrl-btn play-btn" @click="togglePlay" :title="isPlaying ? '暂停' : '播放'">
              <el-icon :size="22"><component :is="isPlaying ? 'VideoPause' : 'VideoPlay'" /></el-icon>
            </button>
            <button class="ctrl-btn" @click="skipForward" :title="`快进${timeStep}秒`">
              <el-icon :size="16"><RefreshRight /></el-icon>
            </button>
            <button v-if="hasNext" class="ctrl-btn" @click="$emit('next')" title="下一集">
              <el-icon :size="18"><Right /></el-icon>
            </button>
          </div>
          <div class="flex items-center gap-1">
            <button class="ctrl-btn" @click="toggleMute" :title="isMuted ? '取消静音' : '静音'">
              <el-icon :size="16"><component :is="isMuted ? 'Mute' : 'Microphone'" /></el-icon>
            </button>
            <el-dropdown @command="changeSpeed" trigger="click">
              <button class="ctrl-btn text-xs">{{ playbackRate }}x</button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-for="s in [0.5, 0.75, 1, 1.25, 1.5, 2, 3]" :key="s" :command="s">{{ s }}x</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-dropdown @command="setTimeStep" trigger="click">
              <button class="ctrl-btn text-xs">{{ timeStep }}s</button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-for="s in [5,10,15,20,25,30]" :key="s" :command="s">{{ s }}s</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <!-- More options dropdown -->
            <el-dropdown trigger="click">
              <button class="ctrl-btn" title="更多">
                <el-icon :size="16"><MoreFilled /></el-icon>
              </button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="toggleSkipIntro">
                    <span :style="{ color: skipIntro > 0 ? 'var(--color-primary)' : '' }">片头跳过 {{ skipIntro > 0 ? skipIntro + 's' : '关' }}</span>
                  </el-dropdown-item>
                  <el-dropdown-item @click="toggleSkipOutro">
                    <span :style="{ color: skipOutro > 0 ? 'var(--color-primary)' : '' }">片尾跳过 {{ skipOutro > 0 ? skipOutro + 's' : '关' }}</span>
                  </el-dropdown-item>
                  <el-dropdown-item divided>
                    <el-dropdown @command="changeAspectRatio" trigger="hover" placement="left-start">
                      <span>画面比例</span>
                      <template #dropdown>
                        <el-dropdown-menu>
                          <el-dropdown-item v-for="r in aspectRatios" :key="r.value" :command="r.value">{{ r.label }}</el-dropdown-item>
                        </el-dropdown-menu>
                      </template>
                    </el-dropdown>
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
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
        <el-slider v-model="danmuSpeedIndex" :min="0" :max="3" :step="1" :format-tooltip="(v: number) => danmuSpeedOptions[v].label" @change="onDanmuSpeedChange" />
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
    <div v-if="longPressActive" class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white text-4xl font-bold pointer-events-none z-20">
      {{ playbackRate }}x <el-icon :size="32"><DArrowRight /></el-icon>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import Player from 'xgplayer'
import 'xgplayer/dist/index.min.css'
import HlsPlugin from 'xgplayer-hls.js'
import FlvPlugin from 'xgplayer-flv.js'
import axios from 'axios'
import { SubtitleEngine, type SubtitleCue } from '../core/SubtitleEngine'
import { DanmuEngine, type DanmuItem } from '../core/DanmuEngine'

const props = withDefaults(defineProps<{
  url: string
  headers?: Record<string, string>
  title?: string
  autoplay?: boolean
  subtitleUrl?: string
  danmuUrl?: string
  hasPrev?: boolean
  hasNext?: boolean
  resumeProgress?: number
  showSubtitleSearch?: boolean
}>(), {
  autoplay: true,
  title: '',
  hasPrev: false,
  hasNext: false,
  resumeProgress: 0,
  showSubtitleSearch: false
})

const emit = defineEmits<{
  (e: 'ended'): void
  (e: 'timeupdate', time: number): void
  (e: 'error', err: any): void
  (e: 'prev'): void
  (e: 'next'): void
  (e: 'progress', time: number, duration: number): void
  (e: 'searchSubtitle'): void
  (e: 'netSpeed', speed: string): void
}>()

const playerContainer = ref<HTMLElement | null>(null)
const danmuContainer = ref<HTMLElement | null>(null)
let playerInstance: Player | null = null

const isPlaying = ref(false)
const isFullscreen = ref(false)
const isMuted = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const progressPercent = ref(0)
const playbackRate = ref(1)
const showControls = ref(true)
let controlsTimer: ReturnType<typeof setTimeout> | null = null

const aspectRatio = ref('default')
const aspectRatios = [
  { label: '默认', value: 'default' },
  { label: '16:9', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '填充', value: 'fill' },
  { label: '原始', value: 'original' },
  { label: '裁剪', value: 'crop' },
]

// Time step (5-30s configurable)
const timeStep = ref(Number(localStorage.getItem('tvbox_time_step') || '10'))

// Skip intro/outro
const skipIntro = ref(Number(localStorage.getItem('tvbox_skip_intro') || '0'))
const skipOutro = ref(Number(localStorage.getItem('tvbox_skip_outro') || '0'))
const skipIndicator = ref('')

// Screen lock
const screenLocked = ref(false)

// Double-click / long-press
const clickFeedback = ref<{ x: number; y: number; icon: string } | null>(null)
let clickFeedbackTimer: ReturnType<typeof setTimeout> | null = null
const longPressActive = ref(false)
let longPressTimer: ReturnType<typeof setTimeout> | null = null
let savedPlaybackRate = 1
let mouseDownTime = 0
let mouseDownX = 0
let mouseDownY = 0

// Net speed tracking
let netSpeedBytes = 0
let netSpeedLastTime = Date.now()
let netSpeedInterval: ReturnType<typeof setInterval> | null = null
const netSpeedDisplay = ref('')
const screenDisplayEnabled = ref(localStorage.getItem('tvbox_screen_display') !== 'false')
const screenDisplayTime = ref('')

// Subtitle
const subtitleEngine = new SubtitleEngine()
const subtitleEnabled = ref(localStorage.getItem('tvbox_subtitle_enabled') === 'true')
const subtitleFontSize = ref(Number(localStorage.getItem('tvbox_subtitle_size') || '24'))
const subtitleColor = ref(localStorage.getItem('tvbox_subtitle_color') || '#ffffff')
const subtitleDelay = ref(Number(localStorage.getItem('tvbox_subtitle_delay') || '0'))
const currentSubtitle = ref<SubtitleCue | null>(null)

// Danmu
const danmuEngine = new DanmuEngine()
const danmuEnabled = ref(localStorage.getItem('tvbox_danmu_enabled') === 'true')
const danmuMaxOnScreen = ref(Number(localStorage.getItem('tvbox_danmu_max') || '30'))
const activeDanmuEls: HTMLElement[] = []
const showDanmuSettings = ref(false)
const danmuSpeedIndex = ref(Number(localStorage.getItem('tvbox_danmu_speed_idx') || '2'))
const danmuSpeedOptions = [
  { label: '超慢', value: 12 },
  { label: '慢', value: 9 },
  { label: '适中', value: 6 },
  { label: '快', value: 4 },
]
const danmuOpacity = ref(Number(localStorage.getItem('tvbox_danmu_opacity') || '100'))
const danmuLines = ref(Number(localStorage.getItem('tvbox_danmu_lines') || '8'))
const danmuColorMode = ref(localStorage.getItem('tvbox_danmu_color') || 'default')

// Initialize engine settings from stored preferences
danmuEngine.setEnabled(danmuEnabled.value)
danmuEngine.setMaxOnScreen(danmuMaxOnScreen.value)
subtitleEngine.setFontSize(subtitleFontSize.value)
subtitleEngine.setFontColor(subtitleColor.value)
subtitleEngine.setDelay(subtitleDelay.value)

function hideControlsDelayed() {
  if (controlsTimer) clearTimeout(controlsTimer)
  showControls.value = true
  controlsTimer = setTimeout(() => {
    if (isPlaying.value && !screenLocked.value) showControls.value = false
  }, 5000)
}

function initPlayer(url: string) {
  if (playerInstance) {
    playerInstance.destroy()
    playerInstance = null
  }
  if (!playerContainer.value || !url) return

  const isM3u8 = url.includes('.m3u8') || url.includes('format=m3u8')
  const isFlv = url.includes('.flv') || url.includes('format=flv')
  const isDash = url.includes('.mpd') || url.includes('format=dash')

  const config: any = {
    el: playerContainer.value,
    url,
    width: '100%',
    height: '100%',
    autoplay: props.autoplay,
    videoInit: true,
    volume: 1,
    playbackRate: [0.5, 0.75, 1, 1.25, 1.5, 2, 3],
    pip: true,
    screenShot: true,
    keyShortcut: false,
    cssFullscreen: true,
  }

  if (isM3u8) {
    config.plugins = [HlsPlugin]
    config.hlsJsPlugin = { hlsOpts: { debug: false } }
  } else if (isFlv) {
    config.plugins = [FlvPlugin]
  } else if (isDash) {
    console.warn('[VideoPlayer] DASH format detected. Native playback may not support all DASH features.')
  }

  if (props.headers && Object.keys(props.headers).length > 0) {
    config.hlsJsPlugin = config.hlsJsPlugin || {}
    config.hlsJsPlugin.xhrSetup = (xhr: XMLHttpRequest) => {
      for (const [k, v] of Object.entries(props.headers!)) {
        xhr.setRequestHeader(k, v)
      }
    }
  }

  playerInstance = new Player(config)

  playerInstance.on('playing', () => { isPlaying.value = true; hideControlsDelayed() })
  playerInstance.on('pause', () => { isPlaying.value = false; showControls.value = true })
  playerInstance.on('ended', () => { isPlaying.value = false; emit('ended') })
  playerInstance.on('timeupdate', () => {
    if (playerInstance) {
      currentTime.value = playerInstance.currentTime || 0
      duration.value = playerInstance.duration || 0
      if (duration.value > 0) {
        progressPercent.value = (currentTime.value / duration.value) * 100
      }
      emit('timeupdate', currentTime.value)
      emit('progress', currentTime.value, duration.value)

      // Subtitle
      if (subtitleEnabled.value) {
        currentSubtitle.value = subtitleEngine.getCueAtTime(currentTime.value)
      }
      // Danmu
      if (danmuEnabled.value) {
        renderDanmu(currentTime.value)
      }

      // Auto-skip outro: if within skipOutro seconds of end, auto next
      if (skipOutro.value > 0 && duration.value > 0 && props.hasNext &&
          (currentTime.value + skipOutro.value) >= duration.value) {
        emit('next')
        skipOutro.value = 0
        localStorage.setItem('tvbox_skip_outro', '0')
      }

      // Show skip intro indicator
      if (skipIntro.value > 0 && currentTime.value < skipIntro.value && currentTime.value > 2) {
        skipIndicator.value = '跳过片头'
      } else if (skipOutro.value > 0 && duration.value > 0 && (currentTime.value + skipOutro.value) >= duration.value) {
        skipIndicator.value = '跳过片尾'
      } else {
        skipIndicator.value = ''
      }
    }
  })
  playerInstance.on('error', (err: any) => { emit('error', err) })
  playerInstance.on('fullscreenchange', () => {
    isFullscreen.value = !!playerInstance?.fullscreen
  })

  // Net speed tracking via performance API
  netSpeedBytes = 0
  netSpeedLastTime = Date.now()
  if (netSpeedInterval) clearInterval(netSpeedInterval)
  netSpeedInterval = setInterval(() => {
    try {
      const video = playerContainer.value?.querySelector('video') as HTMLVideoElement | null
      if (video) {
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
        let bytesInPeriod = 0
        const now = Date.now()
        for (const entry of entries) {
          if (entry.transferSize > 0 && (now - entry.responseEnd) < 2000) {
            bytesInPeriod += entry.transferSize
          }
        }
        netSpeedBytes += bytesInPeriod
        const elapsed = (now - netSpeedLastTime) / 1000
        if (elapsed >= 1) {
          const bps = netSpeedBytes / elapsed
          const speed = bps > 1048576
            ? (bps / 1048576).toFixed(1) + ' MB/s'
            : bps > 1024
              ? (bps / 1024).toFixed(0) + ' KB/s'
              : bps.toFixed(0) + ' B/s'
          emit('netSpeed', speed)
          netSpeedDisplay.value = speed
          netSpeedBytes = 0
          netSpeedLastTime = now
        }
      }
      const now = new Date()
      screenDisplayTime.value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
    } catch { /* ignore */ }
  }, 1000)

  // Resume progress (skip intro if needed)
  if (props.resumeProgress > 0) {
    playerInstance.on('loadeddata', () => {
      if (playerInstance && props.resumeProgress > 0) {
        const startPos = Math.max(props.resumeProgress, skipIntro.value)
        playerInstance.currentTime = startPos
      }
    })
  } else if (skipIntro.value > 0) {
    playerInstance.on('loadeddata', () => {
      if (playerInstance && skipIntro.value > 0) {
        playerInstance.currentTime = skipIntro.value
      }
    })
  }
}

// --- Controls ---
function togglePlay() {
  if (!playerInstance) return
  if (isPlaying.value) playerInstance.pause()
  else playerInstance.play()
}

function toggleMute() {
  if (!playerInstance) return
  isMuted.value = !isMuted.value
  playerInstance.volume = isMuted.value ? 0 : 1
}

function toggleFullscreen() {
  if (!playerInstance) return
  if (isFullscreen.value) playerInstance.exitFullscreen()
  else playerInstance.getFullscreen()
}

function togglePiP() {
  if (!playerInstance) return
  try {
    const pipPlugin = (playerInstance as any).pip
    if (pipPlugin) {
      pipPlugin.switchPIP()
    } else if (document.pictureInPictureEnabled) {
      const video = playerContainer.value?.querySelector('video')
      if (video && video.requestPictureInPicture) {
        video.requestPictureInPicture()
      }
    }
  } catch (e) {
    console.warn('[VideoPlayer] PiP failed:', e)
  }
}

function seekTo(percent: number) {
  if (!playerInstance || !duration.value) return
  playerInstance.currentTime = (percent / 100) * duration.value
}

function skipForward() {
  if (!playerInstance) return
  playerInstance.currentTime = Math.min((playerInstance.currentTime || 0) + timeStep.value, duration.value)
}

function skipBackward() {
  if (!playerInstance) return
  playerInstance.currentTime = Math.max((playerInstance.currentTime || 0) - timeStep.value, 0)
}

function changeSpeed(rate: number) {
  if (!playerInstance) return
  playbackRate.value = rate
  playerInstance.playbackRate = rate
}

function setTimeStep(step: number) {
  timeStep.value = step
  localStorage.setItem('tvbox_time_step', String(step))
}

function changeAspectRatio(mode: string) {
  aspectRatio.value = mode
  const video = playerContainer.value?.querySelector('video') as HTMLVideoElement | null
  if (!video) return
  switch (mode) {
    case '16:9': video.style.objectFit = 'contain'; video.style.aspectRatio = '16/9'; break
    case '4:3': video.style.objectFit = 'contain'; video.style.aspectRatio = '4/3'; break
    case 'fill': video.style.objectFit = 'fill'; video.style.aspectRatio = ''; break
    case 'original': video.style.objectFit = 'none'; video.style.aspectRatio = ''; break
    case 'crop': video.style.objectFit = 'cover'; video.style.aspectRatio = ''; break
    default: video.style.objectFit = 'contain'; video.style.aspectRatio = ''
  }
}

// --- Skip intro/outro ---
function toggleSkipIntro() {
  if (skipIntro.value > 0) {
    skipIntro.value = 0
  } else {
    // Set to current position (skip to here next time)
    skipIntro.value = Math.floor(currentTime.value)
  }
  localStorage.setItem('tvbox_skip_intro', String(skipIntro.value))
}

function toggleSkipOutro() {
  if (skipOutro.value > 0) {
    skipOutro.value = 0
  } else {
    // Set to remaining time as outro
    const remaining = duration.value - currentTime.value
    skipOutro.value = Math.floor(remaining)
  }
  localStorage.setItem('tvbox_skip_outro', String(skipOutro.value))
}

function skipToIntroEnd() {
  if (playerInstance && skipIntro.value > 0) {
    playerInstance.currentTime = skipIntro.value
  }
}

function skipToOutroEnd() {
  if (playerInstance && duration.value > 0) {
    playerInstance.currentTime = duration.value
    emit('next')
  }
}

// --- Screen lock ---
function lockScreen() {
  screenLocked.value = true
  showControls.value = false
}

function unlockScreen() {
  screenLocked.value = false
  showControls.value = true
  hideControlsDelayed()
}

// --- Double-click / Long-press gestures ---
function onDoubleClick(e: MouseEvent) {
  if (screenLocked.value) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const x = e.clientX - rect.left
  const third = rect.width / 3

  if (x < third) {
    // Left third: backward
    skipBackward()
    showClickFeedback(e.offsetX, e.offsetY, '⏪')
  } else if (x > third * 2) {
    // Right third: forward
    skipForward()
    showClickFeedback(e.offsetX, e.offsetY, '⏩')
  } else {
    // Center: play/pause
    togglePlay()
    showClickFeedback(e.offsetX, e.offsetY, isPlaying.value ? '⏸' : '▶')
  }
}

function showClickFeedback(x: number, y: number, icon: string) {
  if (clickFeedbackTimer) clearTimeout(clickFeedbackTimer)
  clickFeedback.value = { x, y, icon }
  clickFeedbackTimer = setTimeout(() => { clickFeedback.value = null }, 800)
}

function onMouseDown(e: MouseEvent) {
  mouseDownTime = Date.now()
  mouseDownX = e.clientX
  mouseDownY = e.clientY

  // Start long-press timer (500ms)
  longPressTimer = setTimeout(() => {
    if (screenLocked.value) return
    longPressActive.value = true
    savedPlaybackRate = playbackRate.value
    if (savedPlaybackRate < 3) {
      changeSpeed(3)
    }
  }, 500)
}

function onMouseUp(e: MouseEvent) {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
  if (longPressActive.value) {
    // Restore previous speed
    longPressActive.value = false
    changeSpeed(savedPlaybackRate)
    return
  }

  // Single click: toggle controls
  const moved = Math.abs(e.clientX - mouseDownX) + Math.abs(e.clientY - mouseDownY)
  if (moved < 10 && Date.now() - mouseDownTime < 300) {
    if (screenLocked.value) {
      // Show lock icon briefly
      showControls.value = true
      setTimeout(() => { showControls.value = false }, 2000)
    } else {
      showControls.value = !showControls.value
      if (showControls.value) hideControlsDelayed()
    }
  }
}

function onMouseMove() {
  if (screenLocked.value) return
  hideControlsDelayed()
}

// --- Keyboard Shortcuts ---
function onKeyDown(e: KeyboardEvent) {
  if (screenLocked.value && e.key !== 'Escape' && e.key !== 'q') return
  switch (e.key) {
    case ' ':
    case 'k': togglePlay(); e.preventDefault(); break
    case 'ArrowRight': skipForward(); e.preventDefault(); break
    case 'ArrowLeft': skipBackward(); e.preventDefault(); break
    case 'ArrowUp':
      if (playerInstance) playerInstance.volume = Math.min(1, (playerInstance.volume || 1) + 0.1)
      e.preventDefault(); break
    case 'ArrowDown':
      if (playerInstance) playerInstance.volume = Math.max(0, (playerInstance.volume || 1) - 0.1)
      e.preventDefault(); break
    case 'f': toggleFullscreen(); e.preventDefault(); break
    case 'm': toggleMute(); e.preventDefault(); break
    case 'd': toggleDanmu(); e.preventDefault(); break
    case 'c': toggleSubtitle(); e.preventDefault(); break
    case 'Escape':
      if (screenLocked.value) unlockScreen()
      else if (isFullscreen.value) toggleFullscreen()
      break
    case 'q': if (screenLocked.value) unlockScreen(); break
    case 'n': emit('next'); e.preventDefault(); break
    case 'p': emit('prev'); e.preventDefault(); break
    case 'l': lockScreen(); e.preventDefault(); break
  }
}

// --- Subtitle ---
async function loadSubtitle(url: string) {
  try {
    const resp = await axios.get(url, { responseType: 'text', timeout: 10000 })
    subtitleEngine.load(resp.data)
    subtitleEnabled.value = true
    localStorage.setItem('tvbox_subtitle_enabled', 'true')
  } catch (e) {
    console.warn('[VideoPlayer] Failed to load subtitle:', e)
  }
}

function toggleSubtitle() {
  subtitleEnabled.value = !subtitleEnabled.value
  localStorage.setItem('tvbox_subtitle_enabled', String(subtitleEnabled.value))
  if (!subtitleEnabled.value) currentSubtitle.value = null
}

function adjustSubtitleDelay(delta: number) {
  subtitleDelay.value = Math.max(-5, Math.min(5, subtitleDelay.value + delta))
  subtitleEngine.setDelay(subtitleDelay.value)
  localStorage.setItem('tvbox_subtitle_delay', String(subtitleDelay.value))
}

// --- Danmu ---
async function loadDanmu(url: string) {
  try {
    const resp = await axios.get(url, { responseType: 'text', timeout: 10000 })
    danmuEngine.load(resp.data)
    danmuEnabled.value = true
    danmuEngine.setEnabled(true)
    localStorage.setItem('tvbox_danmu_enabled', 'true')
  } catch (e) {
    console.warn('[VideoPlayer] Failed to load danmu:', e)
  }
}

function toggleDanmu() {
  danmuEnabled.value = !danmuEnabled.value
  danmuEngine.setEnabled(danmuEnabled.value)
  localStorage.setItem('tvbox_danmu_enabled', String(danmuEnabled.value))
  if (!danmuEnabled.value) {
    for (const el of activeDanmuEls) el.remove()
    activeDanmuEls.length = 0
  }
}

function onDanmuToggle(val: boolean) {
  danmuEngine.setEnabled(val)
  localStorage.setItem('tvbox_danmu_enabled', String(val))
  if (!val) {
    for (const el of activeDanmuEls) el.remove()
    activeDanmuEls.length = 0
  }
}

function onDanmuSpeedChange(idx: number) {
  danmuSpeedIndex.value = idx
  localStorage.setItem('tvbox_danmu_speed_idx', String(idx))
}

function onDanmuOpacityChange(val: number) {
  localStorage.setItem('tvbox_danmu_opacity', String(val))
}

function adjustDanmuLines(delta: number) {
  danmuLines.value = Math.max(1, Math.min(15, danmuLines.value + delta))
  localStorage.setItem('tvbox_danmu_lines', String(danmuLines.value))
}

function renderDanmu(time: number) {
  if (!danmuContainer.value) return
  const maxCount = Math.min(danmuMaxOnScreen.value, danmuLines.value * 3)
  const items = danmuEngine.getItemsAtTime(time, 8)
  for (const item of items) {
    if (activeDanmuEls.length >= maxCount) break
    const el = document.createElement('div')
    el.textContent = item.text
    const speedOption = danmuSpeedOptions[danmuSpeedIndex.value] || danmuSpeedOptions[2]
    const speed = speedOption.value
    let topPercent: number
    if (item.type === 1) {
      topPercent = 5 + Math.random() * Math.min(15, danmuLines.value * 4)
    } else if (item.type === 2) {
      topPercent = 65 + Math.random() * 10
    } else {
      topPercent = Math.random() * Math.min(70, danmuLines.value * 8)
    }
    const opacity = danmuOpacity.value / 100
    let color = item.color || '#ffffff'
    if (danmuColorMode.value === 'random' && !item.color) {
      const colors = ['#ffffff', '#ff0000', '#00ff00', '#ffff00', '#00ffff', '#ff69b4', '#ffa500']
      color = colors[Math.floor(Math.random() * colors.length)]
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
    `
    danmuContainer.value.appendChild(el)
    activeDanmuEls.push(el)
    const removeHandler = () => {
      el.remove()
      const idx = activeDanmuEls.indexOf(el)
      if (idx > -1) activeDanmuEls.splice(idx, 1)
    }
    if (item.type === 0) {
      el.addEventListener('animationend', removeHandler)
    } else {
      setTimeout(removeHandler, 4000)
    }
  }
}

// --- Remote control event listener ---
function onRemoteControl(e: Event) {
  const detail = (e as CustomEvent).detail
  if (!detail?.action) return
  switch (detail.action) {
    case 'play': togglePlay(); break
    case 'pause':
      if (isPlaying.value) togglePlay()
      break
    case 'toggle': togglePlay(); break
    case 'forward': skipForward(); break
    case 'backward': skipBackward(); break
    case 'next': emit('next'); break
    case 'prev': emit('prev'); break
    case 'fullscreen': toggleFullscreen(); break
    case 'mute': toggleMute(); break
  }
}

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

onMounted(() => {
  if (props.url) initPlayer(props.url)
  hideControlsDelayed()
  if (props.subtitleUrl) loadSubtitle(props.subtitleUrl)
  if (props.danmuUrl) loadDanmu(props.danmuUrl)

  window.addEventListener('remote-control', onRemoteControl)
})

watch(() => props.url, (newUrl) => {
  if (newUrl) {
    nextTick(() => initPlayer(newUrl))
  }
})

watch(() => props.subtitleUrl, (newUrl) => {
  if (newUrl) loadSubtitle(newUrl)
})

watch(() => props.danmuUrl, (newUrl) => {
  if (newUrl) loadDanmu(newUrl)
})

watch(subtitleFontSize, (val) => {
  subtitleEngine.setFontSize(val)
  localStorage.setItem('tvbox_subtitle_size', String(val))
})
watch(subtitleColor, (val) => {
  subtitleEngine.setFontColor(val)
  localStorage.setItem('tvbox_subtitle_color', val)
})
watch(subtitleDelay, (val) => {
  subtitleEngine.setDelay(val)
  localStorage.setItem('tvbox_subtitle_delay', String(val))
})
watch(danmuMaxOnScreen, (val) => {
  danmuEngine.setMaxOnScreen(val)
  localStorage.setItem('tvbox_danmu_max', String(val))
})

onBeforeUnmount(() => {
  if (controlsTimer) clearTimeout(controlsTimer)
  if (netSpeedInterval) clearInterval(netSpeedInterval)
  if (longPressTimer) clearTimeout(longPressTimer)
  if (clickFeedbackTimer) clearTimeout(clickFeedbackTimer)
  window.removeEventListener('remote-control', onRemoteControl)
  if (playerInstance) {
    playerInstance.destroy()
    playerInstance = null
  }
})

defineExpose({
  loadSubtitleContent(content: string) {
    subtitleEngine.load(content)
    subtitleEnabled.value = true
    localStorage.setItem('tvbox_subtitle_enabled', 'true')
  },
  getSubtitleEngine() {
    return subtitleEngine
  }
})
</script>

<style scoped>
.video-player-wrapper :deep(.xgplayer) {
  background: #000;
}
.video-player-wrapper :deep(.xgplayer-controls) {
  display: none;
}

/* Control buttons */
.ctrl-btn {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
  cursor: pointer;
  transition: background 200ms ease, color 200ms ease;
  flex-shrink: 0;
}
.ctrl-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}
.ctrl-btn.active {
  color: var(--color-primary);
}
.ctrl-btn.active:hover {
  background: var(--color-primary-soft);
}
.ctrl-btn.play-btn {
  width: 44px;
  height: 44px;
}

/* Progress slider */
.el-slider :deep(.el-slider__runway) {
  background-color: rgba(255, 255, 255, 0.2);
}
.el-slider :deep(.el-slider__bar) {
  background-color: var(--color-primary);
}
.el-slider :deep(.el-slider__button) {
  border-color: var(--color-primary);
  width: 12px;
  height: 12px;
}
.el-slider :deep(.el-slider__button-wrapper) {
  top: -16px;
}

@keyframes danmu-scroll {
  from { transform: translateX(0); }
  to { transform: translateX(calc(-100vw - 200px)); }
}
</style>
