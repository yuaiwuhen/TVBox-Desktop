<template>
  <div class="mumu-guide-overlay">
    <div class="mumu-guide">
      <div class="mumu-guide-header">
        <h3>MuMu 模拟器设置</h3>
        <button class="mumu-guide-close" @click="$emit('close')">×</button>
      </div>

      <div class="mumu-guide-body">
        <!-- Not installed -->
        <div v-if="!status.installed" class="step">
          <h4>1. 安装 MuMu 模拟器（仅 Windows）</h4>
          <p>
            Spider 服务需要在 Android 模拟器中运行。请从官网下载并安装
            <b>MuMu 模拟器 15</b>（MuMuPlayer），安装后重启本应用。
          </p>
          <p class="hint">
            已安装但检测不到？请确认安装路径为默认目录
            <code>D:\Program Files\Netease\MuMu</code> 或
            <code>C:\Program Files\Netease\MuMu</code>。
          </p>
        </div>

        <!-- Installed but not running -->
        <div v-else-if="!status.booted" class="step">
          <h4>2. 启动 MuMu 模拟器</h4>
          <p>MuMu 已安装，但模拟器尚未启动。</p>
          <button class="btn" :disabled="starting" @click="startMuMu">
            {{ starting ? '正在启动...' : '一键启动 MuMu' }}
          </button>
        </div>

        <!-- Running but service not ready -->
        <div v-else-if="!status.serviceReady" class="step">
          <h4>3. 部署 Spider 服务</h4>
          <p>模拟器已运行，正在安装并启动 Spider 服务…</p>
          <button class="btn" :disabled="starting" @click="installApp">
            {{ starting ? '正在部署...' : '部署 Spider 服务' }}
          </button>
        </div>

        <!-- Ready -->
        <div v-else class="step success">
          <h4>✅ Spider 服务已就绪</h4>
          <p>MuMu 模拟器运行正常，Spider 服务已启动。</p>
        </div>

        <p v-if="status.message" class="status-message">
          {{ status.message }}
        </p>
        <p v-if="status.error" class="status-error">{{ status.error }}</p>

        <div v-if="status.instances && status.instances.length" class="instances">
          <p class="instances-title">检测到的 MuMu 实例：</p>
          <div
            v-for="inst in status.instances"
            :key="inst.index"
            class="instance-row"
          >
            <span>{{ inst.name }}</span>
            <span class="instance-state">
              {{ inst.isAndroidStarted ? '运行中' : '未启动' }}
            </span>
          </div>
        </div>
      </div>

      <div class="mumu-guide-footer">
        <button class="btn-ghost" @click="$emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'

defineEmits<{ (e: 'close'): void }>()

interface MuMuStatus {
  installed: boolean
  running: boolean
  booted: boolean
  serviceReady: boolean
  targetIndex: number
  instances: Array<{ index: number; name: string; isAndroidStarted: boolean }>
  message: string
  error?: string
}

const status = ref<MuMuStatus>({
  installed: false,
  running: false,
  booted: false,
  serviceReady: false,
  targetIndex: 0,
  instances: [],
  message: '',
})
const starting = ref(false)

const ipc = () => {
  const win = window as any
  if (win.electronIPC) return win.electronIPC
  try {
    const { ipcRenderer } = window.require('electron')
    return {
      invoke: (channel: string, ...args: any[]) =>
        ipcRenderer.invoke(channel, ...args),
      on: (channel: string, listener: (...args: any[]) => void) => {
        const wrapped = (_e: any, ...args: any[]) => listener(...args)
        ipcRenderer.on(channel, wrapped)
        return () => ipcRenderer.removeListener(channel, wrapped)
      },
    }
  } catch {
    return null
  }
}

let removeStatusListener: (() => void) | null = null

async function refresh() {
  const api = ipc()
  if (!api) return
  const st = await api.invoke('mumu:getStatus')
  if (st) status.value = st
}

async function startMuMu() {
  const api = ipc()
  if (!api) return
  starting.value = true
  try {
    const st = await api.invoke('mumu:start')
    if (st) status.value = st
    if (st?.serviceReady) ElMessage.success('Spider 服务已就绪')
    else if (st?.error) ElMessage.warning(st.message || '启动失败')
  } finally {
    starting.value = false
  }
}

async function installApp() {
  const api = ipc()
  if (!api) return
  starting.value = true
  try {
    const st = await api.invoke('mumu:installApp')
    if (st) status.value = st
    if (st?.serviceReady) ElMessage.success('Spider 服务已就绪')
    else if (st?.error) ElMessage.warning(st.message || '部署失败')
  } finally {
    starting.value = false
  }
}

onMounted(async () => {
  const api = ipc()
  if (api && api.on) {
    removeStatusListener = api.on('mumu:status', (data: any) => {
      if (data) status.value = data
    })
  }
  await refresh()
})

onBeforeUnmount(() => {
  removeStatusListener?.()
})
</script>

<style scoped>
.mumu-guide-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
}
.mumu-guide {
  width: 520px;
  max-width: 90vw;
  background: var(--bg-card, #1e2233);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  overflow: hidden;
}
.mumu-guide-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.mumu-guide-header h3 {
  margin: 0;
  font-size: 16px;
}
.mumu-guide-close {
  background: none;
  border: none;
  color: inherit;
  font-size: 20px;
  cursor: pointer;
  opacity: 0.7;
}
.mumu-guide-close:hover {
  opacity: 1;
}
.mumu-guide-body {
  padding: 20px;
  max-height: 60vh;
  overflow-y: auto;
}
.step h4 {
  margin: 0 0 8px;
  font-size: 14px;
}
.step p {
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.6;
  opacity: 0.85;
}
.step.success h4 {
  color: #67c23a;
}
.hint {
  font-size: 12px !important;
  opacity: 0.6 !important;
}
.hint code {
  background: rgba(255, 255, 255, 0.08);
  padding: 2px 6px;
  border-radius: 4px;
}
.btn {
  margin-top: 12px;
  padding: 8px 20px;
  border: none;
  border-radius: 6px;
  background: #409eff;
  color: #fff;
  cursor: pointer;
  font-size: 13px;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.btn-ghost {
  padding: 6px 16px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  background: none;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
}
.status-message {
  margin-top: 12px;
  font-size: 12px;
  opacity: 0.7;
}
.status-error {
  margin-top: 8px;
  font-size: 12px;
  color: #f56c6c;
}
.instances {
  margin-top: 16px;
}
.instances-title {
  font-size: 12px;
  opacity: 0.6;
  margin-bottom: 6px;
}
.instance-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  margin-bottom: 4px;
  font-size: 13px;
}
.instance-state {
  opacity: 0.7;
  font-size: 12px;
}
.mumu-guide-footer {
  display: flex;
  justify-content: flex-end;
  padding: 12px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
</style>