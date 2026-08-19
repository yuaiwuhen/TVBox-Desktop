<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="visible" class="cfg-mask" @click.self="handleClose">
        <div class="cfg-dialog">
          <div class="cfg-header">
            <span class="cfg-title">{{ title }}</span>
            <button class="cfg-close" @click="handleClose">
              <el-icon :size="18"><Close /></el-icon>
            </button>
          </div>
          <div class="cfg-body">
            <p class="cfg-desc">{{ description }}</p>

            <!-- QR scan login — the Android side pops the JAR's own dialog
                 (netdisk scan login etc.) and returns the QR bitmap + live
                 status text. The frontend only displays what Android returns;
                 it does NOT know anything about the specific service. -->
            <template v-if="configType === 'scan'">
              <div class="cfg-scan-box">
                <div v-if="scanLoading" class="cfg-scan-loading">
                  <div class="cfg-scan-spinner"></div>
                  <p>正在唤起扫码登录窗口...</p>
                </div>
                <template v-else-if="qrImage">
                  <img :src="qrImage" class="cfg-scan-qr-img" />
                  <p v-if="scanStatusText" class="cfg-scan-status">{{ scanStatusText }}</p>
                  <p v-else class="cfg-scan-tip">请使用手机扫码完成登录</p>
                </template>
                <div v-else-if="scanError" class="cfg-scan-error">
                  <p>{{ scanError }}</p>
                  <el-button size="small" type="primary" :loading="scanLoading" @click="startScan">重试</el-button>
                </div>
                <p class="cfg-scan-fallback">
                  二维码无法显示？可在安卓端打开「配置中心」直接扫码登录。
                </p>
              </div>
            </template>

            <!-- Remote desktop — mirror the Android config-center screen and
                 let the user operate it directly (tap / text / back). Works on
                 Linux/Mac too: just fill in the app's IP:port. -->
            <template v-else-if="configType === 'remote'">
              <div class="cfg-remote-box">
                <div class="cfg-remote-toolbar">
                  <el-input
                    v-model="remoteInput"
                    size="small"
                    placeholder="输入文本后回车发送（如扫码登录的账号）"
                    @keyup.enter="sendRemoteText"
                  />
                  <el-button size="small" @click="sendRemoteText">发送</el-button>
                  <el-button size="small" @click="remoteRefresh">刷新</el-button>
                  <el-button size="small" @click="remoteBack">返回</el-button>
                </div>
                <div class="cfg-remote-screen" :class="{ 'cfg-remote-loading': remoteLoading }">
                  <img
                    v-if="remoteImage"
                    :src="remoteImage"
                    class="cfg-remote-img"
                    alt="安卓端配置中心"
                    @click="onRemoteTap"
                  />
                  <div v-else class="cfg-remote-empty">
                    <p v-if="remoteError">{{ remoteError }}</p>
                    <p v-else>正在连接安卓端…</p>
                  </div>
                </div>
                <p class="cfg-remote-tip">
                  点击画面即操作安卓端（等同手指点击）。适用于扫码登录、选择配置等需要直接操作 jar 弹窗的场景。
                </p>
              </div>
            </template>

            <!-- Emby server fields -->
            <template v-else-if="configType === 'emby'">
              <div class="cfg-field">
                <label>服务器名称</label>
                <el-input v-model="form.name" placeholder="例如：我的 Emby" />
              </div>
              <div class="cfg-field">
                <label>服务器地址</label>
                <el-input v-model="form.url" placeholder="http://192.168.1.100:8096" />
              </div>
              <div class="cfg-field">
                <label>用户名</label>
                <el-input v-model="form.username" placeholder="Emby 用户名" />
              </div>
              <div class="cfg-field">
                <label>密码（可选）</label>
                <el-input v-model="form.password" type="password" show-password placeholder="留空则不使用密码" />
              </div>
            </template>

            <!-- Info-only -->
            <template v-else-if="configType === 'info'">
              <div class="cfg-info-box">
                <p v-for="(line, i) in infoLines" :key="i">{{ line }}</p>
              </div>
            </template>

            <div v-if="error" class="cfg-error">{{ error }}</div>
          </div>
          <div class="cfg-footer">
            <el-button @click="handleClose">关闭</el-button>
            <el-button
              v-if="configType !== 'remote' && props.remoteButton"
              size="small"
              @click="switchRemote"
            >远程操作</el-button>
            <el-button
              v-if="configType === 'remote'"
              size="small"
              @click="switchBackFromRemote"
            >返回原视图</el-button>
            <el-button
              v-if="configType === 'emby'"
              type="primary"
              :loading="saving"
              @click="handleSave"
            >保存</el-button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import { Close } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import axios from 'axios';
import { getSpiderApiBaseUrl } from '../core/ConfigParser';

type ConfigType = 'emby' | 'info' | 'scan' | 'remote';

const props = defineProps<{
  visible: boolean;
  vodId?: string;
  vodName?: string;
  vodRemarks?: string;
  spiderApi?: string;
  spiderKey?: string;
  scanEntry?: boolean;
  remoteButton?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'saved'): void;
}>();

const error = ref('');
const saving = ref(false);

// QR scan state — the Android side runs the JAR's own scan dialog and returns
// the QR image + status text. The frontend only displays what Android gives.
const scanLoading = ref(false);
const qrImage = ref('');
const scanStatusText = ref('');
const scanError = ref('');
let pollTimer: ReturnType<typeof setInterval> | null = null;

// Remote desktop state — mirror the Android config-center screen and let the
// user tap/text/back directly. adb-free: uses the app's own /remote endpoints.
const remoteImage = ref('');
const remoteInput = ref('');
const remoteLoading = ref(false);
const remoteError = ref('');
const remoteDeviceW = ref(0);
const remoteDeviceH = ref(0);
let remoteTimer: ReturnType<typeof setInterval> | null = null;

const form = ref<any>({
  name: '', url: '', username: '', password: '',
});

const configType = ref<ConfigType>('info');
const title = ref('');
const description = ref('');
const infoLines = ref<string[]>([]);

// Descriptions for feimao (csp_Config) go设置 items (numeric vod_ids).
const FEIMAO_GO_INFO: Record<string, { desc: string; lines?: string[] }> = {
  '1': { desc: 'go 服务（弹幕/解析）当前运行状态。' },
  '2': { desc: '手动启动 go 服务。' },
  '4': {
    desc: 'Cookie 级别与复制操作。',
    lines: ['查看当前 Cookie 级别，或复制 Cookie 到剪贴板。'],
  },
};

function buildDialogMeta() {
  const id = (props.vodId || '').toLowerCase();
  const name = props.vodName || '';
  const remarks = props.vodRemarks || '';
  const api = (props.spiderApi || '').toLowerCase();
  title.value = name;
  description.value = remarks || '请配置以下选项';
  configType.value = 'info';
  infoLines.value = [];
  form.value = {
    name: '', url: '', username: '', password: '',
  };
  stopPolling();

  // QR scan login — Home.vue flags config-action items (netdisk scan login
  // etc.). We ask Android to run the JAR's own dialog and display the returned
  // QR + status. The frontend contains NO netdisk fields.
  if (props.spiderKey && props.scanEntry) {
    configType.value = 'scan';
    description.value = remarks || '扫码登录';
    startScan();
    return;
  }

  if (id === 'editemby' || id === 'choseemby' || id === 'delemby' || id === 'clearemby' || id.includes('emby')) {
    configType.value = 'emby';
    description.value = '配置 Emby 服务器连接信息。保存后将通过 JAR 写入 SharedPreferences。';
    if (id === 'delemby' || id === 'clearemby') {
      description.value = '此操作将清除已保存的 Emby 服务器配置。';
    }
    return;
  }
  // feimao (csp_Config) go设置 — numeric vod_ids
  if (api.includes('csp_config') && /^\d+$/.test(id) && FEIMAO_GO_INFO[id]) {
    const info = FEIMAO_GO_INFO[id];
    configType.value = 'info';
    description.value = info.desc;
    infoLines.value = [
      remarks ? `当前状态：${remarks}` : '',
      '',
      ...(info.lines || []),
      'PC 端暂不支持此操作，请通过手机端配置中心设置。',
    ].filter((l) => l !== null && l !== undefined);
    return;
  }
  // Default info
  configType.value = 'info';
  infoLines.value = [
    `${name}：${remarks || '无附加说明'}`,
    '',
    '该配置项 PC 端暂不支持，请通过手机端配置中心设置。',
  ];
}

// ── Remote desktop (config-center mirroring) ──────────────────────────────
// The Android app exposes /remote/* endpoints (adb-free). The frontend polls
// the screen and translates clicks/text/back to the device. Works on
// Linux/Mac too — just fill in the app's IP:port.

/** Start polling the mirrored screen (~1 fps is enough for config-center
 *  interaction; JAR dialogs change after each tap). */
function startRemote() {
  stopRemote();
  remoteError.value = '';
  remoteImage.value = '';
  remoteLoading.value = true;
  remoteFetch();
  remoteTimer = setInterval(remoteFetch, 1200);
}

function stopRemote() {
  if (remoteTimer) {
    clearInterval(remoteTimer);
    remoteTimer = null;
  }
}

async function remoteFetch() {
  if (!props.visible) return;
  try {
    const base = getSpiderApiBaseUrl();
    const resp = await axios.get(`${base}/remote/screen?scale=0.6`, {
      timeout: 5000,
    });
    const data = resp.data || {};
    if (data.success && data.data?.image) {
      remoteImage.value = data.data.image;
      // 记住设备真实分辨率，点击镜像时把点击坐标换算为设备绝对坐标
      if (data.data.deviceWidth && data.data.deviceHeight) {
        remoteDeviceW.value = data.data.deviceWidth;
        remoteDeviceH.value = data.data.deviceHeight;
      }
      remoteLoading.value = false;
      remoteError.value = '';
    } else {
      remoteError.value = data.error || '连接失败';
    }
  } catch (e: any) {
    remoteError.value = `连接安卓端失败：${e.message || e}`;
  } finally {
    remoteLoading.value = false;
  }
}

/** Map a click on the mirrored <img> to device coords and send a tap. */
function onRemoteTap(ev: MouseEvent) {
  const img = ev.currentTarget as HTMLImageElement;
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  const rect = img.getBoundingClientRect();
  // 设备真实分辨率（安卓端 /remote/screen 返回）；未知时回退到镜像自然尺寸
  const devW = remoteDeviceW.value || img.naturalWidth;
  const devH = remoteDeviceH.value || img.naturalHeight;
  // 换算：镜像内相对位置 × 设备分辨率 = 设备绝对坐标
  const sx = ((ev.clientX - rect.left) / rect.width) * devW;
  const sy = ((ev.clientY - rect.top) / rect.height) * devH;
  void remoteTap(Math.round(sx), Math.round(sy));
}

async function remoteTap(x: number, y: number) {
  try {
    const base = getSpiderApiBaseUrl();
    await axios.post(`${base}/remote/tap`, { x, y }, { timeout: 5000 });
    await remoteFetch();
  } catch (e: any) {
    remoteError.value = `点击失败：${e.message || e}`;
  }
}

async function sendRemoteText() {
  const text = remoteInput.value.trim();
  if (!text) return;
  try {
    const base = getSpiderApiBaseUrl();
    await axios.post(`${base}/remote/text`, { text }, { timeout: 5000 });
    remoteInput.value = '';
  } catch (e: any) {
    remoteError.value = `输入失败：${e.message || e}`;
  }
}

async function remoteBack() {
  try {
    const base = getSpiderApiBaseUrl();
    await axios.post(`${base}/remote/back`, {}, { timeout: 5000 });
    await remoteFetch();
  } catch (e: any) {
    remoteError.value = `返回失败：${e.message || e}`;
  }
}

function remoteRefresh() {
  remoteFetch();
}

/** Remember the current view so "返回原视图" can restore it. */
let prevConfigType: ConfigType | null = null;

function switchRemote() {
  prevConfigType = configType.value;
  stopPolling();
  configType.value = 'remote';
  startRemote();
}

function switchBackFromRemote() {
  stopRemote();
  configType.value = prevConfigType || 'info';
  prevConfigType = null;
}

// Ask the Android side to run the JAR's scan dialog and return the QR image.
// Android pops the JAR's own netdisk login dialog, captures the QR from the
// dialog window, and responds with base64. We just display it.
async function startScan() {
  stopPolling();
  scanLoading.value = true;
  qrImage.value = '';
  scanStatusText.value = '';
  scanError.value = '';
  const base = getSpiderApiBaseUrl();
  try {
    const resp = await axios.post(`${base}/spider/scan`, {
      key: props.spiderKey,
      ids: [props.vodId],
    });
    const data = resp.data || {};
    if (data.success && data.data?.qrImage) {
      qrImage.value = data.data.qrImage;
      startPolling();
    } else {
      scanError.value = (data.error || '扫码窗口启动失败')
        + '。如持续失败，请在安卓端打开「配置中心」直接扫码登录。';
    }
  } catch (e: any) {
    scanError.value = `扫码服务不可用：${e.message || e}。请确认安卓端服务已启动，或在安卓端打开「配置中心」直接扫码登录。`;
  } finally {
    scanLoading.value = false;
  }
}

// Poll the Android side for live dialog status (status text updates as the
// login state changes: "请使用xx浏览器扫码" → success).
function startPolling() {
  stopPolling();
  const base = getSpiderApiBaseUrl();
  pollTimer = setInterval(async () => {
    try {
      const resp = await axios.post(`${base}/spider/scan-status`, {});
      const data = resp.data || {};
      if (data.success && data.data) {
        if (data.data.qrImage) qrImage.value = data.data.qrImage;
        scanStatusText.value = data.data.statusText || '';
        if (!data.data.dialogPresent) {
          // dialog closed — login may have completed
          stopPolling();
        }
      }
    } catch {
      // ignore transient polling errors
    }
  }, 1500);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function handleClose() {
  stopPolling();
  emit('update:visible', false);
}

watch(() => props.visible, (v) => {
  if (v) {
    error.value = '';
    buildDialogMeta();
    if (configType.value === 'remote') {
      startRemote();
    }
  } else {
    stopRemote();
  }
}, { immediate: true });

// 当 dialog 已打开、用户再次点击另一个配置项时（visible 不变），
// vodId 变化也要重新构建 dialog 内容并触发 scan / remote。
watch(() => props.vodId, (v, old) => {
  if (v && v !== old && props.visible) {
    error.value = '';
    buildDialogMeta();
    if (configType.value === 'remote') {
      startRemote();
    }
  }
});

onUnmounted(() => {
  stopPolling();
  stopRemote();
});

async function handleSave() {
  const id = (props.vodId || '').toLowerCase();
  saving.value = true;
  error.value = '';
  try {
    // For Emby, we'd need to call a specific JAR method to add/select/delete
    // servers. Since the JAR HTTP API doesn't expose Emby management, we
    // show a message that this needs to be done via mobile config center.
    if (configType.value === 'emby') {
      ElMessage.info('Emby 服务器管理请通过手机端配置中心完成。PC 端暂不支持此操作。');
      emit('update:visible', false);
      return;
    }
    // Default — just close
    emit('update:visible', false);
  } catch (e: any) {
    error.value = `保存失败：${e.message || e}`;
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.cfg-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  backdrop-filter: blur(4px);
}
.cfg-dialog {
  background: var(--color-bg-elevated, #1f2937);
  border-radius: 14px;
  width: 90%;
  max-width: 540px;
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  animation: dialogIn 0.2s ease-out;
}
@keyframes dialogIn {
  from { transform: translateY(-10px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
.cfg-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
  position: sticky;
  top: 0;
  background: var(--color-bg-elevated, #1f2937);
  z-index: 1;
}
.cfg-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary, #fff);
}
.cfg-close {
  background: transparent;
  border: none;
  color: var(--color-text-secondary, #9ca3af);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cfg-close:hover {
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--color-text-primary, #fff);
}
.cfg-body {
  padding: 18px 20px;
}
.cfg-desc {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--color-text-secondary, #9ca3af);
  line-height: 1.6;
}
.cfg-scan-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 10px 0;
}
/* Remote desktop (config-center mirroring) */
.cfg-remote-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cfg-remote-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cfg-remote-toolbar .el-input {
  flex: 1;
}
.cfg-remote-screen {
  position: relative;
  width: 100%;
  height: 480px;
  border-radius: 10px;
  overflow: hidden;
  background: #111;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  cursor: crosshair;
}
.cfg-remote-screen.cfg-remote-loading::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(17, 17, 17, 0.35);
}
.cfg-remote-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
}
.cfg-remote-empty {
  color: #94a3b8;
  font-size: 13px;
  text-align: center;
  padding: 20px;
}
.cfg-remote-tip {
  font-size: 12px;
  color: #9ca3af;
  margin: 0;
  text-align: center;
  line-height: 1.7;
}
.cfg-scan-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--color-text-secondary, #9ca3af);
  font-size: 13px;
  padding: 24px 0;
}
.cfg-scan-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top-color: var(--color-primary, #409eff);
  border-radius: 50%;
  animation: cfgSpin 0.8s linear infinite;
}
@keyframes cfgSpin {
  to { transform: rotate(360deg); }
}
.cfg-scan-qr-img {
  width: 220px;
  height: 220px;
  border-radius: 10px;
  background: #fff;
  padding: 6px;
}
.cfg-scan-status {
  margin: 0;
  font-size: 13px;
  color: var(--color-success, #67c23a);
  text-align: center;
}
.cfg-scan-tip {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-secondary, #9ca3af);
  text-align: center;
}
.cfg-scan-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px 0;
  font-size: 13px;
  color: #f56c6c;
  text-align: center;
}
.cfg-scan-fallback {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-secondary, #9ca3af);
  text-align: center;
  line-height: 1.8;
}
.cfg-field {
  margin-bottom: 14px;
}
.cfg-field label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary, #d1d5db);
}
.cfg-field :deep(.el-input__inner),
.cfg-field :deep(.el-textarea__inner) {
  background: var(--color-bg-base, #111827);
  border-color: var(--color-border, rgba(255, 255, 255, 0.1));
  color: var(--color-text-primary, #fff);
}
.cfg-info-box {
  background: var(--color-bg-base, #111827);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  padding: 14px 16px;
  font-size: 13px;
  color: var(--color-text-secondary, #d1d5db);
  line-height: 1.7;
  white-space: pre-wrap;
}
.cfg-info-box p {
  margin: 0;
}
.cfg-error {
  margin-top: 10px;
  font-size: 12px;
  color: #f56c6c;
}
.cfg-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
  position: sticky;
  bottom: 0;
  background: var(--color-bg-elevated, #1f2937);
}
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>
