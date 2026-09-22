<script setup lang="ts">
/**
 * PlayerBottomBar - 播放器底部控制栏（与 VideoPlayer 底栏一致）
 * 包含：进度条 / 时间显示 / 快退·播放·快进·下一集 / 音量 / 倍速 /
 * 音轨 / 字幕 / 更多设置 / 画中画 / 全屏 / 应用全屏。
 * 通过 provide/inject 共享主组件上下文。
 */
import { ref, computed, inject } from 'vue';
import type { PlayerCtx } from './MoviPlayer.vue';
import {
  RefreshLeft,
  VideoPause,
  VideoPlay,
  RefreshRight,
  Right,
  Microphone,
  Mute,
  Headset,
  DocumentCopy,
  MoreFilled,
  Monitor,
  FullScreen,
  Rank,
} from '@element-plus/icons-vue';

const ctx = inject<PlayerCtx>('moviPlayerCtx')!;

// ==================== 进度条交互 ====================
const seekBarRef = ref<HTMLDivElement>();
const isDragging = ref(false);
const hoverPercent = ref(0);
const showHoverTime = ref(false);

const bufferedPercent = computed(() => {
  if (ctx.duration === 0) return 0;
  return (ctx.buffered / ctx.duration) * 100;
});

const getHoverTime = computed(() => {
  if (!ctx.duration) return '0:00';
  return formatTime((hoverPercent.value / 100) * ctx.duration);
});

const onSeekBarMouseDown = (e: MouseEvent) => {
  if (!seekBarRef.value || !ctx.duration) return;
  isDragging.value = true;
  handleSeek(e);
  window.addEventListener('mousemove', handleSeek);
  window.addEventListener('mouseup', onSeekBarMouseUp);
};

const handleSeek = (e: MouseEvent) => {
  if (!seekBarRef.value || !ctx.duration) return;
  const rect = seekBarRef.value.getBoundingClientRect();
  const percent = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
  hoverPercent.value = percent;
  if (isDragging.value) {
    const targetTime = Math.max(0, Math.min(ctx.duration, (percent / 100) * ctx.duration));
    if (isNaN(targetTime) || !isFinite(targetTime)) return;
    ctx.seekTo(targetTime);
  }
};

const onSeekBarMouseUp = () => {
  if (isDragging.value) {
    isDragging.value = false;
    const targetTime = Math.max(0, Math.min(ctx.duration, (hoverPercent.value / 100) * ctx.duration));
    if (!isNaN(targetTime) && isFinite(targetTime)) {
      ctx.seekTo(targetTime);
      ctx.playVideo();
    }
  }
  window.removeEventListener('mousemove', handleSeek);
  window.removeEventListener('mouseup', onSeekBarMouseUp);
};

const onSeekBarMouseMove = (e: MouseEvent) => {
  if (!seekBarRef.value || !ctx.duration) return;
  const rect = seekBarRef.value.getBoundingClientRect();
  hoverPercent.value = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
  showHoverTime.value = true;
};

const onSeekBarMouseLeave = () => {
  showHoverTime.value = false;
};

// ==================== 音量滑条交互 ====================
const volumeSliderRef = ref<HTMLDivElement>();

const onVolumeSliderMouseDown = (e: MouseEvent) => {
  if (!volumeSliderRef.value) return;
  handleVolume(e);
  window.addEventListener('mousemove', handleVolume);
  window.addEventListener('mouseup', onVolumeSliderMouseUp);
};

const handleVolume = (e: MouseEvent) => {
  if (!volumeSliderRef.value) return;
  const rect = volumeSliderRef.value.getBoundingClientRect();
  const percent = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
  ctx.setVolume(percent / 100);
};

const onVolumeSliderMouseUp = () => {
  window.removeEventListener('mousemove', handleVolume);
  window.removeEventListener('mouseup', onVolumeSliderMouseUp);
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
</script>

<template>
  <div class="absolute inset-x-0 bottom-0 z-30 pointer-events-none">
    <div class="vp-overlay-bottom px-4 md:px-6 lg:px-8 pb-1.5 pt-3 pointer-events-auto" @click.stop>
      <!-- Seek bar -->
      <div ref="seekBarRef" class="vp-seek-bar group relative w-full mb-3 cursor-pointer"
        @mousedown="onSeekBarMouseDown" @mousemove="onSeekBarMouseMove" @mouseleave="onSeekBarMouseLeave">
        <div class="vp-seek-track absolute left-0 right-0">
          <div class="vp-seek-track-bg absolute left-0 right-0 h-full"></div>
          <div class="vp-seek-buffered absolute left-0 top-0 h-full" :style="{ width: bufferedPercent + '%' }"></div>
          <div class="vp-seek-progress absolute left-0 top-0 h-full" :style="{ width: ctx.progressPercent + '%' }"></div>
        </div>
        <div class="vp-seek-thumb absolute" :style="{ left: ctx.progressPercent + '%' }"></div>
        <div v-if="showHoverTime" class="vp-seek-tooltip absolute" :style="{ left: hoverPercent + '%' }">
          {{ getHoverTime }}
        </div>
      </div>

      <!-- Time display -->
      <div class="flex items-center justify-center mb-2.5 pointer-events-none">
        <span class="text-xs whitespace-nowrap tabular-nums" style="color: rgba(255,255,255,0.8);">
          <span style="color: #ffffff;">{{ ctx.formattedCurrentTime }}</span> / {{ ctx.formattedDuration }}
        </span>
      </div>

      <!-- Controls row -->
      <div class="flex items-center gap-2">
        <!-- LEFT SIDE -->
        <div class="flex items-center gap-1 shrink-0">
          <button class="vp-control-btn flex items-center justify-center gap-1" @click="ctx.skipBackward()"
            :title="`快退${ctx.timeStep}秒`">
            <el-icon :size="20" style="color: #ffffff;">
              <RefreshLeft />
            </el-icon>
            <span class="vp-control-text">{{ ctx.timeStep }}s</span>
          </button>
          <button class="vp-play-btn flex items-center justify-center" @click="ctx.togglePlay()"
            :title="ctx.isPlaying ? '暂停' : '播放'">
            <el-icon :size="24" style="color: #ffffff;">
              <component :is="ctx.isPlaying ? VideoPause : VideoPlay" />
            </el-icon>
          </button>
          <button class="vp-control-btn flex items-center justify-center gap-1" @click="ctx.skipForward()"
            :title="`快进${ctx.timeStep}秒`">
            <el-icon :size="20" style="color: #ffffff;">
              <RefreshRight />
            </el-icon>
            <span class="vp-control-text">{{ ctx.timeStep }}s</span>
          </button>
          <div class="vp-divider mx-1 hidden md:block"></div>
          <button v-if="ctx.hasNext" class="vp-control-btn flex items-center justify-center gap-1.5"
            @click="ctx.emitNext()" title="下一集">
            <el-icon :size="16" style="color: #ffffff;">
              <Right />
            </el-icon>
            <span class="vp-episode-text">下一集</span>
          </button>
        </div>

        <!-- Center spacer -->
        <div class="flex-1"></div>

        <!-- RIGHT SIDE -->
        <div class="flex items-center gap-1 shrink-0">
          <!-- Volume group -->
          <div class="vp-volume-group hidden sm:flex items-center gap-0.5 relative">
            <button class="vp-icon-btn" @click="ctx.toggleMute()" :title="ctx.isMuted ? '取消静音' : '静音'">
              <el-icon :size="20" style="color: #ffffff;">
                <component :is="ctx.isMuted ? Mute : Microphone" />
              </el-icon>
            </button>
            <div class="vp-volume-slider flex items-center">
              <div ref="volumeSliderRef" class="relative w-24 h-full flex items-center cursor-pointer"
                @mousedown="onVolumeSliderMouseDown">
                <div class="absolute left-0 right-0" style="height: 3px; background: rgba(255,255,255,0.12); border-radius: 2px;">
                  <div class="absolute left-0 top-0 h-full" style="background: var(--color-primary); border-radius: 2px;"
                    :style="{ width: (ctx.isMuted ? 0 : ctx.volume * 100) + '%' }"></div>
                </div>
                <div class="absolute" style="width: 12px; height: 12px; border-radius: 50%; background: #ffffff;"
                  :style="{ left: (ctx.isMuted ? 0 : ctx.volume * 100) + '%', top: '50%', transform: 'translate(-50%, -50%)' }">
                </div>
              </div>
            </div>
          </div>

          <div class="vp-divider mx-0.5 hidden sm:block"></div>

          <!-- Playback speed -->
          <el-dropdown @command="ctx.changeSpeed" trigger="click">
            <button class="vp-speed-btn flex items-center justify-center" title="播放速度">
              {{ ctx.playbackRate }}x
            </button>
            <template #dropdown>
              <el-dropdown-menu class="vp-dropdown-menu">
                <el-dropdown-item v-for="s in [0.5, 0.75, 1, 1.25, 1.5, 2, 3]" :key="s" :command="s">{{ s }}x</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>

          <!-- Audio track -->
          <el-dropdown @command="ctx.selectAudio" trigger="click">
            <button class="vp-icon-btn" :class="{ active: ctx.audioMenuItems.some(m => m.active) }" title="音轨">
              <el-icon :size="20">
                <Headset />
              </el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu class="vp-dropdown-menu">
                <el-dropdown-item v-if="ctx.audioMenuItems.length === 0" disabled>无可用音轨</el-dropdown-item>
                <el-dropdown-item v-for="m in ctx.audioMenuItems" :key="m.id" :command="m.id">
                  <span :style="{ color: m.active ? 'var(--color-primary)' : '' }">{{ m.label }}</span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>

          <!-- Subtitle track -->
          <el-dropdown @command="ctx.selectSubtitle" trigger="click">
            <button class="vp-icon-btn"
              :class="{ active: ctx.subtitleMenuItems.some(m => m.active && m.id !== '__off') }" title="字幕轨">
              <el-icon :size="20">
                <DocumentCopy />
              </el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu class="vp-dropdown-menu">
                <el-dropdown-item :command="'__off'">
                  <span
                    :style="{ color: ctx.subtitleMenuItems.find(m => m.id === '__off')?.active ? 'var(--color-primary)' : '' }">关闭</span>
                </el-dropdown-item>
                <el-dropdown-item v-if="ctx.subtitleMenuItems.length <= 1" disabled>无可用字幕轨</el-dropdown-item>
                <el-dropdown-item v-for="m in ctx.subtitleMenuItems.filter(s => s.id !== '__off')" :key="m.id"
                  :command="m.id">
                  <span :style="{ color: m.active ? 'var(--color-primary)' : '' }">{{ m.label }}</span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>

          <!-- More settings (面板内嵌在底栏组件中) -->
          <button class="vp-icon-btn" :class="{ active: ctx.showMorePanel }" @click="ctx.showMorePanel = !ctx.showMorePanel"
            title="更多">
            <el-icon :size="20">
              <MoreFilled />
            </el-icon>
          </button>

          <!-- Picture-in-Picture -->
          <button class="vp-icon-btn" @click="ctx.togglePiP()" title="画中画">
            <el-icon :size="20">
              <Monitor />
            </el-icon>
          </button>

          <!-- Fullscreen -->
          <button class="vp-icon-btn" @click="ctx.toggleFullscreen()" :title="ctx.isFullscreen ? '退出全屏' : '全屏'">
            <el-icon :size="20">
              <FullScreen />
            </el-icon>
          </button>

          <!-- App fullscreen -->
          <button class="vp-icon-btn" :class="{ active: ctx.isAppFullscreen }" @click="ctx.toggleAppFullscreen()"
            :title="ctx.isAppFullscreen ? '退出应用全屏' : '应用全屏'">
            <el-icon :size="20">
              <Rank />
            </el-icon>
          </button>
        </div>
      </div>
    </div>

    <!-- 更多设置面板 -->
    <div v-if="ctx.showMorePanel"
      class="absolute bottom-16 right-4 z-[60] w-56 rounded-lg border border-white/10 bg-black/85 p-3 text-sm text-white shadow-xl backdrop-blur">
      <div class="mb-1 text-white/60">画面比例</div>
      <el-select :model-value="ctx.aspectRatio" @change="ctx.changeAspectRatio" size="small" class="mb-3 w-full">
        <el-option v-for="r in ctx.aspectRatios" :key="r.value" :label="r.label" :value="r.value" />
      </el-select>
      <div class="mb-1 text-white/60">快进/快退步长</div>
      <el-select :model-value="String(ctx.timeStep)" @change="(v: string) => ctx.setTimeStep(Number(v))" size="small"
        class="mb-3 w-full">
        <el-option v-for="s in [5, 10, 15, 20, 25, 30]" :key="s" :label="s + 's'" :value="String(s)" />
      </el-select>
      <button class="mb-1 w-full rounded px-2 py-1.5 text-left hover:bg-white/10"
        :style="{ color: ctx.skipIntro > 0 ? 'var(--color-primary)' : '' }" @click="ctx.toggleSkipIntro()">
        片头跳过 {{ ctx.skipIntro > 0 ? ctx.skipIntro + 's' : '关' }}
      </button>
      <button class="w-full rounded px-2 py-1.5 text-left hover:bg-white/10"
        :style="{ color: ctx.skipOutro > 0 ? 'var(--color-primary)' : '' }" @click="ctx.toggleSkipOutro()">
        片尾跳过 {{ ctx.skipOutro > 0 ? ctx.skipOutro + 's' : '关' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
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

.vp-seek-bar:hover .vp-seek-thumb,
.vp-seek-bar:active .vp-seek-thumb {
  opacity: 1;
}

.vp-seek-bar:active .vp-seek-thumb {
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
  width: 116px;
}

.vp-volume-slider {
  position: absolute;
  left: calc(100% + 6px);
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
  z-index: 5;
  transition: width 200ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)),
              padding 200ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
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

.vp-episode-text {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
  white-space: nowrap;
  display: none;
}

@media (min-width: 768px) {
  .vp-episode-text {
    display: inline;
  }
}

/* el-dropdown 菜单 teleport 到 body，scoped 选择器不生效，需 :global() */
:global(.vp-dropdown-menu) {
  background: var(--color-bg-elevated) !important;
  border: 1px solid var(--color-border) !important;
  /* 字幕轨可能很多（夸克内嵌多语言轨），限制高度并滚动 */
  max-height: 320px;
  overflow-y: auto;
}

@media (prefers-reduced-motion: reduce) {
  .vp-seek-thumb,
  .vp-volume-slider,
  .vp-overlay-bottom {
    transition: none !important;
  }
}
</style>
