<template>
  <div class="remote-mirror-root">
    <!-- Toolbar -->
    <div class="remote-toolbar">
      <h2 class="remote-title">配置中心（安卓端镜像）</h2>
      <div class="remote-toolbar-btns">
        <el-button size="small" :loading="loading" @click="refresh">
          <el-icon><Refresh /></el-icon>
          <span class="ml-1">刷新</span>
        </el-button>
        <el-button size="small" @click="goBack">
          <el-icon><Back /></el-icon>
          <span class="ml-1">返回</span>
        </el-button>
        <el-button size="small" @click="goHome">
          <el-icon><HomeFilled /></el-icon>
          <span class="ml-1">主页</span>
        </el-button>
      </div>
    </div>

    <!-- Status -->
    <div v-if="error" class="remote-error-box">
      <el-icon color="#f56c6c"><WarningFilled /></el-icon>
      <span>{{ error }}</span>
    </div>

    <!-- Mirror image — keep the old <img> mounted, only swap src once the new
         image has finished loading. This avoids flicker during refresh. The
         aspect-ratio is bound dynamically so the canvas matches the Android
         device's actual width:height (no black bars). -->
    <div v-show="connected" class="remote-canvas">
      <img v-if="image" :src="image" class="remote-img"
        :style="{ aspectRatio: deviceW && deviceH ? `${deviceW} / ${deviceH}` : '16 / 9' }"
        alt="安卓端配置中心镜像"
        @click="onTap" @contextmenu.prevent="onRightClick" />
    </div>
    <div v-if="!connected && !loading && !error" class="remote-empty">
      <el-icon :size="48" color="var(--color-text-tertiary)"><Monitor /></el-icon>
      <p>正在连接安卓端…</p>
      <p class="remote-empty-sub">请确认 MuMu 模拟器已启动、本应用已在安卓端打开，并已执行 adb forward tcp:19978 tcp:9978</p>
    </div>

    <!-- Input row -->
    <div v-show="connected" class="remote-input-row">
      <el-input v-model="text" size="small" placeholder="输入文字发送到安卓端" @keyup.enter="sendText">
        <template #append>
          <el-button @click="sendText"><el-icon><Promotion /></el-icon>&nbsp;发送</el-button>
        </template>
      </el-input>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { Refresh, Back, Delete, Promotion, Monitor, Loading, WarningFilled, HomeFilled } from '@element-plus/icons-vue';
import axios from 'axios';
import { getSpiderApiBaseUrl } from '../core/ConfigParser';

const image = ref('');
const loading = ref(false);
const error = ref('');
const connected = ref(false);
const text = ref('');
const deviceW = ref(0);
const deviceH = ref(0);

let timer: ReturnType<typeof setInterval> | null = null;

function api() {
  return getSpiderApiBaseUrl();
}

/**
 * Fetch the next screenshot but DO NOT swap the <img src> directly.
 * Instead, pre-load the new image in an off-screen Image object; only when
 * it has finished loading do we assign the new data URL to the visible
 * <img>. This keeps the previous frame rendered during the network +
 * decode window and prevents the visible flicker users reported.
 */
async function fetchOnce() {
  const resp = await axios.get(`${api()}/remote/screen?scale=0.6`, { timeout: 8000 });
  const data = resp.data || {};
  if (!data.success || !data.data?.image) {
    error.value =
      (data.error ? data.error + '。' : '') +
      '请前往安卓端打开配置中心完成登录授权（扫码 / cookie 设置）。';
    connected.value = false;
    return;
  }
  const newImage = data.data.image;
  if (data.data.deviceWidth && data.data.deviceHeight) {
    deviceW.value = data.data.deviceWidth;
    deviceH.value = data.data.deviceHeight;
  }

  // Pre-load off-screen; assign src only after 'load' fires.
  const pre = new Image();
  pre.onload = () => {
    image.value = newImage;       // swap with new frame
    connected.value = true;
    error.value = '';
  };
  pre.onerror = () => {
    // Skip this frame but keep previous frame visible.
    console.warn('[RemoteMirror] image pre-load failed');
  };
  pre.src = newImage;
}

async function refresh() {
  loading.value = true;
  try {
    await fetchOnce();
  } finally {
    loading.value = false;
  }
}

function startPolling() {
  stopPolling();
  refresh();
  timer = setInterval(refresh, 2000);
}

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Map a click on the mirrored <img> to device coords and send a tap. */
async function onTap(ev: MouseEvent) {
  const img = ev.currentTarget as HTMLImageElement;
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  const rect = img.getBoundingClientRect();
  const devW = deviceW.value || img.naturalWidth;
  const devH = deviceH.value || img.naturalHeight;
  const sx = ((ev.clientX - rect.left) / rect.width) * devW;
  const sy = ((ev.clientY - rect.top) / rect.height) * devH;
  try {
    await axios.post(`${api()}/remote/tap`, { x: Math.round(sx), y: Math.round(sy) }, { timeout: 8000 });
  } catch (e: any) {
    error.value = `点击失败：${e.message || e}`;
  }
}

/** Long-press sends a long tap — currently just a plain tap fallback. */
async function onRightClick(ev: MouseEvent) {
  const img = ev.currentTarget as HTMLImageElement;
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  const rect = img.getBoundingClientRect();
  const devW = deviceW.value || img.naturalWidth;
  const devH = deviceH.value || img.naturalHeight;
  const sx = ((ev.clientX - rect.left) / rect.width) * devW;
  const sy = ((ev.clientY - rect.top) / rect.height) * devH;
  try {
    await axios.post(`${api()}/remote/tap`, { x: Math.round(sx), y: Math.round(sy), durationMs: 800 }, { timeout: 8000 });
  } catch (e: any) {
    error.value = `长按失败：${e.message || e}`;
  }
}

/** Send BACK key to dismiss any open JAR dialog on the device. */
async function goBack() {
  try {
    await axios.post(`${api()}/remote/back`, {}, { timeout: 8000 });
  } catch (e: any) {
    error.value = `返回失败：${e.message || e}`;
  }
}

/** Send HOME key to fully dismiss any dialog and return to launcher. */
async function goHome() {
  try {
    await axios.post(`${api()}/remote/home`, {}, { timeout: 8000 });
  } catch (e: any) {
    error.value = `主页失败：${e.message || e}`;
  }
}

async function sendText() {
  const t = text.value.trim();
  if (!t) return;
  try {
    await axios.post(`${api()}/remote/text`, { text: t }, { timeout: 8000 });
    text.value = '';
  } catch (e: any) {
    error.value = `发送文字失败：${e.message || e}`;
  }
}

function clearInput() {
  text.value = '';
}

/** Tell the Android side to open the config-center screen (ConfigCenterActivity),
 *  so the mirrored view shows the config center (QR login, cookie settings…)
 *  instead of the Android home screen. */
async function openConfigCenter() {
  try {
    await axios.post(`${api()}/remote/open-config`, {}, { timeout: 8000 });
  } catch (e: any) {
    // Non-fatal: polling will still show whatever screen is present.
    console.warn('[RemoteMirror] open-config failed:', e?.message || e);
  }
}

onMounted(() => {
  // Ensure the Android side is showing the config-center screen before
  // we start mirroring it. Runs in background; polling starts regardless.
  openConfigCenter();
  startPolling();
});
onUnmounted(stopPolling);

// 页面可见性变化时暂停/恢复轮询，避免后台无限拉流
watch(() => document.visibilityState, (s) => {
  if (s === 'visible') startPolling();
  else stopPolling();
});
</script>

<style scoped>
.remote-mirror-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
}

.remote-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.remote-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
  color: var(--color-text-primary);
}

.remote-toolbar-btns {
  display: flex;
  gap: 8px;
}

.remote-error-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(245, 108, 108, 0.1);
  color: #f56c6c;
  font-size: 13px;
}

.remote-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--color-text-tertiary);
  min-height: 300px;
}

.remote-empty p { margin: 0; font-size: 14px; }
.remote-empty-sub { font-size: 12px !important; opacity: 0.7; }

/* Canvas: keep the natural device aspect ratio so the mirrored frame
   matches the Android screen's native aspect ratio (updated reactively via
   the img's inline aspect-ratio), while the canvas itself fills the column.
   The img covers the whole canvas with object-fit: contain — no black bars. */
.remote-canvas {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  overflow: hidden;
  background: #000;
}

/* The img carries the device aspect-ratio (bound inline) and fills the
   whole canvas width — the canvas wraps it exactly, so no black bars and
   the mirrored frame matches the Android device's proportions. */
.remote-img {
  display: block;
  width: 100%;
  height: auto;
  object-fit: contain;
  cursor: pointer;
  user-select: none;
}

.remote-input-row {
  display: flex;
  gap: 8px;
}
</style>