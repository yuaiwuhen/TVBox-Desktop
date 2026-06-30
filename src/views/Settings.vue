<template>
  <div class="max-w-2xl mx-auto mt-6 mb-10 p-6 bg-white rounded-lg shadow">
    <h2 class="text-2xl font-bold mb-6 flex items-center gap-2">
      <el-icon><Setting /></el-icon> 全局设置
    </h2>

    <el-form label-position="top">

      <!-- Section 1: 配置源 -->
      <h3 class="text-lg font-semibold text-gray-700 mb-2">配置源</h3>
      <el-form-item label="配置地址">
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
      </el-form-item>

      <div v-if="store.sites.length > 0" class="mb-4">
        <p class="text-sm text-gray-600 mb-2">已加载源 (点击切换当前源)：</p>
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

      <el-divider />

      <!-- Section 2: 解析设置 -->
      <h3 class="text-lg font-semibold text-gray-700 mb-2">解析设置</h3>
      <el-form-item label="默认解析">
        <el-select v-model="parseName" placeholder="选择默认解析" @change="onParseChange">
          <el-option
            v-for="p in store.parses"
            :key="p.name"
            :label="p.name"
            :value="p.name"
          />
        </el-select>
      </el-form-item>

      <div v-if="store.parses.length > 0" class="mb-4">
        <p class="text-sm text-gray-500">已加载 {{ store.parses.length }} 个解析器</p>
      </div>

      <el-divider />

      <!-- Section 3: 播放设置 -->
      <h3 class="text-lg font-semibold text-gray-700 mb-2">播放设置</h3>
      <el-form-item label="自动播放下一集">
        <el-switch v-model="autoPlayNext" @change="onAutoPlayNextChange" />
      </el-form-item>

      <el-form-item label="屏显信息">
        <el-switch v-model="screenDisplayValue" @change="onScreenDisplayChange" />
      </el-form-item>

      <el-form-item label="播放器类型">
        <el-radio-group v-model="playTypeValue" @change="onPlayTypeChange">
          <el-radio-button :value="0">系统</el-radio-button>
          <el-radio-button :value="1">IJK</el-radio-button>
          <el-radio-button :value="2">Exo</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <el-divider />

      <!-- Section: 字幕设置 -->
      <h3 class="text-lg font-semibold text-gray-700 mb-2">字幕设置</h3>
      <el-form-item label="字幕字号">
        <el-slider v-model="subtitleSizeValue" :min="12" :max="48" :step="2" show-input @change="onSubtitleSizeChange" />
      </el-form-item>
      <el-form-item label="字幕颜色">
        <el-color-picker v-model="subtitleColorValue" @change="onSubtitleColorChange" />
      </el-form-item>
      <el-form-item label="字幕延迟 (秒)">
        <el-slider v-model="subtitleDelayValue" :min="-5" :max="5" :step="0.1" show-input @change="onSubtitleDelayChange" />
      </el-form-item>

      <el-divider />

      <!-- Section: 弹幕设置 -->
      <h3 class="text-lg font-semibold text-gray-700 mb-2">弹幕设置</h3>
      <el-form-item label="弹幕默认开启">
        <el-switch v-model="danmuEnabledValue" @change="onDanmuEnabledChange" />
      </el-form-item>
      <el-form-item label="弹幕同屏数量">
        <el-slider v-model="danmuMaxValue" :min="5" :max="50" :step="5" show-input @change="onDanmuMaxChange" />
      </el-form-item>

      <el-divider />

      <!-- Section 4: 直播设置 -->
      <h3 class="text-lg font-semibold text-gray-700 mb-2">直播设置</h3>
      <el-form-item label="直播地址">
        <el-input v-model="liveUrlInput" placeholder="直播源地址" clearable @change="onLiveUrlChange" />
      </el-form-item>
      <el-form-item label="EPG 地址">
        <el-input v-model="epgUrlInput" placeholder="EPG 节目单地址" clearable @change="onEpgUrlChange" />
      </el-form-item>

      <el-divider />

      <!-- Section 5: 搜索设置 -->
      <h3 class="text-lg font-semibold text-gray-700 mb-2">搜索设置</h3>
      <el-form-item label="搜索视图模式">
        <el-radio-group v-model="searchViewModeValue" @change="onSearchViewModeChange">
          <el-radio-button :value="0">列表</el-radio-button>
          <el-radio-button :value="1">缩略图</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <el-divider />

      <!-- Section 6: 网络设置 -->
      <h3 class="text-lg font-semibold text-gray-700 mb-2">网络设置</h3>
      <el-form-item label="DoH (DNS over HTTPS)">
        <el-select v-model="dohValue" @change="onDohChange">
          <el-option v-for="item in dohOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </el-form-item>

      <el-divider />

      <!-- Section 7: 数据管理 -->
      <h3 class="text-lg font-semibold text-gray-700 mb-2">数据管理</h3>
      <el-form-item label="历史记录">
        <el-button type="danger" @click="clearHistory">清除历史记录</el-button>
      </el-form-item>
      <el-form-item label="配置地址历史">
        <el-select v-model="inputUrl" placeholder="选择历史配置地址" @change="onHistoryUrlSelect" filterable allow-create>
          <el-option v-for="url in configUrlHistory" :key="url" :label="url" :value="url" />
        </el-select>
      </el-form-item>

      <el-divider />

      <!-- Section: WebDAV 备份 -->
      <h3 class="text-lg font-semibold text-gray-700 mb-2">WebDAV 备份</h3>
      <el-form-item label="WebDAV 地址">
        <el-input v-model="webdavUrl" placeholder="https://dav.example.com/path" clearable />
      </el-form-item>
      <el-form-item label="用户名">
        <el-input v-model="webdavUser" placeholder="WebDAV 用户名" clearable />
      </el-form-item>
      <el-form-item label="密码">
        <el-input v-model="webdavPass" type="password" placeholder="WebDAV 密码" show-password />
      </el-form-item>
      <div class="flex gap-2">
        <el-button @click="webdavBackup" :loading="webdavLoading">备份到 WebDAV</el-button>
        <el-button @click="webdavRestore" :loading="webdavLoading">从 WebDAV 恢复</el-button>
        <el-button @click="webdavTest" :loading="webdavLoading">测试连接</el-button>
      </div>

      <el-divider />

      <!-- Section 8: 关于 -->
      <h3 class="text-lg font-semibold text-gray-700 mb-2">关于</h3>
      <div class="text-sm text-gray-600 space-y-1">
        <p>版本：1.0.0</p>
        <p>项目地址：<el-link type="primary" href="https://github.com/CatVodTVOfficial/TVBoxOSC" target="_blank">TVBoxOSC</el-link></p>
        <p>远程控制端口：<el-tag size="small">{{ remotePort }}</el-tag></p>
        <p>本地代理端口：<el-tag size="small">{{ proxyPort }}</el-tag></p>
      </div>

    </el-form>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '../store/app'
import { WebDAV } from '../core/WebDAV'
import { remoteServer } from '../core/RemoteServer'
import { localProxy } from '../core/LocalProxyServer'

const store = useAppStore()

const inputUrl = ref('')
const configLoading = ref(false)
const parseName = ref('')
const autoPlayNext = ref(true)
const playTypeValue = ref(0)
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
  playTypeValue.value = store.playType
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

function onPlayTypeChange(val: number) {
  store.setPlayType(val)
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
