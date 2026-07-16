<template>
  <div class="h-full overflow-y-auto" style="background:var(--color-bg-base)">
    <div class="max-w-3xl mx-auto px-5 pt-6 pb-10 flex flex-col gap-5">

      <el-form label-position="top">

        <!-- Section 1: 配置源 -->
        <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><Link /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">配置源</h2>
        </div>
        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">配置地址</span>
          <div class="flex w-full gap-2">
            <el-input
              v-model="inputUrl"
              placeholder="请输入 http:// 或 https:// 开头的配置链接"
              clearable
            >
              <template #prefix>
                <el-icon><Link /></el-icon>
              </template>
            </el-input>
            <el-button type="primary" :loading="configLoading" @click="loadConfig">
              加载
            </el-button>
          </div>
        </div>

        <div v-if="store.sites.length > 0" class="mb-4">
          <p class="text-sm mb-2" style="color:var(--color-text-secondary)">已加载源 (点击切换当前源)：</p>
          <div class="flex flex-wrap gap-2">
            <el-tag
              v-for="site in store.sites"
              :key="site.key"
              :type="site.key === store.activeSiteKey ? 'primary' : 'info'"
              :effect="site.key === store.activeSiteKey ? 'dark' : 'plain'"
              class="cursor-pointer"
              @click="store.setActiveSite(site.key)"
            >
              {{ site.name }}
            </el-tag>
          </div>
        </div>

        </section>

        <!-- Section 2: 解析设置 -->
        <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><MagicStick /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">解析设置</h2>
        </div>
        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">默认解析</span>
          <el-select v-model="parseName" placeholder="选择默认解析" @change="onParseChange">
            <el-option
              v-for="p in store.parses"
              :key="p.name"
              :label="p.name"
              :value="p.name"
            />
          </el-select>
        </div>

        <div v-if="store.parses.length > 0" class="mb-4">
          <p class="text-sm" style="color:var(--color-text-tertiary)">已加载 {{ store.parses.length }} 个解析器</p>
        </div>

        </section>

        <!-- Section 3: 播放设置 -->
        <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><VideoPlay /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">播放设置</h2>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-[13px]" style="color:var(--color-text-primary)">自动播放下一集</span>
          <el-switch v-model="autoPlayNext" @change="onAutoPlayNextChange" />
        </div>

        <div class="flex items-center justify-between">
          <span class="text-[13px]" style="color:var(--color-text-primary)">屏显信息</span>
          <el-switch v-model="screenDisplayValue" @change="onScreenDisplayChange" />
        </div>

        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">外部播放器路径</span>
          <div class="flex gap-2 items-center">
            <el-input
              v-model="vlcPathValue"
              placeholder="如: C:\Program Files\VideoLAN\VLC\vlc.exe"
              clearable
              @change="onVlcPathChange"
              class="flex-1"
            />
            <el-button @click="selectVlcPath" size="small">浏览</el-button>
          </div>
          <div class="text-xs mt-1" style="color:var(--color-text-tertiary)">
            用于播放不支持网页格式的视频（如MKV）
          </div>
        </div>

        </section>

        <!-- Section: 字幕设置 -->
        <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><ChatLineSquare /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">字幕设置</h2>
        </div>
        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">字幕字号</span>
          <el-slider v-model="subtitleSizeValue" :min="12" :max="48" :step="2" show-input @change="onSubtitleSizeChange" />
        </div>
        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">字幕颜色</span>
          <el-color-picker v-model="subtitleColorValue" @change="onSubtitleColorChange" />
        </div>
        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">字幕延迟 (秒)</span>
          <el-slider v-model="subtitleDelayValue" :min="-5" :max="5" :step="0.1" show-input @change="onSubtitleDelayChange" />
        </div>

        </section>

        <!-- Section: 弹幕设置 -->
        <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><ChatDotRound /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">弹幕设置</h2>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-[13px]" style="color:var(--color-text-primary)">弹幕默认开启</span>
          <el-switch v-model="danmuEnabledValue" @change="onDanmuEnabledChange" />
        </div>
        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">弹幕同屏数量</span>
          <el-slider v-model="danmuMaxValue" :min="5" :max="50" :step="5" show-input @change="onDanmuMaxChange" />
        </div>

        </section>

        <!-- Section 4: 直播设置 -->
        <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><Monitor /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">直播设置</h2>
        </div>
        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">直播地址</span>
          <el-input v-model="liveUrlInput" placeholder="直播源地址" clearable @change="onLiveUrlChange" />
        </div>
        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">EPG 地址</span>
          <el-input v-model="epgUrlInput" placeholder="EPG 节目单地址" clearable @change="onEpgUrlChange" />
        </div>

        </section>

        <!-- Section 5: 搜索设置 -->
        <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><Search /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">搜索设置</h2>
        </div>
        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">搜索视图模式</span>
          <el-radio-group v-model="searchViewModeValue" @change="onSearchViewModeChange">
            <el-radio-button :value="0">列表</el-radio-button>
            <el-radio-button :value="1">缩略图</el-radio-button>
          </el-radio-group>
        </div>

        </section>

        <!-- Section 6: 网络设置 -->
        <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><Connection /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">网络设置</h2>
        </div>
        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">DoH (DNS over HTTPS)</span>
          <el-select v-model="dohValue" @change="onDohChange">
            <el-option v-for="item in dohOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </div>

        </section>

        <!-- Section 7: 数据管理 -->
        <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><Coin /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">数据管理</h2>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-[13px]" style="color:var(--color-text-primary)">历史记录</span>
          <el-button type="danger" @click="clearHistory">清除历史记录</el-button>
        </div>
        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">配置地址历史</span>
          <el-select v-model="inputUrl" placeholder="选择历史配置地址" @change="onHistoryUrlSelect" filterable allow-create>
            <el-option v-for="url in configUrlHistory" :key="url" :label="url" :value="url" />
          </el-select>
        </div>

        </section>

        <!-- Section: 主题设置 -->
        <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><Brush /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">主题设置</h2>
        </div>

        <div class="mb-5">
          <span class="block text-[13px] mb-3" style="color:var(--color-text-primary)">主题模式</span>
          <div class="grid grid-cols-2 gap-3">
            <div
              class="theme-mode-card"
              :class="{ active: theme.mode === 'dark' }"
              @click="theme.setMode('dark')"
            >
              <el-icon><Moon /></el-icon>
              <span>深色</span>
            </div>
            <div
              class="theme-mode-card"
              :class="{ active: theme.mode === 'light' }"
              @click="theme.setMode('light')"
            >
              <el-icon><Sunny /></el-icon>
              <span>浅色</span>
            </div>
            <div
              class="theme-mode-card"
              :class="{ active: theme.mode === 'system' }"
              @click="theme.setMode('system')"
            >
              <el-icon><Monitor /></el-icon>
              <span>跟随系统</span>
            </div>
            <div
              class="theme-mode-card"
              :class="{ active: theme.mode === 'custom' }"
              @click="theme.setMode('custom')"
            >
              <el-icon><Brush /></el-icon>
              <span>自定义</span>
            </div>
          </div>
        </div>

        <div v-if="theme.mode === 'custom'" class="custom-theme-section">
          <div class="mb-5">
            <span class="block text-[13px] mb-3" style="color:var(--color-text-primary)">主题色</span>
            <div class="flex gap-3 items-center flex-wrap">
              <el-color-picker v-model="localPrimaryColor" @change="onPrimaryColorChange" />
              <el-input
                v-model="localPrimaryColorHex"
                class="hex-input"
                placeholder="#RRGGBB"
                @input="onPrimaryColorHexInput"
                @change="onPrimaryColorHexChange"
              />
              <div class="flex gap-1.5 flex-wrap">
                <button
                  v-for="c in presetColors"
                  :key="c"
                  class="preset-swatch"
                  :style="{ background: c }"
                  :class="{ active: localPrimaryColor === c }"
                  @click="onPrimaryColorChange(c)"
                />
              </div>
            </div>
          </div>

          <div class="mb-5">
            <span class="block text-[13px] mb-3" style="color:var(--color-text-primary)">背景选择</span>
            <el-radio-group v-model="bgTab" size="default" @change="onBgTabChange">
              <el-radio-button value="color">背景色</el-radio-button>
              <el-radio-button value="image">背景图</el-radio-button>
            </el-radio-group>

            <div v-if="bgTab === 'color'" class="mt-3">
              <div class="flex gap-3 items-center">
                <el-color-picker v-model="localBgColor" @change="onBgColorChange" />
                <el-input
                  v-model="localBgColorHex"
                  class="hex-input"
                  placeholder="#RRGGBB"
                  @input="onBgColorHexInput"
                  @change="onBgColorHexChange"
                />
              </div>
            </div>

            <div v-else class="mt-3">
              <div class="flex w-full gap-2">
                <el-input
                  v-model="localBgImage"
                  placeholder="输入图片URL或上传本地图片"
                  clearable
                  @change="onBgImageChange"
                >
                  <template #prefix>
                    <el-icon><Picture /></el-icon>
                  </template>
                </el-input>
                <el-button @click="selectBgImage" size="small">浏览</el-button>
                <el-button v-if="localBgImage" @click="clearBgImage" size="small" type="danger" plain>
                  清除
                </el-button>
              </div>

              <div v-if="localBgImage" class="mt-3">
                <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">背景透明度</span>
                <el-slider
                  v-model="localBgOpacity"
                  :min="0.02"
                  :max="0.5"
                  :step="0.01"
                  show-input
                  @change="onBgOpacityChange"
                />
              </div>
            </div>
          </div>

          <div v-if="bgTab === 'color'">
            <span class="block text-[13px] mb-3" style="color:var(--color-text-primary)">基础模式</span>
            <el-radio-group v-model="localCustomBase" size="default" @change="onCustomBaseChange">
              <el-radio-button value="dark">深色</el-radio-button>
              <el-radio-button value="light">浅色</el-radio-button>
            </el-radio-group>
            <div class="text-xs mt-2" style="color:var(--color-text-tertiary)">
              选择文字和元素的对比模式，根据背景色深浅调整
            </div>
          </div>
        </div>

        </section>

        <!-- Section: WebDAV 备份 -->
        <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><Upload /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">WebDAV 备份</h2>
        </div>
        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">WebDAV 地址</span>
          <el-input v-model="webdavUrl" placeholder="https://dav.example.com/path" clearable />
        </div>
        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">用户名</span>
          <el-input v-model="webdavUser" placeholder="WebDAV 用户名" clearable />
        </div>
        <div>
          <span class="block text-[13px] mb-2" style="color:var(--color-text-primary)">密码</span>
          <el-input v-model="webdavPass" type="password" placeholder="WebDAV 密码" show-password />
        </div>
        <div class="flex gap-2">
          <el-button @click="webdavBackup" :loading="webdavLoading">备份到 WebDAV</el-button>
          <el-button @click="webdavRestore" :loading="webdavLoading">从 WebDAV 恢复</el-button>
          <el-button @click="webdavTest" :loading="webdavLoading">测试连接</el-button>
        </div>

        </section>

        <!-- Section 8: 关于 -->
        <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><InfoFilled /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">关于</h2>
        </div>
        <div class="text-sm space-y-1" style="color:var(--color-text-secondary)">
          <p>版本：1.0.0</p>
          <p>项目地址：<el-link type="primary" href="https://github.com/CatVodTVOfficial/TVBoxOSC" target="_blank">TVBoxOSC</el-link></p>
          <p>远程控制端口：<el-tag size="small">{{ remotePort }}</el-tag></p>
          <p>本地代理端口：<el-tag size="small">{{ proxyPort }}</el-tag></p>
        </div>
        </section>

      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '../store/app'
import { useThemeStore } from '../stores/theme'
import { WebDAV } from '../core/WebDAV'
import { remoteServer } from '../core/RemoteServer'
import { localProxy } from '../core/LocalProxyServer'
import { saveToFile } from '../core/ConfigSync'

const store = useAppStore()
const theme = useThemeStore()

const inputUrl = ref('')
const configLoading = ref(false)
const parseName = ref('')
const autoPlayNext = ref(true)
const vlcPathValue = ref(localStorage.getItem('tvbox_vlc_path') || '')
const screenDisplayValue = ref(true)
const liveUrlInput = ref('')
const epgUrlInput = ref('')
const searchViewModeValue = ref(1)
const dohValue = ref(0)
const subtitleSizeValue = ref(24)
const subtitleColorValue = ref('#ffffff')
const subtitleDelayValue = ref(0)
const danmuEnabledValue = ref(false)
const danmuMaxValue = ref(30)

const configUrlHistory = ref<string[]>([])

// Theme settings
const localPrimaryColor = ref(theme.primaryColor)
const localPrimaryColorHex = ref(theme.primaryColor)
const localBgColor = ref(theme.bgColor || '')
const localBgColorHex = ref(theme.bgColor || '')
const localBgImage = ref(theme.bgImage || '')
const localBgOpacity = ref(theme.bgOpacity)
const localCustomBase = ref(theme.customBase)
const bgTab = ref<'color' | 'image'>(theme.bgColor ? 'color' : 'image')

function normalizeHex(hex: string): string | null {
  let cleaned = hex.trim().replace('#', '')
  if (cleaned.length === 3) {
    cleaned = cleaned[0] + cleaned[0] + cleaned[1] + cleaned[1] + cleaned[2] + cleaned[2]
  }
  if (cleaned.length !== 6) return null
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null
  return `#${cleaned.toLowerCase()}`
}

function onPrimaryColorChange(color: string) {
  const normalized = normalizeHex(color)
  if (!normalized) return
  localPrimaryColor.value = normalized
  localPrimaryColorHex.value = normalized
  theme.setPrimaryColor(normalized)
}

function onPrimaryColorHexInput(val: string) {
  localPrimaryColorHex.value = val
}

function onPrimaryColorHexChange(val: string) {
  const normalized = normalizeHex(val)
  if (normalized) {
    localPrimaryColor.value = normalized
    localPrimaryColorHex.value = normalized
    theme.setPrimaryColor(normalized)
  } else {
    localPrimaryColorHex.value = localPrimaryColor.value
  }
}

function onBgColorChange(color: string) {
  const normalized = normalizeHex(color)
  if (!normalized) return
  localBgColor.value = normalized
  localBgColorHex.value = normalized
  theme.setBgColor(normalized)
}

function onBgColorHexInput(val: string) {
  localBgColorHex.value = val
}

function onBgColorHexChange(val: string) {
  const normalized = normalizeHex(val)
  if (normalized) {
    localBgColor.value = normalized
    localBgColorHex.value = normalized
    theme.setBgColor(normalized)
  } else {
    localBgColorHex.value = localBgColor.value || ''
  }
}

function onBgTabChange(tab: 'color' | 'image') {
  bgTab.value = tab
  if (tab === 'image') {
    theme.setBgColor(null)
  } else {
    theme.setBgImage(null)
    if (localBgColor.value) {
      theme.setBgColor(localBgColor.value)
    }
  }
}

function onBgImageChange(url: string) {
  localBgImage.value = url
  theme.setBgImage(url || null)
}

async function selectBgImage() {
  try {
    const { ipcRenderer } = window.require('electron')
    const result = await ipcRenderer.invoke('dialog:openFile', {
      title: '选择背景图片',
      filters: [
        { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result && !result.canceled && result.filePaths.length > 0) {
      localBgImage.value = result.filePaths[0]
      if (bgTab.value === 'image') {
        theme.setBgImage(result.filePaths[0])
      }
    }
  } catch {
    const path = prompt('请输入图片路径:', localBgImage.value)
    if (path) {
      localBgImage.value = path
      if (bgTab.value === 'image') {
        theme.setBgImage(path)
      }
    }
  }
}

function clearBgImage() {
  localBgImage.value = ''
  theme.setBgImage(null)
}

function onBgOpacityChange(val: number) {
  theme.setBgOpacity(val)
}

function onCustomBaseChange(base: 'dark' | 'light') {
  localCustomBase.value = base
  theme.setCustomBase(base)
}

const presetColors = [
  '#e8913a',
  '#f87171',
  '#fb923c',
  '#fbbf24',
  '#34d399',
  '#22d3ee',
  '#60a5fa',
  '#a78bfa',
  '#f472b6',
  '#e8e8ed',
]

const dohOptions = [
  { label: '关闭', value: 0 },
  { label: '腾讯', value: 1 },
  { label: '阿里', value: 2 },
  { label: '360', value: 3 },
  { label: 'Google', value: 4 },
  { label: 'AdGuard', value: 5 },
  { label: 'Quad9', value: 6 },
]

onMounted(() => {
  inputUrl.value = store.configUrl
  parseName.value = store.defaultParseName
  autoPlayNext.value = store.autoPlayNext
  screenDisplayValue.value = localStorage.getItem('tvbox_screen_display') !== 'false'
  liveUrlInput.value = store.liveUrl
  epgUrlInput.value = store.epgUrl
  searchViewModeValue.value = store.searchViewMode
  dohValue.value = store.dohIndex
  subtitleSizeValue.value = Number(localStorage.getItem('tvbox_subtitle_size') || '24')
  subtitleColorValue.value = localStorage.getItem('tvbox_subtitle_color') || '#ffffff'
  subtitleDelayValue.value = Number(localStorage.getItem('tvbox_subtitle_delay') || '0')
  danmuEnabledValue.value = localStorage.getItem('tvbox_danmu_enabled') === 'true'
  danmuMaxValue.value = Number(localStorage.getItem('tvbox_danmu_max') || '30')
  loadHistory()
})

function loadHistory() {
  try {
    configUrlHistory.value = JSON.parse(localStorage.getItem('tvbox_config_url_history') || '[]')
  } catch {
    configUrlHistory.value = []
  }
}

function saveUrlToHistory(url: string) {
  if (!url) return
  const list = configUrlHistory.value.filter(u => u !== url)
  list.unshift(url)
  if (list.length > 10) list.length = 10
  configUrlHistory.value = list
  localStorage.setItem('tvbox_config_url_history', JSON.stringify(list))
  saveToFile()
}

async function loadConfig() {
  if (!inputUrl.value) {
    ElMessage.warning('配置地址不能为空')
    return
  }
  configLoading.value = true
  store.setConfigUrl(inputUrl.value)
  const success = await store.loadConfig()
  configLoading.value = false

  if (success) {
    ElMessage.success('配置加载成功')
    saveUrlToHistory(inputUrl.value)
  } else {
    ElMessage.error('配置加载失败，请检查网络或链接')
  }
}

function onParseChange(name: string) {
  store.setDefaultParse(name)
  ElMessage.success(`默认解析已切换为 ${name}`)
}

function onAutoPlayNextChange(val: boolean) {
  store.setAutoPlayNext(val)
}

function onScreenDisplayChange(val: boolean) {
  localStorage.setItem('tvbox_screen_display', String(val))
}

function onVlcPathChange(val: string) {
  localStorage.setItem('tvbox_vlc_path', val)
  saveToFile()
}

async function selectVlcPath() {
  try {
    const { ipcRenderer } = window.require('electron')
    const result = await ipcRenderer.invoke('dialog:openFile', {
      title: '选择外部播放器',
      filters: [
        { name: '可执行文件', extensions: ['exe'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result && !result.canceled && result.filePaths.length > 0) {
      vlcPathValue.value = result.filePaths[0]
      onVlcPathChange(result.filePaths[0])
    }
  } catch (e) {
    // Fallback: show input prompt
    const path = prompt('请输入播放器路径:', vlcPathValue.value)
    if (path) {
      vlcPathValue.value = path
      onVlcPathChange(path)
    }
  }
}

function onLiveUrlChange(val: string) {
  store.setLiveUrl(val)
}

function onEpgUrlChange(val: string) {
  store.setEpgUrl(val)
}

function onSearchViewModeChange(val: number) {
  store.setSearchViewMode(val)
}

function onDohChange(val: number) {
  store.setDohIndex(val)
  localProxy.setDohIndex(val)
}

function onSubtitleSizeChange(val: number) {
  localStorage.setItem('tvbox_subtitle_size', String(val))
}

function onSubtitleColorChange(val: string) {
  localStorage.setItem('tvbox_subtitle_color', val)
}

function onSubtitleDelayChange(val: number) {
  localStorage.setItem('tvbox_subtitle_delay', String(val))
}

function onDanmuEnabledChange(val: boolean) {
  localStorage.setItem('tvbox_danmu_enabled', String(val))
}

function onDanmuMaxChange(val: number) {
  localStorage.setItem('tvbox_danmu_max', String(val))
}

// WebDAV
const webdavUrl = ref(localStorage.getItem('tvbox_webdav_url') || '')
const webdavUser = ref(localStorage.getItem('tvbox_webdav_user') || '')
const webdavPass = ref(localStorage.getItem('tvbox_webdav_pass') || '')
const webdavLoading = ref(false)
const remotePort = ref(remoteServer.getPort())
const proxyPort = ref(localProxy.getPort())

function getWebdavClient(): WebDAV | null {
  if (!webdavUrl.value) return null
  localStorage.setItem('tvbox_webdav_url', webdavUrl.value)
  localStorage.setItem('tvbox_webdav_user', webdavUser.value)
  localStorage.setItem('tvbox_webdav_pass', webdavPass.value)
  return new WebDAV({
    url: webdavUrl.value,
    username: webdavUser.value,
    password: webdavPass.value,
  })
}

async function webdavTest() {
  const client = getWebdavClient()
  if (!client) return ElMessage.warning('请输入WebDAV地址')
  webdavLoading.value = true
  try {
    const ok = await client.testConnection()
    ElMessage[ok ? 'success' : 'error'](ok ? '连接成功' : '连接失败')
  } catch {
    ElMessage.error('连接失败')
  } finally {
    webdavLoading.value = false
  }
}

async function webdavBackup() {
  const client = getWebdavClient()
  if (!client) return ElMessage.warning('请输入WebDAV地址')
  webdavLoading.value = true
  try {
    const data = {
      configUrl: store.configUrl,
      activeSiteKey: store.activeSiteKey,
      defaultParseName: store.defaultParseName,
      playType: store.playType,
      autoPlayNext: store.autoPlayNext,
      liveUrl: store.liveUrl,
      epgUrl: store.epgUrl,
      timestamp: Date.now(),
    }
    const filename = `tvbox-pc-backup-${Date.now()}.json`
    const ok = await client.backup(filename, data)
    // Also save as "latest" for easy restore
    if (ok) await client.backup('tvbox-pc-backup-latest.json', data)
    ElMessage[ok ? 'success' : 'error'](ok ? '备份成功' : '备份失败')
  } catch {
    ElMessage.error('备份失败')
  } finally {
    webdavLoading.value = false
  }
}

async function webdavRestore() {
  const client = getWebdavClient()
  if (!client) return ElMessage.warning('请输入WebDAV地址')
  webdavLoading.value = true
  try {
    const data = await client.restore('tvbox-pc-backup-latest.json')
    if (data) {
      if (data.configUrl) { inputUrl.value = data.configUrl; store.setConfigUrl(data.configUrl) }
      if (data.activeSiteKey) store.setActiveSite(data.activeSiteKey)
      if (data.defaultParseName) store.setDefaultParse(data.defaultParseName)
      if (data.liveUrl) store.setLiveUrl(data.liveUrl)
      if (data.epgUrl) store.setEpgUrl(data.epgUrl)
      ElMessage.success('恢复成功')
    } else {
      ElMessage.error('恢复失败：未找到备份')
    }
  } catch {
    ElMessage.error('恢复失败')
  } finally {
    webdavLoading.value = false
  }
}

async function clearHistory() {
  try {
    await ElMessageBox.confirm('确定要清除所有历史记录吗？此操作不可恢复。', '确认清除', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    })
    await store.clearHistory()
    ElMessage.success('历史记录已清除')
  } catch {
    // cancelled
  }
}

function onHistoryUrlSelect(url: string) {
  inputUrl.value = url
}
</script>

<style scoped>
.settings-card {
  background: var(--color-bg-surface);
  border-radius: var(--radius-lg, 14px);
  border: 1px solid var(--color-border);
  padding: 20px 24px;
}

.theme-mode-card {
  width: 100%;
  height: 56px;
  border-radius: 8px;
  border: 2px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  background: transparent;
  color: var(--color-text-secondary);
  user-select: none;
}

.theme-mode-card:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.theme-mode-card.active {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.hex-input {
  width: 120px;
}

.preset-swatch {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: all 0.2s ease;
  padding: 0;
}

.preset-swatch:hover {
  transform: scale(1.1);
}

.preset-swatch.active {
  border-color: var(--color-primary);
}

.custom-theme-section {
  padding-top: 4px;
  border-top: 1px solid var(--color-border);
  margin-top: 4px;
}
</style>
