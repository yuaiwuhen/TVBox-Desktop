<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="visible" class="qr-mask" @click.self="handleClose">
        <div class="qr-dialog">
          <div class="qr-header">
            <span class="qr-title">{{ dialogTitle }}</span>
            <button class="qr-close" @click="handleClose">
              <el-icon :size="18">
                <Close />
              </el-icon>
            </button>
          </div>
          <div class="qr-body">
            <div v-if="loading" class="qr-loading">
              <el-icon :size="32" class="rotating">
                <Loading />
              </el-icon>
              <span>正在生成二维码...</span>
            </div>
            <div v-else-if="error" class="qr-error">
              <el-icon :size="32" color="#f56c6c">
                <Warning />
              </el-icon>
              <span class="error-text">{{ error }}</span>
              <button class="retry-btn" @click="generateQR">
                重试
              </button>
            </div>
            <div v-else class="qr-content">
              <div class="qr-image-wrapper">
                <img v-if="qrCodeUrl" :src="qrCodeUrl" alt="二维码" class="qr-image" />
                <div v-if="status === 'confirmed'" class="qr-mask-success">
                  <el-icon :size="48" color="#67c23a">
                    <CircleCheck />
                  </el-icon>
                  <span>登录成功</span>
                </div>
              </div>
              <div class="qr-tips">
                <template v-if="status === 'waiting'">
                  <el-icon :size="16">
                    <InfoFilled />
                  </el-icon>
                  <span>请使用{{ panDisplayName }}APP扫码登录</span>
                </template>
                <template v-else-if="status === 'scanned'">
                  <el-icon :size="16" color="#e6a23c">
                    <WarningFilled />
                  </el-icon>
                  <span style="color: #e6a23c">已扫码，请在手机上确认</span>
                </template>
                <template v-else-if="status === 'confirmed'">
                  <el-icon :size="16" color="#67c23a">
                    <CircleCheckFilled />
                  </el-icon>
                  <span style="color: #67c23a">登录成功，正在跳转...</span>
                </template>
                <template v-else-if="status === 'expired'">
                  <el-icon :size="16" color="#f56c6c">
                    <CircleCloseFilled />
                  </el-icon>
                  <span style="color: #f56c6c">二维码已过期，请刷新重试</span>
                </template>
              </div>
            </div>
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
  WarningFilled,
  CircleCheck,
  CircleCheckFilled,
  CircleCloseFilled,
} from '@element-plus/icons-vue';
import { PanLogin, type PanType } from '../core/PanLogin';

const props = defineProps<{
  visible: boolean;
  panType: PanType;
  title?: string;
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'success', info: { panType: PanType; nickname?: string; userId?: string }): void;
  (e: 'close'): void;
}>();

const loading = ref(false);
const error = ref('');
const qrCodeUrl = ref('');
const qrToken = ref('');
const extra = ref<Record<string, string> | undefined>(undefined);
const status = ref<'waiting' | 'scanned' | 'confirmed' | 'expired'>('waiting');

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollCount = 0;
const MAX_POLL_COUNT = 120;
const POLL_INTERVAL = 2000;

const panDisplayName = computed(() => PanLogin.getDisplayName(props.panType));
const dialogTitle = computed(() => props.title || `${panDisplayName.value}扫码登录`);

watch(
  () => props.visible,
  (val) => {
    if (val) {
      generateQR();
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
  qrCodeUrl.value = '';
  qrToken.value = '';
  extra.value = undefined;
  status.value = 'waiting';
  pollCount = 0;
}

function handleClose() {
  emit('update:visible', false);
  emit('close');
}

async function generateQR() {
  loading.value = true;
  error.value = '';
  status.value = 'waiting';
  pollCount = 0;
  qrCodeUrl.value = '';
  qrToken.value = '';
  extra.value = undefined;

  try {
    const result = await PanLogin.generateQRCode(props.panType);
    qrCodeUrl.value = result.qrCodeUrl;
    qrToken.value = result.qrToken;
    extra.value = result.extra;
    loading.value = false;
    console.log(`[QRLogin:${props.panType}] QR code displayed, starting polling loop (2s interval, max 120 attempts)`);
    startPolling();
  } catch (e: any) {
    console.error(`[QRLogin:${props.panType}] generateQR error:`, e);
    error.value = e.message || '生成二维码失败';
    loading.value = false;
  }
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
  if (!qrToken.value || status.value === 'confirmed' || status.value === 'expired') {
    console.log(`[QRLogin:${props.panType}] poll() skip: qrToken=${!!qrToken.value}, status=${status.value}`);
    return;
  }
  if (pollCount >= MAX_POLL_COUNT) {
    status.value = 'expired';
    error.value = '二维码已过期，请刷新重试';
    return;
  }

  pollCount++;
  console.log(`[QRLogin:${props.panType}] Poll attempt ${pollCount}/${MAX_POLL_COUNT}, token=${qrToken}`);

  try {
    console.log(`[QRLogin:${props.panType}] Poll request params:`, {
      panType: props.panType,
      qrToken: qrToken.value,
      qrTokenLen: qrToken.value.length,
      extra: extra.value,
    });
    const result = await PanLogin.pollQRCode(
      props.panType,
      qrToken.value,
      extra.value,
    );

    console.log(`[QRLogin:${props.panType}] Poll result #${pollCount}:`, {
      success: result.success,
      status: result.status,
      hasLoginInfo: !!result.loginInfo,
      error: result.error,
      rawData: result.rawData,
    });

    if (result.status === 'error') {
      console.warn(`[QRLogin:${props.panType}] Poll error:`, result.error);
      // If we already scanned, an error means the login flow is broken
      // (e.g. token consumed but cookie extraction failed). Stop polling
      // and surface the error so the user knows to retry.
      if (status.value === 'scanned') {
        error.value = result.error || '登录失败，请重试';
        status.value = 'expired';
        return;
      }
      // Before scan, transient errors (network blip) — keep polling
    } else {
      status.value = result.status;
    }

    if (result.status === 'confirmed') {
      // Always close the loop on confirmed — even if loginInfo is missing
      // (shouldn't happen, but prevents永久卡住 in 'success' state)
      if (result.loginInfo) {
        console.log(`[QRLogin:${props.panType}] Login confirmed:`, {
          nickname: result.loginInfo.nickname,
          userId: result.loginInfo.userId,
        });
        emit('success', {
          panType: props.panType,
          nickname: result.loginInfo.nickname,
          userId: result.loginInfo.userId,
        });
      } else {
        console.error(
          `[QRLogin:${props.panType}] Confirmed without loginInfo, closing anyway`,
        );
        emit('success', { panType: props.panType });
      }
      setTimeout(() => {
        handleClose();
      }, 1500);
      return;
    }

    if (result.status === 'expired') {
      return;
    }
  } catch (e: any) {
    console.warn(`[QRLogin:${props.panType}] Poll exception:`, e.message);
  }

  console.log(`[QRLogin:${props.panType}] Next poll in ${POLL_INTERVAL}ms`);
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

.qr-mask {
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

.qr-dialog {
  position: relative;
  width: 380px;
  max-width: calc(100vw - 32px);
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: var(--glass-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--surface-modal-shadow);
  overflow: hidden;
}

/* Subtle amber glow behind dialog */
.qr-dialog::before {
  content: '';
  position: absolute;
  top: -100px;
  left: 50%;
  transform: translateX(-50%);
  width: 300px;
  height: 300px;
  background: radial-gradient(circle, var(--color-primary-glow) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}

.qr-header {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 24px;
  border-bottom: 1px solid var(--color-border-light);
}

.qr-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
}

.qr-close {
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

.qr-close:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
}

.qr-body {
  position: relative;
  z-index: 1;
  padding: 28px 24px 32px;
}

.qr-loading,
.qr-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 280px;
  color: var(--color-text-secondary);
  font-size: 14px;
}

.qr-error .error-text {
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

.qr-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
}

.qr-image-wrapper {
  position: relative;
  width: 200px;
  height: 200px;
  background: #ffffff;
  border-radius: var(--radius-md);
  padding: 10px;
  box-shadow: var(--surface-floating-shadow);
}

.qr-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.qr-mask-success {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.95);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--color-success);
  font-size: 16px;
  font-weight: 600;
}

.qr-tips {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-secondary);
}
</style>
