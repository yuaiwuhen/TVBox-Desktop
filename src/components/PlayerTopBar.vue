<script setup lang="ts">
/**
 * PlayerTopBar - 播放器顶部控制栏（与 VideoPlayer 顶栏一致）
 * 通过 provide/inject 共享主组件上下文。
 */
import { inject } from 'vue';
import type { PlayerCtx } from './MoviPlayer.vue';
import { ArrowLeft, CaretLeft, CaretRight, Search, ChatDotRound, Setting, Lock } from '@element-plus/icons-vue';

const ctx = inject<PlayerCtx>('moviPlayerCtx')!;
</script>

<template>
  <div class="absolute inset-x-0 top-0 z-30 pointer-events-none">
    <div class="vp-overlay-top flex items-center px-4 md:px-6 lg:px-8 pointer-events-auto" @click.stop>
      <!-- Left: back button -->
      <button v-if="ctx.hasPrev" class="vp-icon-btn shrink-0 flex items-center justify-center" @click="ctx.emitPrev()"
        title="返回">
        <el-icon :size="20" style="color: #ffffff;">
          <ArrowLeft />
        </el-icon>
      </button>
      <div v-else class="w-9 h-9 shrink-0"></div>

      <!-- Center: episode prev/next with title -->
      <div class="flex items-center justify-center flex-1 min-w-0 gap-3">
        <button v-if="ctx.hasPrev" class="vp-episode-btn shrink-0 flex items-center justify-center gap-1"
          @click="ctx.emitPrev()" title="上一集">
          <el-icon :size="16" style="color: rgba(255,255,255,0.8);">
            <CaretLeft />
          </el-icon>
          <span class="vp-episode-text">上一集</span>
        </button>
        <span class="vp-title truncate text-sm md:text-base font-medium text-center" :title="ctx.title">{{ ctx.title
          }}</span>
        <button v-if="ctx.hasNext" class="vp-episode-btn shrink-0 flex items-center justify-center gap-1"
          @click="ctx.emitNext()" title="下一集">
          <span class="vp-episode-text">下一集</span>
          <el-icon :size="16" style="color: rgba(255,255,255,0.8);">
            <CaretRight />
          </el-icon>
        </button>
      </div>

      <!-- Right: action buttons -->
      <div class="flex items-center gap-1 shrink-0">
        <button v-if="ctx.showSubtitleSearch" class="vp-icon-btn" @click="ctx.emitSearchSubtitle()" title="搜索字幕">
          <el-icon :size="20">
            <Search />
          </el-icon>
        </button>
        <button class="vp-icon-btn" :class="{ active: ctx.danmuEnabled }" @click="ctx.toggleDanmu()" title="弹幕">
          <el-icon :size="20">
            <ChatDotRound />
          </el-icon>
        </button>
        <button class="vp-icon-btn" :class="{ active: ctx.showDanmuSettings }"
          @click="ctx.showDanmuSettings = !ctx.showDanmuSettings" title="弹幕设置">
          <el-icon :size="20">
            <Setting />
          </el-icon>
        </button>
        <button class="vp-icon-btn" @click="ctx.lockScreen()" title="锁屏">
          <el-icon :size="20">
            <Lock />
          </el-icon>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
</style>
