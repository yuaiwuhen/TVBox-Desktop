<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="visible" class="wex-mask" @click.self="handleClose">
        <div class="wex-dialog">
          <div class="wex-header">
            <div class="wex-title-group">
              <span class="wex-title">{{ dialogTitle }}</span>
              <span v-if="targetPanType" class="wex-subtitle">
                扫码完成{{ targetDisplayName }}登录后自动关闭
              </span>
            </div>
            <button class="wex-close" @click="handleClose">
              <el-icon :size="18">
                <Close />
              </el-icon>
            </button>
          </div>
          <div class="wex-body">
            <div v-if="loading" class="wex-loading">
              <el-icon :size="32" class="rotating">
                <Loading />
              </el-icon>
              <span>正在加载配置页面...</span>
            </div>
            <div v-else-if="error" class="wex-error">
              <el-icon :size="32" color="#f56c6c">
                <Warning />
              </el-icon>
              <span class="error-text">{{ error }}</span>
              <button class="retry-btn" @click="loadWexConfig">
                重试
              </button>
            </div>
            <div v-else class="wex-content">
              <div class="wex-iframe-wrapper">
                <iframe
                  v-if="wexConfigUrl"
                  ref="iframeRef"
                  :src="wexConfigUrl"
                  class="wex-iframe"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  @load="onIframeLoad"
                />
                <div v-if="loginDetected" class="wex-success-overlay">
                  <el-icon :size="48" color="#67c23a">
                    <CircleCheck />
                  </el-icon>
                  <span class="success-text">登录成功</span>
                </div>
              </div>
              <div class="wex-tips">
                <template v-if="loginDetected">
                  <el-icon :size="16" color="#67c23a">
                    <CircleCheckFilled />
                  </el-icon>
                  <span style="color: #67c23a">
                    {{ successMessage }}
                  </span>
                </template>
                <template v-else>
                  <el-icon :size="16">
                    <InfoFilled />
                  </el-icon>
                  <span>在配置页面中扫码登录，完成后将自动关闭</span>
                </template>
              </div>
            </div>
          </div>
          <div class="wex-footer">
            <span class="wex-poll-status">
              {{ pollStatusText }}
            </span>
            <button class="wex-done-btn" @click="handleDone">
              我已完成
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from 'vue';
import {
  Close,
  Loading,
  Warning,
  InfoFilled,
  CircleCheck,
  CircleCheckFilled,
} from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { PanLogin, type PanType } from '../core/PanLogin';

const props = defineProps<{
  visible: boolean;
  /** If set, auto-close when this specific pan logs in. If null, close on any new login. */
  targetPanType?: PanType | null;
  title?: string;
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (
    e: 'success',
    info: { panType: PanType; cookieLength?: number },
  ): void;
  (e: 'close'): void;
}>();

const loading = ref(false);
const error = ref('');
const wexConfigUrl = ref('');
const loginDetected = ref(false);
const successMessage = ref('');
const iframeRef = ref<HTMLIFrameElement | null>(null);
const pollCount = ref(0);

let pollTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_POLL_COUNT = 300; // 10 minutes at 2s interval
const POLL_INTERVAL = 2000;

const targetDisplayName = computed(() => {
  if (!props.targetPanType) return '';
  return PanLogin.getDisplayName(props.targetPanType);
});

const dialogTitle = computed(() => {
  if (props.title) return props.title;
  if (props.targetPanType) {
    return `${targetDisplayName.value}登录`;
  }
  return '网盘配置中心';
});

const pollStatusText = computed(() => {
  if (loginDetected.value) return '登录已确认';
  if (pollCount.value > 0) {
    return `正在检测登录状态... (${pollCount.value}/${MAX_POLL_COUNT})`;
  }
  return '';
});

watch(
  () => props.visible,
  (val) => {
    if (val) {
      loadWexConfig();
    } else {
      stopPolling();
      resetState();
    }
  },
);

onUnmounted(() => {
  stopPolling();
});

function resetState() {
  loading.value = false;
  error.value = '';
  wexConfigUrl.value = '';
  loginDetected.value = false;
  successMessage.value = '';
  pollCount.value = 0;
}

function handleClose() {
  emit('update:visible', false);
  emit('close');
}

function handleDone() {
  // User manually confirms they're done. Check login status one more time
  // before closing so we can emit success if a login just completed.
  void checkOnceAndClose();
}

async function checkOnceAndClose() {
  try {
    const result = await PanLogin.checkWexConfigLogin(
      props.targetPanType || null,
    );
    if (result.newLogins.length > 0) {
      const panType = result.newLogins[0];
      const cookieLen = result.cookies[panType]?.length;
      emit('success', { panType, cookieLength: cookieLen });
    }
  } catch (e: any) {
    console.warn('[WexConfigDialog] final check failed:', e.message);
  }
  handleClose();
}

async function loadWexConfig() {
  loading.value = true;
  error.value = '';
  loginDetected.value = false;
  pollCount.value = 0;

  try {
    wexConfigUrl.value = await PanLogin.getWexConfigUrl();
    console.log(
      '[WexConfigDialog] Loading wexconfig URL:',
      wexConfigUrl.value,
    );
    // loading is cleared when iframe @load fires; but set a fallback timeout
    // in case the load event doesn't fire (e.g. slow page).
    setTimeout(() => {
      if (loading.value) {
        loading.value = false;
        console.log(
          '[WexConfigDialog] iframe load timeout, showing content anyway',
        );
      }
    }, 5000);
    // Start polling immediately — login could complete quickly
    startPolling();
  } catch (e: any) {
    console.error('[WexConfigDialog] loadWexConfig error:', e);
    error.value = e.message || '加载配置页面失败';
    loading.value = false;
  }
}

function onIframeLoad() {
  loading.value = false;
  console.log('[WexConfigDialog] iframe loaded');
}

function startPolling() {
  stopPolling();
  poll();
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

async function poll() {
  if (loginDetected.value) {
    return;
  }
  if (pollCount.value >= MAX_POLL_COUNT) {
    console.log(
      '[WexConfigDialog] Polling timeout reached, stopping. User can still close manually.',
    );
    return;
  }

  pollCount.value++;
  console.log(
    `[WexConfigDialog] Poll attempt ${pollCount.value}/${MAX_POLL_COUNT}`,
  );

  try {
    const result = await PanLogin.checkWexConfigLogin(
      props.targetPanType || null,
    );

    if (result.newLogins.length > 0) {
      const newPan = result.newLogins[0];
      const cookieLen = result.cookies[newPan]?.length;
      loginDetected.value = true;
      successMessage.value = `${PanLogin.getDisplayName(newPan)}登录成功`;
      console.log(
        `[WexConfigDialog] New login detected: ${newPan}, cookieLen=${cookieLen}`,
      );
      emit('success', { panType: newPan, cookieLength: cookieLen });
      ElMessage.success(`${PanLogin.getDisplayName(newPan)}登录成功`);
      // Auto-close after short delay so user sees the success state
      setTimeout(() => {
        handleClose();
      }, 1500);
      return;
    }

    // If target pan is already logged in (not new, but exists), also close
    if (props.targetPanType && result.logins[props.targetPanType]) {
      console.log(
        `[WexConfigDialog] Target pan ${props.targetPanType} already logged in`,
      );
      loginDetected.value = true;
      successMessage.value = `${PanLogin.getDisplayName(props.targetPanType)}已登录`;
      emit('success', { panType: props.targetPanType });
      setTimeout(() => {
        handleClose();
      }, 1500);
      return;
    }
  } catch (e: any) {
    console.warn('[WexConfigDialog] poll error:', e.message);
  }

  pollTimer = setTimeout(poll, POLL_INTERVAL);
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.wex-mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.wex-dialog {
  position: relative;
  width: 900px;
  max-width: calc(100vw - 48px);
  height: 680px;
  max-height: calc(100vh - 48px);
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: var(--glass-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--surface-modal-shadow);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.wex-dialog::before {
  content: '';
  position: absolute;
  top: -100px;
  left: 50%;
  transform: translateX(-50%);
  width: 360px;
  height: 300px;
  background: radial-gradient(circle, var(--color-primary-glow) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}

.wex-header {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 24px;
  border-bottom: 1px solid var(--color-border-light);
  flex-shrink: 0;
}

.wex-title-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.wex-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
}

.wex-subtitle {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.wex-close {
  background: transparent;
  border: none;
  color: var(--color-text-tertiary);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast) var(--ease-out-expo);
  display: flex;
  align-items: center;
  justify-content: center;
}

.wex-close:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
}

.wex-body {
  position: relative;
  z-index: 1;
  flex: 1;
  padding: 20px 24px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

.wex-loading,
.wex-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex: 1;
  color: var(--color-text-secondary);
  font-size: 14px;
}

.wex-error .error-text {
  color: var(--color-danger);
  text-align: center;
  line-height: 1.5;
}

.retry-btn {
  margin-top: 8px;
  padding: 8px 24px;
  background: var(--color-primary);
  border: none;
  border-radius: var(--radius-md);
  color: var(--color-bg-base);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-out-expo);
}

.retry-btn:hover {
  background: var(--color-primary-hover);
}

.rotating {
  animation: spin 1.2s linear infinite;
  color: var(--color-primary);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.wex-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

.wex-iframe-wrapper {
  position: relative;
  flex: 1;
  background: #ffffff;
  border-radius: var(--radius-md);
  overflow: hidden;
  box-shadow: var(--surface-floating-shadow);
  min-height: 0;
}

.wex-iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}

.wex-success-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.92);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  z-index: 2;
}

.success-text {
  color: var(--color-success);
  font-size: 18px;
  font-weight: 600;
}

.wex-tips {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.wex-footer {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 24px;
  border-top: 1px solid var(--color-border-light);
  flex-shrink: 0;
}

.wex-poll-status {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.wex-done-btn {
  padding: 8px 24px;
  background: var(--color-primary);
  border: none;
  border-radius: var(--radius-md);
  color: var(--color-bg-base);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-out-expo);
}

.wex-done-btn:hover {
  background: var(--color-primary-hover);
}
</style>
