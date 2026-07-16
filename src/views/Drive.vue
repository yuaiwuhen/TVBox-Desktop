<template>
  <div class="h-full flex flex-col" style="background:var(--color-bg-base)">
    <div class="px-6 pt-4 pb-2 flex items-center justify-between flex-shrink-0" style="background:var(--color-bg-elevated)">
      <h2 class="text-xl font-bold" style="color:var(--color-text-primary)">网盘浏览</h2>
      <el-button type="primary" size="small" @click="showAddDrive = true">添加网盘</el-button>
    </div>

    <!-- Add drive dialog -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="showAddDrive" class="add-drive-overlay" @click.self="showAddDrive = false">
          <div class="add-drive-card">
            <!-- Header -->
            <div class="add-drive-header">
              <h2 class="add-drive-title">添加网盘</h2>
              <button class="add-drive-close" @click="showAddDrive = false" aria-label="关闭">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <!-- Type selector: visual radio cards -->
            <div class="add-drive-type-row">
              <button
                class="add-drive-type-card"
                :class="{ 'is-selected': newDrive.type === 'webdav' }"
                @click="newDrive.type = 'webdav'"
              >
                <div class="add-drive-type-icon">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17.5 19a4.5 4.5 0 1 0 0-9h-1.8A7 7 0 1 0 4 14.9" />
                  </svg>
                </div>
                <span class="add-drive-type-label">WebDAV</span>
              </button>
              <button
                class="add-drive-type-card"
                :class="{ 'is-selected': newDrive.type === 'local' }"
                @click="newDrive.type = 'local'"
              >
                <div class="add-drive-type-icon add-drive-type-icon-local">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <span class="add-drive-type-label">本地文件夹</span>
              </button>
            </div>

            <!-- Divider -->
            <div class="add-drive-divider"></div>

            <!-- Form fields -->
            <div class="add-drive-form">
              <template v-if="newDrive.type === 'webdav'">
                <div class="add-drive-field">
                  <label class="add-drive-label">服务器地址</label>
                  <input
                    v-model="newDrive.url"
                    type="text"
                    class="add-drive-input"
                    placeholder="https://dav.example.com/path"
                  />
                </div>
                <div class="add-drive-field">
                  <label class="add-drive-label">用户名</label>
                  <input
                    v-model="newDrive.username"
                    type="text"
                    class="add-drive-input"
                    placeholder="请输入用户名"
                  />
                </div>
                <div class="add-drive-field">
                  <label class="add-drive-label">密码</label>
                  <input
                    v-model="newDrive.password"
                    type="password"
                    class="add-drive-input"
                    placeholder="请输入密码"
                  />
                </div>
              </template>
              <div v-else class="add-drive-field">
                <label class="add-drive-label">本地路径</label>
                <input
                  v-model="newDrive.path"
                  type="text"
                  class="add-drive-input"
                  placeholder="D:\Videos 或 /home/user/videos"
                />
              </div>
            </div>

            <!-- Action buttons -->
            <div class="add-drive-actions">
              <button class="add-drive-btn add-drive-btn-ghost" @click="showAddDrive = false">取消</button>
              <button class="add-drive-btn add-drive-btn-primary" @click="addDrive">确认添加</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Drive list sidebar + file browser -->
    <div class="flex-1 flex overflow-hidden">
      <!-- Drive list -->
      <div class="w-48 border-r overflow-y-auto flex-shrink-0 drive-sidebar">
        <div
          v-for="(drive, idx) in drives"
          :key="idx"
          class="px-3 py-2.5 cursor-pointer text-sm transition-colors drive-item"
          :class="activeDriveIdx === idx ? 'drive-item-active' : ''"
          @click="selectDrive(idx)"
        >
          <div class="flex items-center justify-between">
            <span class="truncate">{{ drive.name }}</span>
            <el-button size="small" circle type="danger" :icon="Delete" @click.stop="removeDrive(idx)" />
          </div>
        </div>
        <div v-if="drives.length === 0" class="p-3 text-sm text-center" style="color:var(--color-text-tertiary)">
          点击上方按钮添加网盘
        </div>
      </div>

      <!-- File browser -->
      <div class="flex-1 overflow-auto drive-file-area">
        <div v-if="fileLoading" class="flex items-center justify-center h-full">
          <el-icon class="is-loading text-4xl" style="color:var(--color-text-tertiary)"><Loading /></el-icon>
        </div>
        <div v-else-if="files.length === 0" class="flex items-center justify-center h-full" style="color:var(--color-text-tertiary)">
          <p>选择网盘后浏览文件</p>
        </div>
        <div v-else class="p-4">
          <!-- Breadcrumb -->
          <div class="flex items-center gap-1 mb-4 text-sm">
            <el-button size="small" @click="goUp" :disabled="currentPath === '/'">上级目录</el-button>
            <span style="color:var(--color-text-tertiary)">{{ currentPath }}</span>
          </div>
          <div class="space-y-1">
            <div
              v-for="file in files"
              :key="file.name"
              class="flex items-center gap-3 px-3 py-2 rounded cursor-pointer transition-colors drive-file-item"
              @click="onFileClick(file)"
            >
              <el-icon :size="20">
                <Folder v-if="file.type === 'dir'" />
                <VideoPlay v-else />
              </el-icon>
              <span class="flex-1 truncate text-sm" style="color:var(--color-text-primary)">{{ file.name }}</span>
              <span v-if="file.size" class="text-xs" style="color:var(--color-text-tertiary)">{{ formatSize(file.size) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Delete, Folder, VideoPlay, Loading } from '@element-plus/icons-vue'
import { WebDAV } from '../core/WebDAV'
import type { Movie } from '../core/models'
import { useAppStore } from '../store/app'
import { useRouter } from 'vue-router'

const store = useAppStore()
const router = useRouter()

interface DriveConfig {
  name: string
  type: 'webdav' | 'local'
  url?: string
  username?: string
  password?: string
  path?: string
}

interface DriveFile {
  name: string
  type: 'dir' | 'file'
  size?: number
  url?: string
}

const drives = ref<DriveConfig[]>([])
const activeDriveIdx = ref(-1)
const showAddDrive = ref(false)
const fileLoading = ref(false)
const files = ref<DriveFile[]>([])
const currentPath = ref('/')

const newDrive = ref<DriveConfig>({
  name: '',
  type: 'webdav',
  url: '',
  username: '',
  password: '',
  path: '',
})

onMounted(() => {
  try {
    drives.value = JSON.parse(localStorage.getItem('tvbox_drives') || '[]')
  } catch {
    drives.value = []
  }
})

function saveDrives() {
  localStorage.setItem('tvbox_drives', JSON.stringify(drives.value))
}

function addDrive() {
  const drive = { ...newDrive.value }
  if (!drive.name) drive.name = drive.type === 'webdav' ? 'WebDAV' : '本地'
  drives.value.push(drive)
  saveDrives()
  showAddDrive.value = false
  newDrive.value = { name: '', type: 'webdav', url: '', username: '', password: '', path: '' }
}

function removeDrive(idx: number) {
  drives.value.splice(idx, 1)
  saveDrives()
  if (activeDriveIdx.value === idx) {
    activeDriveIdx.value = -1
    files.value = []
  }
}

async function selectDrive(idx: number) {
  activeDriveIdx.value = idx
  currentPath.value = '/'
  await loadFiles()
}

async function loadFiles() {
  const drive = drives.value[activeDriveIdx.value]
  if (!drive) return

  fileLoading.value = true
  files.value = []

  try {
    if (drive.type === 'webdav' && drive.url) {
      const client = new WebDAV({
        url: drive.url,
        username: drive.username,
        password: drive.password,
      })
      // WebDAV PROPFIND to list directory
      const { data } = await (client as any).client.request({
        method: 'PROPFIND',
        url: currentPath.value,
        headers: { Depth: '1' },
      })
      // Parse WebDAV XML response (simplified)
      files.value = parseWebdavResponse(data, drive.url + currentPath.value)
    } else if (drive.type === 'local' && drive.path) {
      // Local file browsing via Electron API if available
      const fs = typeof require !== 'undefined' ? require('fs') : null
      const path = typeof require !== 'undefined' ? require('path') : null
      if (fs && path) {
        const dirPath = path.join(drive.path, currentPath.value === '/' ? '' : currentPath.value)
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        files.value = entries.map((entry: any) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'dir' as const : 'file' as const,
        }))
      }
    }
  } catch (e) {
    console.error('Failed to load files:', e)
    ElMessage.error('加载文件列表失败')
  } finally {
    fileLoading.value = false
  }
}

function parseWebdavResponse(xml: string, baseUrl: string): DriveFile[] {
  const results: DriveFile[] = []
  // Simple regex-based parsing of WebDAV multistatus response
  const hrefRegex = /<d:href>([^<]+)<\/d:href>/gi
  const hrefs: string[] = []
  let match
  while ((match = hrefRegex.exec(xml)) !== null) {
    hrefs.push(decodeURIComponent(match[1]))
  }
  for (const href of hrefs) {
    const name = href.split('/').filter(Boolean).pop() || ''
    if (!name) continue
    const isDir = href.endsWith('/')
    results.push({
      name,
      type: isDir ? 'dir' : 'file',
      url: href.startsWith('http') ? href : baseUrl + href,
    })
  }
  return results
}

async function onFileClick(file: DriveFile) {
  if (file.type === 'dir') {
    currentPath.value = currentPath.value === '/' ? `/${file.name}` : `${currentPath.value}/${file.name}`
    await loadFiles()
  } else {
    // Play the file
    const isVideo = /\.(mp4|mkv|avi|mov|flv|m3u8|ts|wmv|webm)$/i.test(file.name)
    if (isVideo && file.url) {
      store.currentVod = {
        vod_id: file.url,
        vod_name: file.name,
        vod_pic: '',
        sourceKey: 'drive',
      }
      store.currentPlayUrl = file.url
      store.currentPlayFlag = 'drive'
      store.currentPlayHeader = {}
      router.push('/')
    }
  }
}

function goUp() {
  const parts = currentPath.value.split('/').filter(Boolean)
  parts.pop()
  currentPath.value = parts.length > 0 ? '/' + parts.join('/') : '/'
  loadFiles()
}

function formatSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'GB'
}
</script>

<style scoped>
/* Add Drive Dialog */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 250ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.add-drive-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.add-drive-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0;
  max-width: 440px;
  width: calc(100vw - 32px);
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: var(--glass-border);
  border-radius: var(--radius-lg, 14px);
  box-shadow: var(--surface-modal-shadow);
  overflow: hidden;
}

.add-drive-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 24px 20px;
}

.add-drive-title {
  font-size: var(--text-lg, 17px);
  font-weight: 600;
  color: var(--color-text-primary);
  line-height: 1.2;
  margin: 0;
}

.add-drive-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--color-text-tertiary);
  border-radius: var(--radius-sm, 6px);
  transition: color 150ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)),
              background 150ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
}
.add-drive-close:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-elevated);
}

.add-drive-type-row {
  display: flex;
  gap: 12px;
  padding: 0 24px 20px;
}

.add-drive-type-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  flex: 1;
  padding: 16px 0;
  cursor: pointer;
  background: var(--color-bg-elevated);
  border: 2px solid var(--color-border);
  border-radius: var(--radius-md, 10px);
  transition: border-color 150ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
}
.add-drive-type-card.is-selected {
  border-color: var(--color-primary-border);
}
.add-drive-type-card:hover:not(.is-selected) {
  border-color: var(--color-border-active);
}

.add-drive-type-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md, 10px);
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.add-drive-type-card:hover:not(.is-selected) .add-drive-type-icon {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.add-drive-type-icon-local {
  background: color-mix(in srgb, var(--color-text-primary) 5%, transparent);
  color: var(--color-text-tertiary);
}
.add-drive-type-card.is-selected .add-drive-type-icon-local {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.add-drive-type-label {
  font-size: var(--text-sm, 13px);
  font-weight: 500;
  color: var(--color-text-secondary);
}
.add-drive-type-card.is-selected .add-drive-type-label {
  color: var(--color-text-primary);
}

.add-drive-divider {
  height: 1px;
  background: var(--color-border);
  margin: 0 24px;
}

.add-drive-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 24px;
}

.add-drive-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.add-drive-label {
  font-size: var(--text-xs, 11px);
  color: var(--color-text-tertiary);
  font-weight: 500;
}

.add-drive-input {
  height: 36px;
  padding: 0 10px;
  font-size: var(--text-sm, 13px);
  color: var(--color-text-primary);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  caret-color: var(--color-primary);
  outline: none;
  transition: border-color 150ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
}
.add-drive-input::placeholder {
  color: var(--color-text-disabled);
}
.add-drive-input:focus {
  border-color: var(--color-border-active);
}

.add-drive-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 24px 24px;
}

.add-drive-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  flex: 1;
  height: 38px;
  font-size: var(--text-sm, 13px);
  font-weight: 500;
  border-radius: var(--radius-md, 10px);
  cursor: pointer;
  transition: background 150ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)),
              border-color 150ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)),
              color 150ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)),
              transform 150ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
}
.add-drive-btn:active {
  transform: scale(0.97);
}

.add-drive-btn-ghost {
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid var(--color-border);
}
.add-drive-btn-ghost:hover {
  border-color: var(--color-border-active);
  color: var(--color-text-primary);
}

.add-drive-btn-primary {
  font-weight: 600;
  color: var(--color-text-inverse);
  background: var(--color-primary);
  border: none;
}
.add-drive-btn-primary:hover {
  background: var(--color-primary-hover);
}

/* Sidebar */
.drive-sidebar {
  background: var(--color-bg-surface);
  border-color: var(--color-border);
}

.drive-item {
  color: var(--color-text-secondary);
}

.drive-item:hover {
  background: var(--color-bg-elevated);
}

.drive-item-active {
  background: var(--color-primary-soft) !important;
  color: var(--color-primary) !important;
  font-weight: 600;
}

/* File area */
.drive-file-area {
  background: var(--color-bg-elevated);
}

.drive-file-item:hover {
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}
</style>
