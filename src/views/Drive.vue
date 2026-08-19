<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <!-- Top Bar -->
    <header class="h-[52px] shrink-0 flex items-center justify-between px-5"
      style="background: var(--color-bg-glass); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur); border-bottom: var(--color-border);">
      <div class="flex items-center gap-3">
        <h1 class="text-[15px] font-semibold whitespace-nowrap" style="color: var(--color-text-primary);">网盘浏览</h1>
      </div>
      <div class="flex items-center gap-3">
        <button class="drive-top-btn" @click="loadFiles" :disabled="fileLoading" aria-label="刷新">
          <el-icon :size="15" :class="{ 'is-loading': fileLoading }"><Refresh /></el-icon>
        </button>
        <div class="drive-view-toggle">
          <button class="drive-view-btn" :class="{ active: viewMode === 'list' }" @click="viewMode = 'list'" aria-label="列表视图">
            <el-icon :size="14"><List /></el-icon>
          </button>
          <button class="drive-view-btn" :class="{ active: viewMode === 'grid' }" @click="viewMode = 'grid'" aria-label="网格视图">
            <el-icon :size="14"><Grid /></el-icon>
          </button>
        </div>
      </div>
    </header>

    <!-- Add drive dialog -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="showAddDrive" class="add-drive-overlay" @click.self="showAddDrive = false">
          <div class="add-drive-card">
            <div class="add-drive-header">
              <h2 class="add-drive-title">添加网盘</h2>
              <button class="add-drive-close" @click="showAddDrive = false" aria-label="关闭">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

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

            <div class="add-drive-divider"></div>

            <div class="add-drive-form">
              <div class="add-drive-field">
                <label class="add-drive-label">名称</label>
                <input
                  v-model="newDrive.name"
                  type="text"
                  class="add-drive-input"
                  placeholder="可选，留空自动生成"
                />
              </div>
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

            <div class="add-drive-actions">
              <button class="add-drive-btn add-drive-btn-ghost" @click="showAddDrive = false">取消</button>
              <button class="add-drive-btn add-drive-btn-primary" @click="addDrive">确认添加</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Split Panel Content -->
    <div data-scroll-region="primary" class="flex-1 min-h-0 overflow-hidden flex">
      <!-- LEFT PANEL: Drive list -->
      <div class="w-[220px] shrink-0 h-full flex flex-col overflow-y-auto drive-sidebar">
        <div class="p-3">
          <button class="drive-add-btn" @click="showAddDrive = true">
            <el-icon :size="15" style="color: var(--color-primary);"><Plus /></el-icon>
            <span>添加网盘</span>
          </button>
        </div>

        <nav class="flex-1 px-2.5 pb-3 flex flex-col gap-0.5">
          <div
            v-for="(drive, idx) in drives"
            :key="idx"
            class="drive-item group"
            :class="{ active: activeDriveIdx === idx }"
            @click="selectDrive(idx)"
          >
            <div class="drive-item-icon" :style="getDriveIconStyle(drive)">
              <svg v-if="drive.type === 'webdav'" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 2L4 7l8 5 8-5-8-5z" fill="white" opacity="0.9"/><path d="M4 12l8 5 8-5" stroke="white" stroke-width="1.5" fill="none" opacity="0.7"/><path d="M4 9l8 5 8-5" stroke="white" stroke-width="1.5" fill="none" opacity="0.85"/></svg>
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <span class="drive-item-name flex-1 text-[13px] truncate">{{ drive.name }}</span>
            <button class="drive-delete-btn" @click.stop="removeDrive(idx)" :aria-label="`删除${drive.name}`">
              <el-icon :size="13"><Close /></el-icon>
            </button>
          </div>
          <div v-if="drives.length === 0" class="drive-empty">
            <div class="drive-empty-icon">
              <el-icon :size="22"><FolderOpened /></el-icon>
            </div>
            <p>点击上方按钮<br />添加网盘</p>
          </div>
        </nav>
      </div>

      <!-- RIGHT PANEL: File browser -->
      <div class="flex-1 min-w-0 h-full overflow-y-auto drive-file-area">
        <div class="px-5 pt-4 pb-8">
          <template v-if="fileLoading">
            <div class="flex items-center justify-center h-full py-20">
              <el-icon class="is-loading text-4xl" style="color: var(--color-text-tertiary)"><Loading /></el-icon>
            </div>
          </template>
          <template v-else-if="files.length === 0 && activeDriveIdx >= 0">
            <div class="flex items-center justify-center h-full py-20" style="color: var(--color-text-tertiary)">
              <p>当前目录为空</p>
            </div>
          </template>
          <template v-else-if="activeDriveIdx < 0">
            <div class="flex flex-col items-center justify-center h-full py-20" style="color: var(--color-text-tertiary)">
              <div class="drive-empty-icon drive-empty-icon-lg mb-4">
                <el-icon :size="40"><FolderOpened /></el-icon>
              </div>
              <p class="text-sm mb-1" style="color: var(--color-text-secondary)">还没有选择网盘</p>
              <p class="text-xs mb-8">支持 WebDAV 和本地文件夹，添加后可在线播放视频</p>
              <div class="drive-steps">
                <div class="drive-step">
                  <span class="drive-step-num">1</span>
                  <span class="drive-step-text">点击左侧「添加网盘」</span>
                </div>
                <el-icon :size="14" class="drive-step-arrow"><ArrowRight /></el-icon>
                <div class="drive-step">
                  <span class="drive-step-num">2</span>
                  <span class="drive-step-text">填写 WebDAV 或本地路径</span>
                </div>
                <el-icon :size="14" class="drive-step-arrow"><ArrowRight /></el-icon>
                <div class="drive-step">
                  <span class="drive-step-num">3</span>
                  <span class="drive-step-text">点选网盘浏览视频</span>
                </div>
              </div>
              <button
                class="px-5 h-10 mt-8 text-sm font-medium cursor-pointer border-none transition-all duration-200"
                style="background: var(--color-primary); color: white; border-radius: var(--radius-md, 10px); box-shadow: 0 4px 16px var(--color-primary-soft)"
                @click="showAddDrive = true"
              >添加网盘</button>
            </div>
          </template>
          <template v-else>
            <nav class="flex items-center gap-1.5 mb-4 text-[13px]" style="color: var(--color-text-tertiary);" aria-label="路径导航">
              <button class="drive-crumb-btn" @click="goToPath('/')">根目录</button>
              <template v-for="(crumb, idx) in breadcrumbParts" :key="idx">
                <el-icon :size="14" style="color: var(--color-text-disabled);"><ArrowRight /></el-icon>
                <button
                  v-if="idx < breadcrumbParts.length - 1"
                  class="drive-crumb-btn"
                  @click="goToPath(breadcrumbPaths[idx])"
                >{{ crumb }}</button>
                <span v-else class="truncate" style="color: var(--color-text-secondary);">{{ crumb }}</span>
              </template>
            </nav>

            <div v-if="viewMode === 'list'" class="drive-file-list">
              <div class="drive-file-header">
                <span class="flex-1 min-w-0">名称</span>
                <span class="shrink-0 w-20 text-right">大小</span>
              </div>
              <div class="drive-file-rows">
                <div
                  v-for="file in files"
                  :key="file.name"
                  class="drive-row group"
                  @click="onFileClick(file)"
                >
                  <el-icon :size="18" class="shrink-0" :style="{ color: file.type === 'dir' ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }">
                    <Folder v-if="file.type === 'dir'" />
                    <VideoPlay v-else />
                  </el-icon>
                  <span class="flex-1 min-w-0 text-[13px] truncate drive-file-name">{{ file.name }}</span>
                  <span v-if="file.type === 'dir'" class="shrink-0 text-[12px] tabular-nums whitespace-nowrap" style="color: var(--color-text-tertiary);">—</span>
                  <span v-else class="shrink-0 w-20 text-right text-[12px] tabular-nums whitespace-nowrap" style="color: var(--color-text-tertiary);">{{ formatSize(file.size) }}</span>
                </div>
              </div>
            </div>

            <div v-else class="drive-grid-view">
              <div
                v-for="file in files"
                :key="file.name"
                class="drive-grid-item group"
                @click="onFileClick(file)"
              >
                <div class="drive-grid-icon">
                  <el-icon :size="32" :style="{ color: file.type === 'dir' ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }">
                    <Folder v-if="file.type === 'dir'" />
                    <VideoPlay v-else />
                  </el-icon>
                </div>
                <span class="drive-grid-name text-[13px]">{{ file.name }}</span>
                <span v-if="file.type !== 'dir'" class="drive-grid-size text-[11px]">{{ formatSize(file.size) }}</span>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Delete, Folder, FolderOpened, VideoPlay, Loading, Plus, Close, Refresh, List, Grid, ArrowRight } from '@element-plus/icons-vue'
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
const viewMode = ref<'list' | 'grid'>('list')

const newDrive = ref<DriveConfig>({
  name: '',
  type: 'webdav',
  url: '',
  username: '',
  password: '',
  path: '',
})

const breadcrumbParts = computed(() => {
  if (currentPath.value === '/') return []
  return currentPath.value.split('/').filter(Boolean)
})

const breadcrumbPaths = computed(() => {
  const parts: string[] = []
  let path = ''
  for (const part of breadcrumbParts.value) {
    path += '/' + part
    parts.push(path)
  }
  return parts
})

const driveGradients = [
  'linear-gradient(135deg, #ff6a00 0%, #ee0979 100%)',
  'linear-gradient(135deg, #00b4d8 0%, #0077b6 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #4e7cff 0%, #2352de 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
]

function getDriveIconStyle(drive: DriveConfig) {
  const idx = drives.value.indexOf(drive)
  const gradient = driveGradients[idx % driveGradients.length]
  return {
    background: gradient,
    borderRadius: 'var(--radius-sm, 6px)',
  }
}

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
      const { data } = await (client as any).client.request({
        method: 'PROPFIND',
        url: currentPath.value,
        headers: { Depth: '1' },
      })
      files.value = parseWebdavResponse(data, drive.url + currentPath.value)
    } else if (drive.type === 'local' && drive.path) {
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

function goToPath(path: string) {
  currentPath.value = path
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
/* Top Bar Buttons */
.drive-top-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  color: var(--color-text-tertiary);
  border-radius: var(--radius-sm, 6px);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color 150ms var(--ease-out-expo), background 150ms var(--ease-out-expo);
}
.drive-top-btn:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-elevated);
}
.drive-top-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.drive-view-toggle {
  display: flex;
  align-items: center;
  padding: 2px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-sm, 6px);
  border: var(--color-border-light);
}
.drive-view-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--color-text-tertiary);
  border-radius: 4px;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: background 150ms var(--ease-out-expo), color 150ms var(--ease-out-expo);
}
.drive-view-btn:hover {
  color: var(--color-text-secondary);
}
.drive-view-btn.active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

/* Sidebar */
.drive-sidebar {
  background: var(--color-bg-surface);
  border-right: 1px solid var(--color-border-light);
}

.drive-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: var(--glass-border);
  border-radius: var(--radius-md, 10px);
  box-shadow: var(--glass-highlight);
  cursor: pointer;
  transition: background 150ms var(--ease-out-expo);
}
.drive-add-btn:hover {
  background: var(--color-bg-elevated);
}

.drive-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  cursor: pointer;
  color: var(--color-text-secondary);
  border-left: 3px solid transparent;
  border-radius: 0 6px 6px 0;
  transition: background 150ms var(--ease-out-expo), color 150ms var(--ease-out-expo);
}
.drive-item:hover {
  background: color-mix(in srgb, var(--color-text-primary) 4%, transparent);
}
.drive-item.active {
  color: var(--color-text-primary);
  background: var(--color-primary-soft);
  border-left-color: var(--color-primary);
}
.drive-item.active .drive-item-name {
  font-weight: 500;
}

.drive-item-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.drive-item-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drive-delete-btn {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  color: var(--color-text-tertiary);
  border-radius: 4px;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: opacity 150ms var(--ease-out-expo), color 150ms var(--ease-out-expo), background 150ms var(--ease-out-expo);
}
.drive-item:hover .drive-delete-btn {
  opacity: 1;
}
.drive-delete-btn:hover {
  color: var(--color-text-primary) !important;
  background: var(--color-bg-overlay);
}

.drive-empty {
  padding: 24px 12px;
  font-size: 13px;
  text-align: center;
  color: var(--color-text-tertiary);
  line-height: 1.6;
}

.drive-empty-icon {
  width: 44px;
  height: 44px;
  margin: 0 auto 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md, 10px);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  color: var(--color-text-tertiary);
}

.drive-empty-icon-lg {
  width: 84px;
  height: 84px;
  border-radius: var(--radius-lg, 14px);
}

/* Onboarding steps */
.drive-steps {
  display: flex;
  align-items: center;
  gap: 16px;
}

.drive-step {
  display: flex;
  align-items: center;
  gap: 8px;
}

.drive-step-num {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-primary);
  background: var(--color-primary-soft);
  border-radius: 50%;
}

.drive-step-text {
  font-size: 13px;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.drive-step-arrow {
  color: var(--color-text-disabled);
}

@media (max-width: 640px) {
  .drive-steps {
    flex-direction: column;
    gap: 8px;
  }
  .drive-step-arrow {
    transform: rotate(90deg);
  }
}

/* File Area */
.drive-file-area {
  background: var(--color-bg-base);
}

.drive-crumb-btn {
  color: var(--color-primary);
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 13px;
  padding: 0;
  transition: opacity 150ms var(--ease-out-expo);
}
.drive-crumb-btn:hover {
  opacity: 0.8;
}

/* List View */
.drive-file-list {
  display: flex;
  flex-direction: column;
}

.drive-file-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 12px;
  margin-bottom: 4px;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-disabled);
}

.drive-file-rows {
  display: flex;
  flex-direction: column;
}

.drive-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--color-border-light);
  transition: background 150ms var(--ease-out-expo);
}
.drive-row:hover {
  background: var(--color-bg-glass-light);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.drive-row:hover .drive-file-name {
  color: var(--color-primary);
}

.drive-file-name {
  color: var(--color-text-primary);
  transition: color 150ms var(--ease-out-expo);
}

/* Grid View */
.drive-grid-view {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px;
}

.drive-grid-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 12px;
  cursor: pointer;
  border-radius: var(--radius-md, 10px);
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-light);
  transition: background 150ms var(--ease-out-expo), border-color 150ms var(--ease-out-expo), transform 150ms var(--ease-out-expo);
}
.drive-grid-item:hover {
  background: var(--color-bg-elevated);
  border-color: var(--color-primary-border);
  transform: translateY(-2px);
}

.drive-grid-icon {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md, 10px);
  background: var(--color-bg-elevated);
}

.drive-grid-name {
  color: var(--color-text-primary);
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-all;
  line-height: 1.4;
}

.drive-grid-size {
  color: var(--color-text-tertiary);
  font-size: 11px;
}

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
  font-size: 17px;
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
  transition: color 150ms var(--ease-out-expo),
              background 150ms var(--ease-out-expo);
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
  transition: border-color 150ms var(--ease-out-expo);
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
  font-size: 13px;
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
  font-size: 11px;
  color: var(--color-text-tertiary);
  font-weight: 500;
}

.add-drive-input {
  height: 36px;
  padding: 0 10px;
  font-size: 13px;
  color: var(--color-text-primary);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  caret-color: var(--color-primary);
  outline: none;
  transition: border-color 150ms var(--ease-out-expo);
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
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--radius-md, 10px);
  cursor: pointer;
  transition: background 150ms var(--ease-out-expo),
              border-color 150ms var(--ease-out-expo),
              color 150ms var(--ease-out-expo),
              transform 150ms var(--ease-out-expo);
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

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  .drive-row,
  .drive-row:hover,
  .drive-grid-item,
  .drive-grid-item:hover,
  .drive-item,
  .drive-item:hover,
  .drive-delete-btn,
  .drive-top-btn,
  .drive-view-btn,
  .drive-add-btn,
  .drive-crumb-btn {
    transition-duration: 0.01ms !important;
  }
}
</style>
