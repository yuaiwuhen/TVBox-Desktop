<template>
  <div class="h-full flex flex-col" style="background:var(--color-bg-base)">
    <div class="px-6 pt-4 pb-2 flex items-center justify-between flex-shrink-0" style="background:var(--color-bg-elevated)">
      <h2 class="text-xl font-bold" style="color:var(--color-text-primary)">网盘浏览</h2>
      <el-button type="primary" size="small" @click="showAddDrive = true">添加网盘</el-button>
    </div>

    <!-- Add drive dialog -->
    <el-dialog v-model="showAddDrive" title="添加网盘" width="480px">
      <el-form label-position="top">
        <el-form-item label="类型">
          <el-select v-model="newDrive.type">
            <el-option label="WebDAV" value="webdav" />
            <el-option label="本地文件夹" value="local" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="newDrive.type === 'webdav'" label="WebDAV 地址">
          <el-input v-model="newDrive.url" placeholder="https://dav.example.com/path" />
        </el-form-item>
        <el-form-item v-if="newDrive.type === 'webdav'" label="用户名">
          <el-input v-model="newDrive.username" />
        </el-form-item>
        <el-form-item v-if="newDrive.type === 'webdav'" label="密码">
          <el-input v-model="newDrive.password" type="password" show-password />
        </el-form-item>
        <el-form-item v-if="newDrive.type === 'local'" label="本地路径">
          <el-input v-model="newDrive.path" placeholder="D:\Videos 或 /home/user/videos" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDrive = false">取消</el-button>
        <el-button type="primary" @click="addDrive">添加</el-button>
      </template>
    </el-dialog>

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
  background: var(--color-bg-surface);
}
</style>
