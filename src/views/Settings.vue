<template>
  <div class="h-full overflow-y-auto" style="background:var(--color-bg-base)">
    <div class="max-w-3xl mx-auto px-5 pt-6 pb-10 flex flex-col gap-5">

      <!-- SECTION 1: 配置源 -->
      <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><Link /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">配置源</h2>
        </div>
        <div class="flex gap-2.5">
          <div class="flex-1 min-w-0">
            <el-input
              v-model="inputUrl"
              placeholder="输入配置订阅地址"
              clearable
              class="settings-input"
            />
          </div>
          <el-button type="primary" :loading="configLoading" @click="loadConfig" class="shrink-0">加载</el-button>
          <el-dropdown trigger="click" class="shrink-0">
            <el-button class="flex items-center gap-1.5">
              <span>推荐</span>
              <el-icon class="w-3.5 h-3.5"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="p in configPresets" :key="p.url" @click="selectPresetUrl(p.url)">
                  <div class="flex flex-col">
                    <span>{{ p.name }}</span>
                    <span class="text-[11px]" style="color: var(--color-text-tertiary)">{{ p.desc }}</span>
                  </div>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-dropdown trigger="click" class="shrink-0">
            <el-button class="flex items-center gap-1.5">
              <span>历史</span>
              <el-icon class="w-3.5 h-3.5"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="url in configUrlHistory" :key="url" @click="selectHistoryUrl(url)">
                  {{ url.length > 40 ? url.substring(0, 40) + '...' : url }}
                </el-dropdown-item>
                <el-dropdown-item v-if="configUrlHistory.length === 0" disabled>暂无历史记录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <!-- 多仓配置选择器 -->
        <div v-if="store.subConfigs.length > 0" class="mt-4">
          <!-- 配置切换 + 合并所有 在同一行 -->
          <div class="flex items-center gap-3 mb-3">
            <el-select
              v-model="activeSubConfigUrl"
              placeholder="选择配置"
              class="flex-1"
              @change="onSubConfigChange"
              :disabled="mergeSubConfigsValue"
            >
              <el-option
                v-for="sub in store.subConfigs"
                :key="sub.url"
                :label="sub.name"
                :value="sub.url"
              />
            </el-select>
            <div class="flex items-center gap-2 shrink-0">
              <span class="text-[13px]" style="color: var(--color-text-tertiary)">合并所有</span>
              <el-switch v-model="mergeSubConfigsValue" @change="onMergeSubConfigsChange" />
            </div>
          </div>

          <!-- 源列表（标签形式）- 显示时不隐藏上面的配置选择器 -->
          <div v-if="store.sites.length > 0">
            <div
              class="flex items-center justify-between cursor-pointer mb-2"
              @click="sourceListCollapsed = !sourceListCollapsed"
            >
              <span class="text-[13px]" style="color: var(--color-text-secondary)">源列表 ({{ store.sites.length }}个)</span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                style="color: var(--color-text-secondary); transition: transform 0.2s"
                :style="{ transform: sourceListCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }"
              >
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </div>
            <div v-show="!sourceListCollapsed" class="flex flex-wrap gap-2">
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
        </div>

        <!-- 单仓模式源列表 -->
        <div v-if="store.sites.length > 0 && store.subConfigs.length === 0" class="mt-4">
          <div
            class="flex items-center justify-between cursor-pointer mb-2"
            @click="sourceListCollapsed = !sourceListCollapsed"
          >
            <span class="text-[13px]" style="color: var(--color-text-secondary)">源列表 ({{ store.sites.length }}个)</span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              style="color: var(--color-text-secondary); transition: transform 0.2s"
              :style="{ transform: sourceListCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }"
            >
              <path d="M6 9l6 6 6-6"/>
            </svg>
          </div>
          <div v-show="!sourceListCollapsed" class="flex flex-wrap gap-2">
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

      <!-- SECTION 2: 播放设置 -->
      <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><VideoPlay /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">播放设置</h2>
        </div>
        <div class="flex flex-col gap-4">
          <!-- Toggle: Auto play next -->
          <div class="flex items-center justify-between">
            <span class="text-[13px]" style="color: var(--color-text-secondary)">自动播放下一集</span>
            <el-switch v-model="autoPlayNext" @change="onAutoPlayNextChange" />
          </div>
          <!-- Toggle: Show info -->
          <div class="flex items-center justify-between">
            <span class="text-[13px]" style="color: var(--color-text-secondary)">播放时显示信息</span>
            <el-switch v-model="screenDisplayValue" @change="onScreenDisplayChange" />
          </div>
          <!-- External player path -->
          <div>
            <label class="block text-[13px] mb-2" style="color: var(--color-text-secondary)">外部播放器路径</label>
            <div class="flex gap-2.5 items-center">
              <el-input
                v-model="vlcPathValue"
                placeholder="例如: C:\Program Files\VLC\vlc.exe"
                clearable
                @change="onVlcPathChange"
                class="flex-1"
              />
              <el-button @click="selectVlcPath" size="default">浏览</el-button>
            </div>
          </div>
          <!-- Playback speed -->
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-[13px]" style="color: var(--color-text-secondary)">播放速度</span>
              <span class="text-[13px] tabular-nums font-medium" style="color: var(--color-text-primary)">{{ playSpeedValue.toFixed(2) }}x</span>
            </div>
            <el-slider
              v-model="playSpeedValue"
              :min="0.5"
              :max="3.0"
              :step="0.25"
              :marks="{ 0.5: '0.5x', 1: '1x', 1.5: '1.5x', 2: '2x', 3: '3x' }"
              @change="onPlaySpeedChange"
            />
          </div>
          <!-- Scale type -->
          <div class="flex items-center justify-between">
            <span class="text-[13px]" style="color: var(--color-text-secondary)">播放尺度</span>
            <el-select v-model="scaleTypeValue" @change="onScaleTypeChange" style="width: 160px">
              <el-option v-for="opt in scaleTypeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
            </el-select>
          </div>
          <!-- Hard decode -->
          <div class="flex items-center justify-between">
            <div class="flex flex-col gap-0.5">
              <span class="text-[13px]" style="color: var(--color-text-secondary)">硬解码</span>
              <span class="text-[11px]" style="color: var(--color-text-tertiary)">使用硬件加速解码，关闭可解决部分花屏问题</span>
            </div>
            <el-switch v-model="hardDecodeValue" @change="onHardDecodeChange" />
          </div>
          <!-- Skip intro / outro -->
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-[13px] mb-2" style="color: var(--color-text-secondary)">跳过片头（秒）</label>
              <el-input-number
                v-model="skipIntroValue"
                :min="0"
                :max="300"
                :step="5"
                controls-position="right"
                class="w-full"
                @change="onSkipIntroChange"
              />
            </div>
            <div>
              <label class="block text-[13px] mb-2" style="color: var(--color-text-secondary)">跳过片尾（秒）</label>
              <el-input-number
                v-model="skipOutroValue"
                :min="0"
                :max="300"
                :step="5"
                controls-position="right"
                class="w-full"
                @change="onSkipOutroChange"
              />
            </div>
          </div>
        </div>
      </section>

      <!-- SECTION 3: 字幕设置 -->
      <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><ChatLineSquare /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">字幕设置</h2>
        </div>
        <div class="flex flex-col gap-5">
          <!-- Font size slider -->
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-[13px]" style="color: var(--color-text-secondary)">字体大小</span>
              <span class="text-[13px] tabular-nums font-medium" style="color: var(--color-text-primary)">{{ subtitleSizeValue }}px</span>
            </div>
            <el-slider v-model="subtitleSizeValue" :min="12" :max="48" :step="2" @change="onSubtitleSizeChange" />
          </div>
          <!-- Color picker -->
          <div>
            <span class="block text-[13px] mb-3" style="color: var(--color-text-secondary)">字幕颜色</span>
            <div class="flex items-center gap-3">
              <button
                v-for="c in subtitleColorPresets"
                :key="c"
                class="settings-color-dot"
                :class="{ active: subtitleColorValue === c }"
                :style="{ background: c }"
                @click="onSubtitleColorChange(c)"
              />
              <el-color-picker v-model="subtitleColorValue" @change="onSubtitleColorChange" />
            </div>
          </div>
          <!-- Delay slider -->
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-[13px]" style="color: var(--color-text-secondary)">延迟调整</span>
              <span class="text-[13px] tabular-nums font-medium" style="color: var(--color-text-primary)">{{ subtitleDelayValue.toFixed(1) }}s</span>
            </div>
            <el-slider v-model="subtitleDelayValue" :min="-5" :max="5" :step="0.1" @change="onSubtitleDelayChange" />
          </div>
        </div>
      </section>

      <!-- SECTION 4: 弹幕设置 -->
      <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><ChatDotRound /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">弹幕设置</h2>
        </div>
        <div class="flex flex-col gap-5">
          <!-- Toggle: Default on/off -->
          <div class="flex items-center justify-between">
            <span class="text-[13px]" style="color: var(--color-text-secondary)">默认开启弹幕</span>
            <el-switch v-model="danmuEnabledValue" @change="onDanmuEnabledChange" />
          </div>
          <!-- Density slider -->
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-[13px]" style="color: var(--color-text-secondary)">弹幕密度</span>
              <span class="text-[13px] tabular-nums font-medium" style="color: var(--color-text-primary)">{{ danmuDensityLabel }}</span>
            </div>
            <el-slider v-model="danmuDensityValue" :min="1" :max="3" :step="1" @change="onDanmuDensityChange" />
          </div>
        </div>
      </section>

      <!-- SECTION 5: 直播设置 -->
      <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><Monitor /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">直播设置</h2>
        </div>
        <div class="flex flex-col gap-4">
          <div>
            <label class="block text-[13px] mb-2" style="color: var(--color-text-secondary)">直播源地址</label>
            <el-input v-model="liveUrlInput" placeholder="输入直播源订阅地址" clearable @change="onLiveUrlChange" />
          </div>
          <div>
            <label class="block text-[13px] mb-2" style="color: var(--color-text-secondary)">EPG节目单地址</label>
            <el-input v-model="epgUrlInput" placeholder="输入EPG节目单地址" clearable @change="onEpgUrlChange" />
          </div>
        </div>
      </section>

      <!-- SECTION 6: 网络设置 -->
      <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><Connection /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">网络设置</h2>
        </div>
        <div>
          <span class="block text-[13px] mb-3" style="color: var(--color-text-secondary)">DNS over HTTPS 提供商</span>
          <div class="flex flex-wrap gap-2">
            <label
              v-for="item in dohOptions"
              :key="item.value"
              class="settings-radio"
              :class="{ active: dohValue === item.value }"
            >
              <input type="radio" name="doh" :value="item.value" :checked="dohValue === item.value" @change="onDohChange(item.value)" />
              <span class="radio-label">{{ item.label }}</span>
            </label>
          </div>
        </div>
      </section>

      <!-- SECTION 7: 主题设置 -->
      <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><Brush /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">主题设置</h2>
        </div>
        <div class="flex flex-col gap-5">
          <!-- Dark/Light mode toggle -->
          <div class="flex items-center justify-between">
            <span class="text-[13px]" style="color: var(--color-text-secondary)">深色模式</span>
            <el-switch v-model="darkModeValue" @change="onDarkModeChange" />
          </div>
          <!-- Color swatches -->
          <div>
            <span class="block text-[13px] mb-3" style="color: var(--color-text-secondary)">主题色</span>
            <div class="flex items-center gap-3 flex-wrap">
              <button
                v-for="c in presetColors"
                :key="c"
                class="settings-swatch"
                :class="{ active: localPrimaryColor === c }"
                :style="{ background: c }"
                @click="onPrimaryColorChange(c)"
              />
              <el-input
                v-model="localPrimaryColorHex"
                class="hex-input"
                placeholder="#RRGGBB"
                @change="onPrimaryColorHexChange"
              />
            </div>
          </div>
          <!-- Background settings -->
          <div>
            <label class="block text-[13px] mb-2" style="color: var(--color-text-secondary)">背景设置</label>
            <el-radio-group v-model="bgTab" size="default" @change="onBgTabChange" class="mb-3">
              <el-radio-button value="color">背景色</el-radio-button>
              <el-radio-button value="image">背景图片</el-radio-button>
            </el-radio-group>

            <div v-if="bgTab === 'color'" class="flex gap-3 items-center">
              <el-color-picker v-model="localBgColor" @change="onBgColorChange" />
              <el-input
                v-model="localBgColorHex"
                class="hex-input"
                placeholder="#RRGGBB"
                @change="onBgColorHexChange"
              />
            </div>

            <div v-else class="flex gap-2.5">
              <el-input
                v-model="localBgImage"
                placeholder="输入背景图片URL"
                clearable
                @change="onBgImageChange"
                class="flex-1"
              />
              <el-button @click="clearBgImage" plain>
                <el-icon><Close /></el-icon>
                <span class="ml-1">清除</span>
              </el-button>
            </div>
          </div>
          <!-- Opacity slider -->
          <div v-if="bgTab === 'image' && localBgImage">
            <div class="flex items-center justify-between mb-2">
              <span class="text-[13px]" style="color: var(--color-text-secondary)">透明度</span>
              <span class="text-[13px] tabular-nums font-medium" style="color: var(--color-text-primary)">{{ Math.round(localBgOpacity * 100) }}%</span>
            </div>
            <el-slider v-model="localBgOpacity" :min="0.02" :max="1" :step="0.01" @change="onBgOpacityChange" />
          </div>
        </div>
      </section>

      <!-- SECTION 8: 数据管理 -->
      <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><Coin /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">数据管理</h2>
        </div>
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between py-2">
            <div>
              <span class="block text-[13px]" style="color: var(--color-text-secondary)">清除播放历史</span>
              <span class="block text-[11px] mt-0.5" style="color: var(--color-text-tertiary)">将删除所有观看记录</span>
            </div>
            <el-button type="danger" plain @click="clearHistory">清除历史</el-button>
          </div>
          <div style="border-top: 1px solid var(--color-border)"></div>
          <div class="flex items-center justify-between py-2">
            <div>
              <span class="block text-[13px]" style="color: var(--color-text-secondary)">清除全部配置</span>
              <span class="block text-[11px] mt-0.5" style="color: var(--color-text-tertiary)">恢复为默认设置</span>
            </div>
            <el-button type="danger" plain @click="clearAllConfig">清除配置</el-button>
          </div>

          <!-- WebDAV 备份/恢复 -->
          <div style="border-top: 1px solid var(--color-border)" class="mt-2"></div>
          <div class="pt-2">
            <span class="block text-[13px] mb-3" style="color: var(--color-text-secondary)">WebDAV 备份</span>
            <div class="flex flex-col gap-3">
              <el-input v-model="webdavUrl" placeholder="WebDAV 地址" clearable />
              <div class="flex gap-2">
                <el-input v-model="webdavUser" placeholder="用户名" clearable class="flex-1" />
                <el-input v-model="webdavPass" type="password" placeholder="密码" show-password class="flex-1" />
              </div>
              <div class="flex gap-2">
                <el-button @click="webdavBackup" :loading="webdavLoading">备份</el-button>
                <el-button @click="webdavRestore" :loading="webdavLoading">恢复</el-button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- SECTION 9: 关于 -->
      <section class="settings-card">
        <div class="flex items-center gap-2.5 mb-4">
          <div class="w-8 h-8 flex items-center justify-center" style="background: var(--color-primary-soft); border-radius: var(--radius-sm, 6px);">
            <el-icon :size="16" style="color: var(--color-primary)"><InfoFilled /></el-icon>
          </div>
          <h2 class="text-[15px] font-semibold" style="color: var(--color-text-primary)">关于</h2>
        </div>
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <span class="text-[13px]" style="color: var(--color-text-secondary)">应用版本</span>
            <span class="text-[13px] tabular-nums" style="color: var(--color-text-primary)">1.2.0</span>
          </div>
          <div style="border-top: 1px solid var(--color-border)"></div>
          <div class="flex items-center justify-between">
            <span class="text-[13px]" style="color: var(--color-text-secondary)">构建版本</span>
            <span class="text-[13px] tabular-nums" style="color: var(--color-text-tertiary)">{{ buildDate }}</span>
          </div>
          <div style="border-top: 1px solid var(--color-border)"></div>
          <div class="flex items-center gap-4 mt-1">
            <a href="#" class="flex items-center gap-1.5 transition-colors duration-150" style="color: var(--color-text-tertiary)">
              <el-icon><Link /></el-icon>
              <span class="text-[13px]">GitHub</span>
            </a>
            <a href="#" class="flex items-center gap-1.5 transition-colors duration-150" style="color: var(--color-text-tertiary)">
              <el-icon><Document /></el-icon>
              <span class="text-[13px]">文档</span>
            </a>
          </div>
        </div>
      </section>

    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '../store/app'
import { useThemeStore } from '../stores/theme'
import { WebDAV } from '../core/WebDAV'
import { saveToFile } from '../core/ConfigSync'

const store = useAppStore()
const theme = useThemeStore()

// Config
const inputUrl = ref('')
const configLoading = ref(false)
const configUrlHistory = ref<string[]>([])
const sourceListCollapsed = ref(false)

// Preset config URLs — curated from web-shared TVBox configs.
// Each preset is verified to load JAR + have working csp_ sources.
const configPresets = [
  {
    name: 'newwex（默认）',
    url: 'https://9280.kstore.vip/newwex.json',
    desc: '88 个源，14 个首页可用，6 个直链播放，网盘源需登录',
  },
  {
    name: '肥猫',
    url: 'http://肥猫.net/tv',
    desc: '38 个源，11 个首页可用，4 个直链播放，网盘源需登录',
  },
  {
    name: 'aowu',
    url: 'http://itv666.cc/aowu/config.webp',
    desc: '85 个源，12 个首页可用，3 个直链播放（Hxq 受 native 限制）',
  },
  {
    name: '欧歌多仓',
    url: 'http://tv.nxog.top/m/',
    desc: '93 个源，8 个直链播放（热播/农民/大鹅/三六零/骚火/金牌/爱看/1905）',
  },
  {
    name: '应用多多聚合',
    url: 'https://jihulab.com/duomv/apps/-/raw/main/fast.json',
    desc: '多仓聚合（4 个子仓），资源全面',
  },
]

function selectPresetUrl(url: string) {
  inputUrl.value = url
}

// Multi-config - 用 computed 直接绑定 store 状态，确保同步
const activeSubConfigUrl = computed(() => {
  if (store.activeSubConfigIndex >= 0 && store.subConfigs[store.activeSubConfigIndex]) {
    return store.subConfigs[store.activeSubConfigIndex].url
  }
  return ''
})
const mergeSubConfigsValue = computed({
  get: () => store.mergeSubConfigs,
  set: (val: boolean) => {
    store.setMergeSubConfigs(val)
  }
})

// Playback
const autoPlayNext = ref(true)
const screenDisplayValue = ref(true)
const vlcPathValue = ref(localStorage.getItem('tvbox_vlc_path') || '')
// Playback settings (mirror FongMi/TV Playback)
const playSpeedValue = ref(1)
const scaleTypeValue = ref('default')
const hardDecodeValue = ref(true)
const skipIntroValue = ref(0)
const skipOutroValue = ref(0)
const scaleTypeOptions = [
  { label: '默认', value: 'default' },
  { label: '16:9', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '填充', value: 'fill' },
  { label: '原始', value: 'original' },
  { label: '裁剪', value: 'crop' },
]

// Subtitle
const subtitleSizeValue = ref(24)
const subtitleColorValue = ref('#f0f0f5')
const subtitleDelayValue = ref(0)
const subtitleColorPresets = ['#f0f0f5', '#fbbf24', '#34d399', '#60a5fa', '#f87171']

// Danmaku
const danmuEnabledValue = ref(false)
const danmuDensityValue = ref(2)
const danmuDensityLabel = computed(() => {
  const labels = ['稀疏', '中等', '密集']
  return labels[danmuDensityValue.value - 1] || '中等'
})

// Live
const liveUrlInput = ref('')
const epgUrlInput = ref('')

// Network
const dohValue = ref(0)
const dohOptions = [
  { label: '不使用', value: 0 },
  { label: '阿里 DNS', value: 1 },
  { label: 'Google DNS', value: 2 },
  { label: 'Cloudflare', value: 3 },
]

// Theme
const darkModeValue = ref(theme.mode === 'dark')
const localPrimaryColor = ref(theme.primaryColor)
const localPrimaryColorHex = ref(theme.primaryColor)
const localBgColor = ref(theme.bgColor || '')
const localBgColorHex = ref(theme.bgColor || '')
const localBgImage = ref(theme.bgImage || '')
const localBgOpacity = ref(theme.bgOpacity)
const bgTab = ref<'color' | 'image'>(theme.bgColor ? 'color' : 'image')

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

// WebDAV
const webdavUrl = ref(localStorage.getItem('tvbox_webdav_url') || '')
const webdavUser = ref(localStorage.getItem('tvbox_webdav_user') || '')
const webdavPass = ref(localStorage.getItem('tvbox_webdav_pass') || '')
const webdavLoading = ref(false)

// Build date
const buildDate = new Date().toISOString().split('T')[0].replace(/-/g, '.')

onMounted(() => {
  // Config
  inputUrl.value = store.configUrl
  loadHistory()

  // Playback
  autoPlayNext.value = store.autoPlayNext
  screenDisplayValue.value = localStorage.getItem('tvbox_screen_display') !== 'false'
  // Playback settings (mirror FongMi/TV)
  playSpeedValue.value = store.playSpeed
  scaleTypeValue.value = store.scaleType
  hardDecodeValue.value = store.hardDecode
  skipIntroValue.value = store.skipIntro
  skipOutroValue.value = store.skipOutro

  // Subtitle
  subtitleSizeValue.value = Number(localStorage.getItem('tvbox_subtitle_size') || '24')
  subtitleColorValue.value = localStorage.getItem('tvbox_subtitle_color') || '#f0f0f5'
  subtitleDelayValue.value = Number(localStorage.getItem('tvbox_subtitle_delay') || '0')

  // Danmaku
  danmuEnabledValue.value = localStorage.getItem('tvbox_danmu_enabled') === 'true'
  const savedDensity = Number(localStorage.getItem('tvbox_danmu_density') || '2')
  danmuDensityValue.value = Math.max(1, Math.min(3, savedDensity))

  // Live
  liveUrlInput.value = store.liveUrl
  epgUrlInput.value = store.epgUrl

  // Network
  dohValue.value = store.dohIndex

  // Theme
  darkModeValue.value = theme.mode === 'dark'
})

// ===== Config =====
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

function selectHistoryUrl(url: string) {
  inputUrl.value = url
}

// ===== Multi-config =====
function onMergeSubConfigsChange(val: boolean) {
  if (val) {
    ElMessage.success('已合并所有子配置')
  }
}

async function onSubConfigChange(url: string) {
  const index = store.subConfigs.findIndex(s => s.url === url)
  if (index >= 0) {
    configLoading.value = true
    try {
      const success = await store.loadSubConfig(index)
      if (success) {
        ElMessage.success(`已加载: ${store.subConfigs[index].name}`)
      } else {
        ElMessage.error('子配置加载失败')
      }
    } finally {
      configLoading.value = false
    }
  }
}

// ===== Playback =====
function onAutoPlayNextChange(val: boolean) {
  store.setAutoPlayNext(val)
}

function onScreenDisplayChange(val: boolean) {
  localStorage.setItem('tvbox_screen_display', String(val))
}

function onPlaySpeedChange(val: number) {
  store.setPlaySpeed(val)
}
function onScaleTypeChange(val: string) {
  store.setScaleType(val)
}
function onHardDecodeChange(val: boolean) {
  store.setHardDecode(val)
}
function onSkipIntroChange(val: number) {
  store.setSkipIntro(val || 0)
}
function onSkipOutroChange(val: number) {
  store.setSkipOutro(val || 0)
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
    const path = prompt('请输入播放器路径:', vlcPathValue.value)
    if (path) {
      vlcPathValue.value = path
      onVlcPathChange(path)
    }
  }
}

// ===== Subtitle =====
function onSubtitleSizeChange(val: number) {
  localStorage.setItem('tvbox_subtitle_size', String(val))
}

function onSubtitleColorChange(val: string) {
  subtitleColorValue.value = val
  localStorage.setItem('tvbox_subtitle_color', val)
}

function onSubtitleDelayChange(val: number) {
  localStorage.setItem('tvbox_subtitle_delay', String(val))
}

// ===== Danmaku =====
function onDanmuEnabledChange(val: boolean) {
  localStorage.setItem('tvbox_danmu_enabled', String(val))
}

function onDanmuDensityChange(val: number) {
  localStorage.setItem('tvbox_danmu_density', String(val))
}

// ===== Live =====
function onLiveUrlChange(val: string) {
  store.setLiveUrl(val)
}

function onEpgUrlChange(val: string) {
  store.setEpgUrl(val)
}

// ===== Network =====
async function onDohChange(val: number) {
  dohValue.value = val
  store.setDohIndex(val)
  const { localProxy } = await import('../core/LocalProxyServer')
  localProxy.setDohIndex(val)
}

// ===== Theme =====
function onDarkModeChange(val: boolean) {
  theme.setMode(val ? 'dark' : 'light')
}

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

function onBgColorChange(color: string) {
  const normalized = normalizeHex(color)
  if (!normalized) return
  localBgColor.value = normalized
  localBgColorHex.value = normalized
  theme.setBgColor(normalized)
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

function onBgImageChange(url: string) {
  localBgImage.value = url
  theme.setBgImage(url || null)
}

function clearBgImage() {
  localBgImage.value = ''
  theme.setBgImage(null)
}

function onBgOpacityChange(val: number) {
  theme.setBgOpacity(val)
}

// ===== Data Management =====
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

async function clearAllConfig() {
  try {
    await ElMessageBox.confirm('确定要清除所有配置吗？此操作不可恢复。', '确认清除', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    })
    localStorage.clear()
    location.reload()
  } catch {
    // cancelled
  }
}

// ===== WebDAV =====
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
</script>

<style scoped>
.settings-card {
  position: relative;
  padding: 24px;
  border-radius: var(--radius-lg, 14px);
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--color-border);
}

.settings-card:hover {
  box-shadow: 0 0 20px var(--color-primary-glow);
}

.settings-input {
  height: 40px;
}

.settings-color-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease;
  flex-shrink: 0;
}

.settings-color-dot:hover {
  transform: scale(1.15);
}

.settings-color-dot.active {
  border-color: var(--color-text-primary);
  box-shadow: 0 0 0 3px var(--color-bg-base), 0 0 0 5px var(--color-text-tertiary);
}

.settings-swatch {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease;
  flex-shrink: 0;
}

.settings-swatch:hover {
  transform: scale(1.15);
}

.settings-swatch.active {
  border-color: white;
  box-shadow: 0 0 0 3px var(--color-bg-base), 0 0 12px var(--color-primary-glow);
}

.settings-radio {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  padding: 8px 16px;
  border-radius: var(--radius-sm, 6px);
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  transition: background 0.15s ease, border-color 0.15s ease;
}

.settings-radio input {
  display: none;
}

.radio-label {
  font-size: 13px;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.settings-radio:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.1);
}

.settings-radio.active {
  background: var(--color-primary-soft);
  border-color: var(--color-primary-border);
}

.settings-radio.active .radio-label {
  color: var(--color-primary);
  font-weight: 500;
}

.hex-input {
  width: 120px;
}

a:hover {
  color: var(--color-text-primary) !important;
}
</style>
