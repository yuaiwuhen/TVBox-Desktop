<script setup lang="ts">
/**
 * PlayerDanmuPanel - 弹幕设置面板（与 VideoPlayer 弹幕设置一致）
 * 通过 provide/inject 共享主组件上下文。
 */
import { inject } from 'vue';
import type { PlayerCtx } from './MoviPlayer.vue';

const ctx = inject<PlayerCtx>('moviPlayerCtx')!;

const onDanmuToggle = (val: boolean) => {
  ctx.danmuEnabled = val;
};

const onDanmuSpeedChange = (idx: number) => {
  ctx.danmuSpeedIndex = idx;
};

const onDanmuOpacityChange = (val: number) => {
  ctx.danmuOpacity = val;
};

const adjustDanmuLines = (delta: number) => {
  ctx.danmuLines = Math.max(1, Math.min(15, ctx.danmuLines + delta));
};
</script>

<template>
  <div class="vp-danmu-panel absolute p-3 rounded-lg z-40 w-56 space-y-2 text-sm">
    <div class="flex justify-between items-center">
      <span style="color: var(--color-text-primary);">弹幕开关</span>
      <el-switch :model-value="ctx.danmuEnabled" size="small" @change="onDanmuToggle" />
    </div>
    <div>
      <span style="color: var(--color-text-secondary);">速度</span>
      <el-slider :model-value="ctx.danmuSpeedIndex" :min="0" :max="3" :step="1"
        :format-tooltip="(v: number) => ctx.danmuSpeedOptions[v].label" @change="onDanmuSpeedChange" />
    </div>
    <div>
      <span style="color: var(--color-text-secondary);">透明度 {{ ctx.danmuOpacity }}%</span>
      <el-slider :model-value="ctx.danmuOpacity" :min="10" :max="100" :step="10" @change="onDanmuOpacityChange" />
    </div>
    <div class="flex justify-between items-center">
      <span style="color: var(--color-text-secondary);">行数</span>
      <div class="flex items-center gap-1">
        <el-button size="small" @click="adjustDanmuLines(-1)">-</el-button>
        <span class="w-6 text-center" style="color: var(--color-text-primary);">{{ ctx.danmuLines }}</span>
        <el-button size="small" @click="adjustDanmuLines(1)">+</el-button>
      </div>
    </div>
    <div class="flex justify-between items-center">
      <span style="color: var(--color-text-secondary);">颜色</span>
      <el-select :model-value="ctx.danmuColorMode" size="small" style="width:80px"
        @change="(v: string) => ctx.danmuColorMode = v">
        <el-option label="默认" value="default" />
        <el-option label="随机" value="random" />
      </el-select>
    </div>
    <el-button size="small" @click="ctx.showDanmuSettings = false" class="w-full">关闭</el-button>
  </div>
</template>

<style scoped>
.vp-danmu-panel {
  top: 48px;
  right: 8px;
  background: var(--color-bg-elevated);
  backdrop-filter: var(--glass-blur-heavy);
  -webkit-backdrop-filter: var(--glass-blur-heavy);
  border: var(--glass-border);
  box-shadow: var(--surface-floating-shadow);
}
</style>
