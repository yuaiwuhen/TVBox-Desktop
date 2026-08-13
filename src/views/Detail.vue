<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <!-- Header removed – sticky glass bar is inside scroll container -->

    <!-- Loading -->
    <div v-if="loading" class="flex-1 p-6">
      <el-skeleton :rows="8" animated />
    </div>

    <!-- Detail Load Error -->
    <div v-else-if="detailError && !store.currentVod" class="flex-1 flex items-center justify-center p-6">
      <div class="text-center max-w-md">
        <el-icon :size="56" style="color: var(--color-warning)">
          <WarningFilled />
        </el-icon>
        <p class="mt-4 text-base font-medium" style="color: var(--color-text-primary)">
          无法加载详情
        </p>
        <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">
          {{ detailError }}
        </p>
        <div class="mt-4 flex gap-2 justify-center">
          <el-button type="primary" size="small" @click="retryLoadDetail">重试</el-button>
          <el-button size="small" @click="router.back()">返回</el-button>
        </div>
      </div>
    </div>

    <!-- Detail Content -->
    <div v-else-if="store.currentVod" class="flex-1 overflow-auto">
      <!-- Sticky floating glassmorphic action bar -->
      <div class="sticky top-0 z-20 px-6 pt-4">
        <div class="flex items-center gap-3 px-4 py-2.5"
          style="background: var(--color-bg-glass); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur); border: var(--glass-border); border-radius: var(--radius-lg, 14px)">
          <button class="flex items-center justify-center w-8 h-8 rounded-full transition-colors"
            style="background: var(--color-bg-elevated); color: var(--color-text-secondary)" @click="router.back()">
            <el-icon :size="16">
              <ArrowLeft />
            </el-icon>
          </button>
          <span class="flex-1 text-sm font-medium truncate" style="color: var(--color-text-primary)">{{
            store.currentVod?.vod_name }}</span>
          <button class="flex items-center justify-center w-8 h-8 rounded-full transition-colors"
            :style="{ background: isFavorited ? 'var(--color-primary-soft)' : 'var(--color-bg-elevated)', color: isFavorited ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }"
            @click="handleToggleFavorite">
            <el-icon :size="16">
              <component :is="isFavorited ? StarFilled : Star" />
            </el-icon>
          </button>
          <button v-if="store.currentPlayUrl"
            class="flex items-center justify-center w-8 h-8 rounded-full transition-colors"
            style="background: var(--color-bg-elevated); color: var(--color-text-tertiary)" @click="copyPlayUrl">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Video Player at top (shown when playing) -->
      <div v-if="store.currentPlayUrl" class="w-full px-6 pt-4 player-enter-container">
        <div class="rounded-xl overflow-hidden detail-player-shadow player-enter-animation"
          style="aspect-ratio: 16/9; background: black">
          <VideoPlayer :key="store.currentPlayUrl" ref="videoPlayerRef" :url="store.currentPlayUrl"
            :headers="store.currentPlayHeader" :title="playerTitle" :has-prev="store.currentPlayIndex > 0"
            :has-next="store.currentPlayIndex < store.currentEpisodes.length - 1"
            :resume-progress="store.resumeProgress" :show-subtitle-search="true" :danmu-url="store.currentDanmuUrl"
            @prev="onPrevEpisode" @next="onNextEpisode" @ended="onPlayEnded" @progress="onProgress"
            @search-subtitle="onSearchSubtitle" />
        </div>
      </div>

      <!-- Play Error Dialog (centered modal) -->
      <Teleport to="body">
        <transition name="play-error-dialog">
          <div v-if="playError" class="play-error-overlay" @click.self="store.playError = ''">
            <div class="play-error-card">
              <div class="play-error-glow" aria-hidden="true"></div>
              <div class="play-error-icon">
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.8"
                  stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="13" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <h3 class="play-error-title">播放失败</h3>
              <p class="play-error-source">播放源: {{ activePlaySource || '未知' }}</p>
              <p class="play-error-message">{{ formatPlayError(playError) }}</p>
              <div class="play-error-actions">
                <button class="play-error-btn play-error-btn-primary" @click="store.playError = ''">
                  知道了
                </button>
              </div>
            </div>
          </div>
        </transition>
      </Teleport>

      <!-- Info Section with blurred poster background -->
      <div class="detail-hero relative overflow-hidden">
        <!-- Top gradient fade -->
        <div class="absolute top-0 left-0 right-0 h-24"
          style="background: linear-gradient(to bottom, var(--color-bg-base), transparent); z-index: 1"></div>
        <div v-if="store.currentVod.vod_pic" class="absolute inset-0 bg-cover bg-center"
          :style="{ backgroundImage: `url(${processImageUrl(store.currentVod.vod_pic)})` }" />
        <div class="absolute inset-0 detail-hero-overlay" />
        <div class="absolute inset-0 detail-hero-blur" />
        <div class="relative flex flex-col md:flex-row gap-6 p-6" style="z-index: 2">
          <div class="w-[200px] md:w-[240px] flex-shrink-0 overflow-hidden detail-poster-shadow"
            style="aspect-ratio: 2/3; border-radius: var(--radius-lg, 14px); border: var(--color-border); background: var(--color-bg-elevated)">
            <img v-if="store.currentVod.vod_pic" :src="processImageUrl(store.currentVod.vod_pic)"
              class="w-full h-full object-cover" />
            <div v-else class="w-full h-full flex items-center justify-center">
              <el-icon :size="48" style="color: var(--color-text-tertiary)">
                <Film />
              </el-icon>
            </div>
          </div>
          <div class="flex flex-col gap-2 flex-1 min-w-0">
            <h1 class="text-3xl md:text-4xl font-bold" style="color: var(--color-text-primary)">{{
              store.currentVod.vod_name }}</h1>
            <!-- Rating badge -->
            <div v-if="store.currentVod.vod_score || store.currentVod.vod_douban_score"
              class="flex items-center gap-2 mt-1">
              <span class="inline-flex items-center gap-1 px-2.5 py-1 text-sm font-bold"
                style="background: var(--color-primary); color: white; border-radius: var(--radius-sm, 6px);">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <path
                    d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                {{ store.currentVod.vod_score || store.currentVod.vod_douban_score }}
              </span>
            </div>
            <!-- Tag badges: year, area, type -->
            <div class="flex flex-wrap gap-2 mt-2">
              <span v-if="store.currentVod.vod_year"
                class="inline-flex items-center px-2.5 py-0.5 text-xs font-medium rounded-full"
                style="background: var(--color-primary-soft); color: var(--color-primary)">{{ store.currentVod.vod_year
                }}</span>
              <span v-if="store.currentVod.vod_area"
                class="inline-flex items-center px-2.5 py-0.5 text-xs font-medium rounded-full"
                style="background: var(--color-primary-soft); color: var(--color-primary)">{{ store.currentVod.vod_area
                }}</span>
              <span v-if="store.currentVod.type_name"
                class="inline-flex items-center px-2.5 py-0.5 text-xs font-medium rounded-full"
                style="background: var(--color-bg-glass); color: var(--color-text-secondary); border: var(--color-border)">{{
                  store.currentVod.type_name }}</span>
            </div>
            <!-- Meta info rows -->
            <div class="mt-3 flex flex-col gap-1.5">
              <div v-if="store.currentVod.vod_director" class="flex items-center gap-2 text-sm">
                <span class="shrink-0" style="color: var(--color-text-tertiary)">导演</span>
                <span style="color: var(--color-text-secondary)">{{ store.currentVod.vod_director }}</span>
              </div>
              <div v-if="store.currentVod.vod_actor" class="flex items-center gap-2 text-sm">
                <span class="shrink-0" style="color: var(--color-text-tertiary)">主演</span>
                <span style="color: var(--color-text-secondary)">{{ store.currentVod.vod_actor }}</span>
              </div>
              <div v-if="store.currentVod.type_name" class="flex items-center gap-2 text-sm">
                <span class="shrink-0" style="color: var(--color-text-tertiary)">类型</span>
                <span style="color: var(--color-text-secondary)">{{ store.currentVod.type_name }}</span>
              </div>
              <div v-if="store.currentVod.vod_area" class="flex items-center gap-2 text-sm">
                <span class="shrink-0" style="color: var(--color-text-tertiary)">地区</span>
                <span style="color: var(--color-text-secondary)">{{ store.currentVod.vod_area }}</span>
              </div>
              <div v-if="store.currentVod.vod_year" class="flex items-center gap-2 text-sm">
                <span class="shrink-0" style="color: var(--color-text-tertiary)">上映</span>
                <span style="color: var(--color-text-secondary)">{{ store.currentVod.vod_year }}</span>
              </div>
            </div>
            <!-- Action buttons: Play + Cache -->
            <div class="mt-4 flex items-center gap-3">
              <button v-if="playSources.length > 0"
                class="inline-flex items-center justify-center gap-2 px-8 py-3 text-sm font-semibold transition-all active:scale-95"
                style="background: var(--color-primary); color: white; border-radius: var(--radius-lg, 14px); box-shadow: 0 0 20px var(--color-primary-glow, rgba(232,145,58,0.3))"
                @click="playEpisode(activePlaySource, getVisibleEpisodes(playSources.find(s => s.name === activePlaySource)?.episodes || [])[0]?.url)">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                立即播放
              </button>
              <button
                class="inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-medium transition-all border active:scale-95"
                style="background: transparent; color: var(--color-text-secondary); border-color: var(--color-border); border-radius: var(--radius-lg, 14px)"
                @click="cacheVideo">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                缓存
              </button>
            </div>
            <div v-if="store.currentVod.vod_content" class="mt-3 text-sm rounded-lg p-4 detail-desc relative"
              style="background: var(--color-bg-glass); color: var(--color-text-secondary)">
              <div v-if="descExpanded" class="detail-desc-content" v-html="sanitizedVodContent"></div>
              <div v-else class="detail-desc-content">{{ truncatedVodContent }}</div>
              <div class="text-right mt-2">
                <span class="text-xs cursor-pointer" style="color: var(--color-primary)"
                  @click="descExpanded = !descExpanded">{{ descExpanded ? '收起' : '展开' }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="px-6 pb-6">
        <!-- Play Sources -->
        <div v-if="playSources.length > 0" class="mb-4">
          <div class="flex items-center justify-between mb-3">
            <span class="text-sm font-medium" style="color: var(--color-text-primary)">选集</span>
            <div class="flex items-center gap-2">
              <!-- 直接访问 panLoginStates，Vue 可以正确追踪响应式依赖 -->
              <template v-if="isPanSource(activePlaySource) && !panLoginStates[activePlaySource]">
                <el-button size="small" type="warning" @click="showPanLogin = true">
                  <el-icon>
                    <Picture />
                  </el-icon>
                  扫码登录
                </el-button>
              </template>
              <el-button size="small" text @click="toggleSortOrder" style="color: var(--color-primary)">
                {{ sortOrder === 'asc' ? '正序' : '倒序' }}
              </el-button>
            </div>
          </div>
          <!-- Source pill bar -->
          <div v-if="playSources.length > 1" class="flex items-center gap-1 p-1 mb-3"
            style="background: var(--color-bg-glass); border: var(--glass-border); border-radius: var(--radius-lg, 14px)">
            <button v-for="source in playSources" :key="source.name"
              class="px-3 py-1.5 text-sm font-medium transition-all cursor-pointer" :style="activePlaySource === source.name
                ? 'background: var(--color-primary); color: white; border-radius: var(--radius-md); box-shadow: 0 2px 8px var(--color-primary-glow)'
                : 'color: var(--color-text-tertiary); border-radius: var(--radius-md)'"
              @click="activePlaySource = source.name">
              {{ source.name }}
            </button>
          </div>
          <!-- Episode group + grid for active source -->
          <template v-for="source in playSources" :key="source.name">
            <template v-if="source.name === activePlaySource">
              <div v-if="getEpisodeGroups(source.episodes).length > 1" class="mb-2">
                <el-radio-group v-model="activeEpisodeGroup" size="small">
                  <el-radio-button v-for="(group, gi) in getEpisodeGroups(source.episodes)" :key="gi" :value="gi">{{
                    group.label
                  }}</el-radio-button>
                </el-radio-group>
              </div>
              <div class="ep-grid mt-2">
                <el-tooltip v-for="(ep, idx) in getVisibleEpisodes(source.episodes)" :key="ep.url" :content="ep.name"
                  :disabled="ep.name.length <= 8" placement="top" :show-after="300">
                  <button class="ep-btn px-3 text-sm transition-all duration-150 cursor-pointer text-center"
                    :class="isEpisodeActive(source.episodes, idx) ? 'ep-btn-active' : ''"
                    :disabled="store.playLoading && pendingPlayUrl === ep.url"
                    @click="playEpisode(source.name, ep.url)">
                    <el-icon v-if="store.playLoading && pendingPlayUrl === ep.url" class="is-loading" :size="12">
                      <Loading />
                    </el-icon>
                    <span v-else class="ep-name">{{ ep.name }}</span>
                  </button>
                </el-tooltip>
              </div>
            </template>
          </template>
        </div>

        <!-- Pan Login Required Prompt -->
        <div v-else-if="needPanLogin" class="mb-4 rounded-lg p-6 text-center"
          style="background: var(--color-bg-surface)">
          <el-icon :size="40" style="color: var(--color-warning)">
            <WarningFilled />
          </el-icon>
          <p class="mt-3 text-sm" style="color: var(--color-text-secondary)">
            该资源来自网盘，需登录对应网盘后方可播放
          </p>
          <p class="mt-1 text-xs" style="color: var(--color-text-tertiary)">
            请到配置中心扫码登录夸克网盘或百度网盘
          </p>
          <el-button type="warning" size="small" class="mt-3" @click="goToConfigCenter">
            去配置中心登录
          </el-button>
        </div>

        <!-- msearch: aggregator result — show cross-source search results -->
        <div v-else-if="isMsearchResult" class="mb-4">
          <div class="flex items-center justify-between mb-3">
            <span class="text-sm font-medium" style="color: var(--color-text-primary)">
              {{ store.searchLoading ? '正在搜索可播放源...' : `搜索到 ${msearchTotalCount} 个源可播放` }}
            </span>
            <el-button size="small" text @click="refreshMsearchSearch" style="color: var(--color-primary)">
              重新搜索
            </el-button>
          </div>
          <div v-if="store.searchLoading && msearchSearchGroups.length === 0" class="rounded-lg p-6 text-center"
            style="background: var(--color-bg-surface)">
            <el-icon class="is-loading" :size="28" style="color: var(--color-text-tertiary)">
              <Loading />
            </el-icon>
            <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">搜索中...</p>
          </div>
          <div v-else-if="msearchSearchGroups.length === 0" class="rounded-lg p-6 text-center"
            style="background: var(--color-bg-surface)">
            <el-icon :size="40" style="color: var(--color-text-tertiary)">
              <WarningFilled />
            </el-icon>
            <p class="mt-3 text-sm" style="color: var(--color-text-secondary)">
              未搜索到可播放的源
            </p>
            <el-button class="mt-3" size="small" @click="refreshMsearchSearch">重新搜索</el-button>
          </div>
          <template v-else>
            <div v-for="group in msearchSearchGroups" :key="group.siteKey" class="mb-3">
              <div class="text-xs font-medium mb-2 px-1" style="color: var(--color-text-tertiary)">
                {{ group.siteName }} ({{ group.list.length }})
              </div>
              <div class="msearch-grid">
                <button v-for="item in group.list" :key="item.vod_id"
                  class="msearch-card"
                  @click="goToSourceDetail(group.siteKey, item.vod_id)">
                  <img v-if="item.vod_pic" :src="processImageUrl(item.vod_pic)" class="msearch-card-poster" />
                  <div v-else class="msearch-card-poster msearch-card-poster-placeholder">
                    <el-icon :size="20" style="color: var(--color-text-tertiary)">
                      <Film />
                    </el-icon>
                  </div>
                  <div class="msearch-card-info">
                    <div class="msearch-card-title">{{ item.vod_name }}</div>
                    <div v-if="item.vod_remarks" class="msearch-card-remarks">{{ item.vod_remarks }}</div>
                  </div>
                </button>
              </div>
            </div>
          </template>
        </div>

        <!-- No Play Sources (unknown reason) -->
        <div v-else class="mb-4 rounded-lg p-6 text-center" style="background: var(--color-bg-surface)">
          <el-icon :size="40" style="color: var(--color-text-tertiary)">
            <WarningFilled />
          </el-icon>
          <p class="mt-3 text-sm font-medium" style="color: var(--color-text-primary)">
            {{ detailError || '暂无播放源' }}
          </p>
          <p v-if="!detailError" class="mt-1 text-xs" style="color: var(--color-text-tertiary)">
            该资源可能已下线或分享链接已失效
          </p>
          <el-button class="mt-3" size="small" @click="retryLoadDetail">重试</el-button>
        </div>
      </div>
    </div>

    <!-- Subtitle Search Dialog -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="subtitleSearchVisible" class="subsearch-overlay" @click.self="subtitleSearchVisible = false">
          <div class="subsearch-card">
            <!-- Header -->
            <div class="subsearch-header">
              <h2 class="subsearch-title">搜索字幕</h2>
              <button class="subsearch-close" @click="subtitleSearchVisible = false" aria-label="关闭">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <!-- Search input -->
            <div class="subsearch-input-row">
              <svg class="subsearch-input-icon" viewBox="0 0 24 24" width="16" height="16" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input v-model="subtitleSearchQuery" type="text" class="subsearch-input" placeholder="输入影片名称搜索字幕"
                @keydown.enter="retrySubtitleSearch" />
            </div>

            <!-- Divider -->
            <div class="subsearch-divider"></div>

            <!-- Result list -->
            <div class="subsearch-list">
              <div v-if="subtitleSearchLoading" class="subsearch-empty">
                <el-icon class="is-loading" :size="28" style="color: var(--color-text-tertiary)">
                  <Loading />
                </el-icon>
                <p class="subsearch-empty-text">搜索中...</p>
              </div>
              <div v-else-if="subtitleSearchResults.length === 0" class="subsearch-empty">
                <p class="subsearch-empty-text">未找到字幕</p>
              </div>
              <div v-else v-for="(item, idx) in subtitleSearchResults" :key="idx" class="subsearch-item"
                @click="onSelectSubtitle(item)">
                <div class="subsearch-item-info">
                  <div class="subsearch-item-name-row">
                    <span class="subsearch-item-name">{{ item.name }}</span>
                    <span class="subsearch-badge" :class="item.isZip ? 'subsearch-badge-zip' : 'subsearch-badge-sub'">
                      {{ item.isZip ? 'ZIP' : 'SUB' }}
                    </span>
                  </div>
                  <span class="subsearch-item-meta">{{ item.isZip ? '压缩包格式' : '字幕文件' }}</span>
                </div>
                <button class="subsearch-load-btn" @click.stop="onSelectSubtitle(item)">加载</button>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- QR Login Dialog -->
    <QRLoginDialog v-if="currentPanType" v-model:visible="showPanLogin" :title="panLoginTitle"
      :pan-type="currentPanType" @success="onPanLoginSuccess" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Star, StarFilled, Film, Loading, Avatar, Picture, WarningFilled } from '@element-plus/icons-vue'
import { useAppStore } from '../store/app'
import { Database } from '../core/Database'
import { SubtitleSearch, type SubtitleSearchResult } from '../core/SubtitleSearch'
import { PanResolver, type PanType } from '../core/PanResolver'
import { PanLogin } from '../core/PanLogin'
import { QuarkPan } from '../core/QuarkPan'
import VideoPlayer from '../components/VideoPlayer.vue'
import QRLoginDialog from '../components/QRLoginDialog.vue'
import { processImageUrl } from '../core/models'

const route = useRoute()
const router = useRouter()
const store = useAppStore()

const loading = ref(true)
const activePlaySource = ref('')
const pendingPlayUrl = ref('')
const isFavorited = ref(false)
const sortOrder = ref<'asc' | 'desc'>('asc')
const quickSearchLoading = ref(false)
const activeEpisodeGroup = ref(0)
const videoPlayerRef = ref<InstanceType<typeof VideoPlayer> | null>(null)
const subtitleSearchVisible = ref(false)
const subtitleSearchResults = ref<SubtitleSearchResult[]>([])
const subtitleSearchLoading = ref(false)
const subtitleSearchQuery = ref('')
const descExpanded = ref(false)

function sanitizeHtml(html: string): string {
  if (!html) return ''
  let clean = html
  clean = clean.replace(/<script[\s\S]*?<\/script>/gi, '')
  clean = clean.replace(/<style[\s\S]*?<\/style>/gi, '')
  clean = clean.replace(/\son\w+="[^"]*"/gi, '')
  clean = clean.replace(/\son\w+='[^']*'/gi, '')
  clean = clean.replace(/\son\w+=\w+/gi, '')
  clean = clean.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"')
  const allowedTags = ['p', 'br', 'span', 'div', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'a']
  clean = clean.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tagName) => {
    const tag = tagName.toLowerCase()
    if (allowedTags.includes(tag)) {
      if (tag === 'a') {
        const hrefMatch = match.match(/href\s*=\s*["']([^"']+)["']/i)
        if (hrefMatch) {
          const href = hrefMatch[1]
          if (/^https?:\/\//i.test(href) || /^\/\//.test(href) || href.startsWith('#') || href.startsWith('/')) {
            return `<a href="${href}" target="_blank" rel="noopener noreferrer">`
          }
        }
        return match.replace(/<a\b[^>]*>/i, '<a>')
      }
      return match
    }
    return ''
  })
  return clean
}

function stripHtml(html: string): string {
  if (!html) return ''
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return tmp.textContent || tmp.innerText || ''
}

const sanitizedVodContent = computed(() => {
  return sanitizeHtml(store.currentVod?.vod_content || '')
})

const truncatedVodContent = computed(() => {
  const text = stripHtml(store.currentVod?.vod_content || '')
  if (text.length <= 200) return text
  return text.slice(0, 200) + '...'
})
const showPanLogin = ref(false)
const pendingPlayAfterLogin = ref<{ flag: string; url: string } | null>(null)
// Tracks the most recent playEpisode attempt so pan:loginExpired (fired by
// the main process when Quark cookie expires mid-playback) can retry after
// the user re-scans the QR code.
const lastPlayAttempt = ref<{ flag: string; url: string } | null>(null)
// Disposer for the pan:loginExpired IPC listener — called in onBeforeUnmount.
let panLoginExpiredDisposer: (() => void) | null = null

// Error state exposed by store — shown as inline prompts on the detail page.
const detailError = computed(() => store.detailError)
const playError = computed(() => store.playError)

// Retry loading detail (re-fetch from current source)
async function retryLoadDetail() {
  const sourceKey = route.params.sourceKey as string
  const vodId = route.params.vodId as string
  if (!sourceKey || !vodId) return
  store.detailError = ''
  store.playError = ''
  loading.value = true
  try {
    await store.loadDetail(vodId)
    if (store.currentVod && playSources.value.length > 0) {
      activePlaySource.value = playSources.value[0].name
      refreshPanLoginState(activePlaySource.value)
      // Initialize login state for all sources
      for (const source of playSources.value) {
        refreshPanLoginState(source.name)
      }
    }
  } catch {
    ElMessage.error('加载详情失败')
  } finally {
    loading.value = false
  }
}

const currentPanType = computed<'quark' | 'uc' | 'aliyun' | 'baidu' | 'bili' | '115' | undefined>(() => {
  const flag = activePlaySource.value
  const url = getFirstEpisodeUrl(flag)
  const type = PanResolver.detectPanType(flag, url)
  return type === 'unknown' ? undefined : type
})

const panLoginTitle = computed(() => {
  const type = currentPanType.value
  switch (type) {
    case 'quark':
      return '夸克网盘登录'
    case 'uc':
      return 'UC网盘登录'
    case 'aliyun':
      return '阿里云盘登录'
    case 'baidu':
      return '百度网盘登录'
    case 'bili':
      return 'B站登录'
    case '115':
      return '115网盘登录'
    default:
      return '网盘登录'
  }
})

function isPanSource(flag: string): boolean {
  // Prioritize URL/domain-based detection (more accurate than name matching,
  // which fails on obfuscated names like "B度" or renamed sources).
  // Check the source's episode URLs first.
  const source = playSources.value.find(s => s.name === flag)
  if (source?.episodes?.length) {
    const firstUrl = source.episodes[0].url || ''
    const typeByUrl = PanResolver.detectPanTypeFromUrl(firstUrl)
    if (typeByUrl !== 'unknown') {
      console.log('[Detail] isPanSource: URL match:', { flag, type: typeByUrl, url: firstUrl.substring(0, 80) })
      return true
    }
  }

  // Fallback to name-based detection (handles obfuscated names like "B度"
  // that the spider's vod_play_from uses despite the URL being a pan URL).
  const typeByName = PanResolver.detectPanType(flag, '')
  if (typeByName !== 'unknown') {
    console.log('[Detail] isPanSource: name match:', { flag, type: typeByName })
    return true
  }

  console.log('[Detail] isPanSource: no match:', { flag })
  return false
}

// 网盘登录状态缓存（按 source name 存储，响应式对象保证模板能感知变化）
const panLoginStates = reactive<Record<string, boolean>>({})

/** Get the first episode URL for a source flag, for URL-based pan detection */
function getFirstEpisodeUrl(flag: string): string {
  const source = playSources.value.find(s => s.name === flag)
  return source?.episodes?.[0]?.url || ''
}

function refreshPanLoginState(flag: string) {
  const url = getFirstEpisodeUrl(flag)
  const type = PanResolver.detectPanType(flag, url)
  if (type === 'unknown' || type === '115') {
    panLoginStates[flag] = false
    return
  }
  panLoginStates[flag] = PanLogin.isLoggedIn(type as import('../core/PanLogin').PanType)
}

function isPanLoggedIn(flag: string): boolean {
  return panLoginStates[flag] ?? false
}

// 登录状态轮询器：每2秒检查localStorage，解决跨组件响应式不可靠问题
let loginPollTimer: ReturnType<typeof setInterval> | null = null

function startLoginPolling() {
  stopLoginPolling()
  loginPollTimer = setInterval(() => {
    if (!activePlaySource.value) return
    const url = getFirstEpisodeUrl(activePlaySource.value)
    const type = PanResolver.detectPanType(activePlaySource.value, url)
    if (type === 'unknown' || type === '115') return
    const newState = PanLogin.isLoggedIn(type as import('../core/PanLogin').PanType)
    if (panLoginStates[activePlaySource.value] !== newState) {
      panLoginStates[activePlaySource.value] = newState
      console.log('[Detail] login poll updated:', { type, newState })
    }
  }, 2000)
}

function stopLoginPolling() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer)
    loginPollTimer = null
  }
}

async function playEpisode(flag: string, url: string) {
  console.log('[Detail] playEpisode ENTER:', {
    flag,
    urlPreview: url.substring(0, 80),
    isPan: isPanSource(flag),
    loginState: panLoginStates[flag],
    allLoginStates: { ...panLoginStates },
  })
  // Remember this attempt so pan:loginExpired can retry after re-login.
  lastPlayAttempt.value = { flag, url }
  // 不再阻止网盘源播放。Spider 的 SharedPreferences 中保存的 cookie 跨重启持久化，
  // 即使前端 localStorage 无登录数据，spider 仍可能持有有效 cookie。
  // 让 spider 尝试播放；若失败且为网盘源，再弹登录二维码。
  pendingPlayUrl.value = url
  store.playError = ''
  const currentSource = playSources.value.find(s => s.name === flag)
  const episodes = currentSource?.episodes || []
  const epIndex = episodes.findIndex(ep => ep.url === url)
  try {
    await store.loadPlay(flag, url, epIndex >= 0 ? epIndex : 0, episodes)
    console.log('[Detail] playEpisode: loadPlay completed, currentPlayUrl=', store.currentPlayUrl?.substring(0, 80))
    // 仅当播放失败且错误信息明确指向登录/鉴权时才弹登录框。
    // 格式不支持、资源失效、网络错误等不应误报「请登录」。
    if (!store.currentPlayUrl) {
      const err = (store.playError || '').toLowerCase()
      const needsLogin =
        /登录|login|未登录|auth|expired|cookie|令牌|token/.test(err) ||
        /Quark login expired|UC login expired/i.test(store.playError || '')
      if (needsLogin) {
        // 即使 isPanSource 未匹配（如源名使用变体"B度"），
        // 也从错误信息中检测网盘类型
        if (!isPanSource(flag)) {
          const panType = detectPanTypeFromError(store.playError || '', flag)
          if (panType) {
            console.log('[Detail] playEpisode: detected pan from error:', panType)
          }
        }
        console.log('[Detail] playEpisode: auth failure, showing login dialog')
        pendingPlayAfterLogin.value = { flag, url }
        showPanLogin.value = true
      } else if (isPanSource(flag)) {
        console.log(
          '[Detail] playEpisode: pan play failed but not auth-related:',
          store.playError,
        )
      }
    }
  } catch (e: any) {
    console.error('[Detail] playEpisode: loadPlay failed:', e)
    const msg = String(e?.message || e || '')
    if (
      /登录|login|未登录|expired|auth|cookie/i.test(msg)
    ) {
      // Fallback: if isPanSource doesn't catch but error mentions login
      if (!isPanSource(flag)) {
        const panType = detectPanTypeFromError(msg, flag)
        if (panType) {
          console.log('[Detail] playEpisode: detected pan from catch error:', panType)
        }
      }
      pendingPlayAfterLogin.value = { flag, url }
      showPanLogin.value = true
    } else {
      ElMessage.error(msg || '播放失败')
    }
  }
  finally { pendingPlayUrl.value = '' }
}

function onPanLoginSuccess() {
  ElMessage.success('登录成功')
  refreshPanLoginState(activePlaySource.value)
  if (pendingPlayAfterLogin.value) {
    const { flag, url } = pendingPlayAfterLogin.value
    pendingPlayAfterLogin.value = null
    playEpisode(flag, url)
  }
}

/**
 * Fallback: detect pan type from error message and/or flag.
 * Used when isPanSource() doesn't catch the flag (e.g., obfuscated names like "B度").
 */
function detectPanTypeFromError(error: string, flag: string): string | null {
  const text = `${error} ${flag}`
  const lower = text.toLowerCase()
  if (text.includes('百度') || lower.includes('baidu') || text.includes('B度')) return 'baidu'
  if (lower.includes('quark') || text.includes('夸克')) return 'quark'
  if (text.includes('uc') || text.includes('UC')) return 'uc'
  if (text.includes('阿里') || lower.includes('aliyun')) return 'aliyun'
  if (text.includes('b站') || lower.includes('bili') || lower.includes('bilibili')) return 'bili'
  if (text.includes('115')) return '115'
  return null
}

/**
 * Format play error message to be more user-friendly.
 * Maps common pan source names to their display names.
 */
function formatPlayError(error: string): string {
  if (!error) return ''

  let formatted = error

  return formatted
}

/**
 * Handle pan:loginExpired event from the main process.
 *
 * Fired when JarLoader detects Quark cookie expiry before playerContent, or
 * when ProxyServer.streamPanDirect gets a 412 from the Quark CDN. Shows a
 * warning, stashes the current play attempt for retry, and opens the QR
 * re-login dialog.
 */
function onPanLoginExpired(panType: string) {
  console.warn('[Detail] pan:loginExpired received, panType=', panType)
  if (panType !== 'quark' && panType !== 'uc' && panType !== 'baidu') return
  const labels: Record<string, string> = { uc: 'UC网盘', quark: '夸克网盘', baidu: '百度网盘' }
  const label = labels[panType] || panType
  ElMessage.warning(`${label}登录已失效，请重新扫码登录`)
  if (lastPlayAttempt.value) {
    pendingPlayAfterLogin.value = { ...lastPlayAttempt.value }
  }
  showPanLogin.value = true
}

const playSources = computed(() => {
  const vod = store.currentVod
  if (!vod?.vod_play_from || !vod?.vod_play_url) {
    console.log('[Detail] playSources empty:', {
      hasFrom: !!vod?.vod_play_from,
      hasUrl: !!vod?.vod_play_url,
      from: vod?.vod_play_from,
      url: vod?.vod_play_url,
      needPanLogin: (vod as any)?.needPanLogin,
    })
    return []
  }
  const sources = vod.vod_play_from.split('$$$')
  const urls = vod.vod_play_url.split('$$$')
  const result = sources.map((name, index) => {
    const urlGroup = urls[index] || ''
    const rawEps = urlGroup.split('#')
    let episodes = rawEps.map((ep, idx) => {
      const parts = ep.split('$')
      // Match Android SourceViewModel.java:962-969 behavior:
      // - If segment has '$', split into name$url
      // - If no '$', treat whole segment as URL and use numeric index as name
      if (parts.length >= 2) {
        return { name: parts[0] || '正片', url: parts[1] || '' }
      }
      return { name: String(idx + 1), url: parts[0] || '' }
    }).filter(ep => ep.url)
    if (sortOrder.value === 'desc') episodes = [...episodes].reverse()
    return { name, episodes }
  })
  console.log('[Detail] ========== playSources RAW DATA ==========')
  console.log('[Detail] vod_play_from (FULL):', vod.vod_play_from)
  console.log('[Detail] vod_play_url (FULL):', vod.vod_play_url)
  console.log('[Detail] playSources parsed:', {
    sourcesCount: sources.length,
    urlGroupCount: urls.length,
    sources,
    urlGroupLengths: urls.map(u => u.length),
    result: result.map(r => ({
      name: r.name,
      epCount: r.episodes.length,
      firstEp: r.episodes[0],
      lastEp: r.episodes[r.episodes.length - 1],
    })),
  })
  console.log('[Detail] ========== playSources RAW DATA END ==========')
  return result
})

// Currently playing episode name (e.g. "第01集"), empty when nothing is playing
const currentEpisodeName = computed(() => {
  if (!store.currentPlayUrl || store.currentEpisodes.length === 0) return ''
  const ep = store.currentEpisodes[store.currentPlayIndex]
  return ep?.name || ''
})

// Whether the current detail page needs pan login to show play data
const needPanLogin = computed(() => {
  return !!(store.currentVod as any)?.needPanLogin
})

// msearch: aggregator result — show cross-source search results as play sources
const isMsearchResult = computed(() => {
  return !!(store.currentVod as any)?.isMsearchResult
})

const msearchSearchGroups = computed(() => store.searchResults)

const msearchTotalCount = computed(() => {
  return store.searchResults.reduce((sum, g) => sum + g.list.length, 0)
})

function refreshMsearchSearch() {
  if (!store.currentVod?.vod_name) return
  store.doSearch(store.currentVod.vod_name).catch((e) => {
    console.warn('[Detail] refreshMsearchSearch failed:', e)
  })
}

function goToSourceDetail(siteKey: string, vodId: string) {
  console.log('[Detail] goToSourceDetail:', siteKey, vodId)
  router.push({ name: 'detail', params: { sourceKey: siteKey, vodId } })
}

function goToConfigCenter() {
  // Navigate to home page and force-select the config center
  router.replace('/')
  // Check if config center already exists in the site list, otherwise use hardcoded selection
  setTimeout(() => {
    const hasConfig = store.sites.some(s =>
      (s.key?.toLowerCase() === 'config') ||
      (s.name?.includes('配置')) ||
      (s.api?.toLowerCase().includes('config'))
    )
    if (hasConfig) {
      // Find the config site by key/name/api and select it
      const configSite = store.sites.find(s =>
        (s.key?.toLowerCase() === 'config') ||
        (s.name?.includes('配置')) ||
        (s.api?.toLowerCase().includes('config'))
      )
      if (configSite) {
        const uniqueKey = store.getUniqueKey(configSite)
        store.setActiveSite(uniqueKey)
        console.log('[Detail] goToConfigCenter: selected existing config site', uniqueKey)
      }
    } else {
      // No existing config site found — this should not happen in normal usage
      // We can't call setActiveSite with an object directly, so we just leave it
      // User will manually navigate to config center
      console.log('[Detail] goToConfigCenter: no config site found in site list')
    }
  }, 100)
}

// Title shown in the detail hero: "剧名" or "剧名 - 第01集" when playing
const pageTitle = computed(() => {
  const name = store.currentVod?.vod_name || ''
  return currentEpisodeName.value ? `${name} - ${currentEpisodeName.value}` : name
})

// Title passed to the VideoPlayer component (includes episode name when playing)
const playerTitle = computed(() => {
  const name = store.currentVod?.vod_name || ''
  return currentEpisodeName.value ? `${name} - ${currentEpisodeName.value}` : name
})

const GROUP_SIZE_THRESHOLD = 40
const GROUP_SIZE = 40

interface EpisodeGroup { label: string; start: number; end: number }

function getEpisodeGroups(episodes: { name: string; url: string }[]): EpisodeGroup[] {
  if (episodes.length <= GROUP_SIZE_THRESHOLD) return [{ label: '全部', start: 0, end: episodes.length }]
  const groups: EpisodeGroup[] = []
  for (let i = 0; i < episodes.length; i += GROUP_SIZE) {
    const start = i
    const end = Math.min(i + GROUP_SIZE, episodes.length)
    groups.push({ label: `${start + 1}-${end}`, start, end })
  }
  return groups
}

function getVisibleEpisodes(episodes: { name: string; url: string }[]) {
  const groups = getEpisodeGroups(episodes)
  if (groups.length <= 1) return episodes
  const group = groups[activeEpisodeGroup.value] || groups[0]
  return episodes.slice(group.start, group.end)
}

function isEpisodeActive(episodes: { name: string; url: string }[], visibleIndex: number): boolean {
  if (store.currentEpisodes.length === 0) return false
  const groups = getEpisodeGroups(episodes)
  const group = groups[activeEpisodeGroup.value] || groups[0]
  const globalIndex = group.start + visibleIndex
  return globalIndex === store.currentPlayIndex
}

watch([() => store.currentPlayUrl, playSources], () => {
  if (!store.currentPlayUrl) return
  for (const source of playSources.value) {
    const idx = source.episodes.findIndex(ep => ep.url === store.currentPlayUrl)
    if (idx >= 0 && source.episodes.length > GROUP_SIZE_THRESHOLD) {
      const targetGroup = Math.floor(idx / GROUP_SIZE)
      if (activeEpisodeGroup.value !== targetGroup) activeEpisodeGroup.value = targetGroup
      break
    }
  }
})

// Refresh pan login state when user switches source tab
watch(activePlaySource, (newFlag) => {
  if (newFlag) {
    refreshPanLoginState(newFlag)
  }
})

onMounted(async () => {
  const sourceKey = route.params.sourceKey as string
  const vodId = route.params.vodId as string
  if (!sourceKey || !vodId) {
    router.replace('/')
    return
  }
  store.setActiveSite(sourceKey)
  // Refresh login status cache from JAR so pan-login checks are accurate.
  // The JAR is the single source of truth — the PC never persists credentials.
  try {
    await PanLogin.refreshAllStatuses()
  } catch (e: any) {
    console.warn('[Detail] refreshAllStatuses failed:', e.message)
  }
  // Listen for pan:loginExpired from the main process (fired when Quark
  // cookie expires mid-playback). Use the same ipcRenderer access pattern
  // as PanLogin.ts for consistency.
  try {
    const { ipcRenderer } = require('electron')
    const handler = (_event: any, panType: string) => onPanLoginExpired(panType)
    ipcRenderer.on('pan:loginExpired', handler)
    panLoginExpiredDisposer = () => {
      ipcRenderer.removeListener('pan:loginExpired', handler)
    }
  } catch (e: any) {
    console.warn('[Detail] Failed to register pan:loginExpired listener:', e.message)
  }
  try {
    await store.loadDetail(vodId)
    if (store.currentVod && playSources.value.length > 0) {
      activePlaySource.value = playSources.value[0].name
      refreshPanLoginState(activePlaySource.value)
      // Initialize login state for all sources
      for (const source of playSources.value) {
        refreshPanLoginState(source.name)
      }
    }
    // 启动轮询，每2秒检测localStorage中的登录状态变化
    startLoginPolling()
    if (store.currentVod) {
      isFavorited.value = await Database.isFavorite(sourceKey, vodId)
    }
  } catch {
    ElMessage.error('加载详情失败')
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  stopLoginPolling()
  if (panLoginExpiredDisposer) {
    panLoginExpiredDisposer()
    panLoginExpiredDisposer = null
  }
  // 清除播放状态，避免下一个视频显示错误的"播放到第X集"
  store.currentPlayUrl = ''
  store.currentPlayIndex = 0
  store.currentEpisodes = []
  store.resumeProgress = 0
  store.detailError = ''
  store.playError = ''
})

async function onPrevEpisode() {
  const prevUrl = store.playPrevEpisode()
  if (prevUrl) {
    try { await store.loadPlay(store.currentPlayFlag, prevUrl, store.currentPlayIndex, store.currentEpisodes) }
    catch { ElMessage.error('播放失败') }
  }
}

async function onNextEpisode() {
  const nextUrl = store.playNextEpisode()
  if (nextUrl) {
    try { await store.loadPlay(store.currentPlayFlag, nextUrl, store.currentPlayIndex, store.currentEpisodes) }
    catch { ElMessage.error('播放失败') }
  }
}

function onPlayEnded() {
  if (store.autoPlayNext && store.currentPlayIndex < store.currentEpisodes.length - 1) onNextEpisode()
}

function onProgress(time: number, duration: number) { store.savePlayProgress(time, duration) }

function toggleSortOrder() { sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc' }

function copyPlayUrl() {
  if (!store.currentPlayUrl) return
  navigator.clipboard.writeText(store.currentPlayUrl)
    .then(() => ElMessage.success('播放地址已复制'))
    .catch(() => ElMessage.error('复制失败'))
}

async function handleQuickSearch() {
  if (!store.currentVod?.vod_name) return
  quickSearchLoading.value = true
  try {
    await store.doSearch(store.currentVod.vod_name)
    ElMessage.success(`已搜索"${store.currentVod.vod_name}"，共 ${store.searchResults.length} 个源有结果`)
  } catch { ElMessage.error('搜索失败') }
  finally { quickSearchLoading.value = false }
}

async function handleToggleFavorite() {
  if (!store.currentVod) return
  try {
    const sourceKey = store.currentVod.sourceKey || (route.params.sourceKey as string)
    await store.toggleFavorite(store.currentVod, sourceKey)
    isFavorited.value = !isFavorited.value
    ElMessage.success(isFavorited.value ? '已收藏' : '已取消收藏')
  } catch { ElMessage.error('操作失败') }
}

function cacheVideo() {
  // TODO: Implement video caching functionality
  ElMessage.info('缓存功能开发中...')
}

async function onSearchSubtitle() {
  if (!store.currentVod?.vod_name) return
  subtitleSearchVisible.value = true
  subtitleSearchQuery.value = store.currentVod.vod_name
  subtitleSearchLoading.value = true
  try { subtitleSearchResults.value = await SubtitleSearch.search(store.currentVod.vod_name) }
  catch { subtitleSearchResults.value = [] }
  finally { subtitleSearchLoading.value = false }
}

async function retrySubtitleSearch() {
  const query = subtitleSearchQuery.value.trim()
  if (!query) return
  subtitleSearchLoading.value = true
  try { subtitleSearchResults.value = await SubtitleSearch.search(query) }
  catch { subtitleSearchResults.value = [] }
  finally { subtitleSearchLoading.value = false }
}

async function onSelectSubtitle(item: SubtitleSearchResult) {
  try {
    const content = await SubtitleSearch.fetchSubtitle(item.url)
    if (content && videoPlayerRef.value) {
      videoPlayerRef.value.loadSubtitleContent(content)
      subtitleSearchVisible.value = false
      ElMessage.success('字幕已加载')
    } else { ElMessage.warning('无法加载该字幕（可能是压缩格式）') }
  } catch { ElMessage.error('字幕加载失败') }
}
</script>

<style scoped>
/* Hero section with blurred poster */
.detail-hero {
  min-height: 420px;
}

/* Gradient overlay - fades from solid base to transparent */
.detail-hero-overlay {
  background: linear-gradient(to right,
      var(--color-bg-base) 0%,
      var(--color-bg-base) 40%,
      var(--color-bg-glass-heavy) 70%,
      var(--color-bg-glass) 100%);
}

/* Blur layer over the poster image */
.detail-hero-blur {
  backdrop-filter: blur(20px) saturate(120%);
  -webkit-backdrop-filter: blur(20px) saturate(120%);
}

.detail-poster-shadow {
  box-shadow: var(--surface-floating-shadow);
}

.detail-player-shadow {
  box-shadow: var(--surface-floating-shadow);
}

/* Description area */
.detail-desc {
  backdrop-filter: blur(4px);
}

.detail-desc-content {
  line-height: 1.7;
}

.detail-desc-content :deep(p) {
  margin: 0 0 12px 0;
}

.detail-desc-content :deep(p:last-child) {
  margin-bottom: 0;
}

.detail-desc-content :deep(ul),
.detail-desc-content :deep(ol) {
  margin: 12px 0;
  padding-left: 24px;
}

.detail-desc-content :deep(ul) {
  list-style-type: disc;
}

.detail-desc-content :deep(ol) {
  list-style-type: decimal;
}

.detail-desc-content :deep(li) {
  margin: 4px 0;
}

.detail-desc-content :deep(a) {
  color: var(--color-primary);
  text-decoration: none;
  transition: opacity 0.2s;
}

.detail-desc-content :deep(a:hover) {
  opacity: 0.8;
  text-decoration: underline;
}

.detail-desc-content :deep(strong),
.detail-desc-content :deep(b) {
  font-weight: 600;
  color: var(--color-text-primary);
}

.detail-desc-content :deep(em),
.detail-desc-content :deep(i) {
  font-style: italic;
}

.detail-desc-content :deep(u) {
  text-decoration: underline;
}

.detail-desc-content :deep(h1),
.detail-desc-content :deep(h2),
.detail-desc-content :deep(h3),
.detail-desc-content :deep(h4),
.detail-desc-content :deep(h5),
.detail-desc-content :deep(h6) {
  margin: 16px 0 8px 0;
  font-weight: 600;
  color: var(--color-text-primary);
}

.detail-desc-content :deep(h1) {
  font-size: 1.5rem;
}

.detail-desc-content :deep(h2) {
  font-size: 1.25rem;
}

.detail-desc-content :deep(h3) {
  font-size: 1.125rem;
}

.detail-desc-content :deep(blockquote) {
  margin: 12px 0;
  padding: 8px 16px;
  border-left: 3px solid var(--color-primary);
  background: var(--color-bg-elevated);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

.detail-desc-content :deep(br) {
  content: '';
  display: block;
  margin: 4px 0;
}

/* Episode grid: responsive multi-column layout */
.ep-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.75rem;
}

/* msearch cross-source search results grid */
.msearch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.75rem;
}

.msearch-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem;
  background: var(--color-bg-glass);
  border: var(--color-border);
  border-radius: var(--radius-md, 10px);
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: left;
}

.msearch-card:hover {
  background: var(--color-bg-glass-heavy);
  border-color: var(--color-primary-border);
  transform: translateY(-2px);
}

.msearch-card-poster {
  width: 100%;
  aspect-ratio: 2/3;
  object-fit: cover;
  border-radius: var(--radius-sm, 6px);
  background: var(--color-bg-elevated);
}

.msearch-card-poster-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
}

.msearch-card-info {
  min-width: 0;
}

.msearch-card-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.msearch-card-remarks {
  font-size: 11px;
  color: var(--color-text-tertiary);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (min-width: 640px) {
  .ep-grid {
    grid-template-columns: repeat(6, 1fr);
  }
}

@media (min-width: 768px) {
  .ep-grid {
    grid-template-columns: repeat(8, 1fr);
  }
}

@media (min-width: 1024px) {
  .ep-grid {
    grid-template-columns: repeat(10, 1fr);
  }
}

@media (min-width: 1280px) {
  .ep-grid {
    grid-template-columns: repeat(12, 1fr);
  }
}

/* Episode buttons */
.ep-btn {
  background: var(--color-bg-glass);
  color: var(--color-text-secondary);
  border: var(--color-border);
  height: 44px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
}

/* Episode name: truncate long names */
.ep-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}

.ep-btn:hover:not(:disabled) {
  background: var(--color-bg-glass-heavy);
  color: var(--color-text-primary);
  border-color: var(--color-primary-border);
}

.ep-btn-active {
  background: var(--color-primary) !important;
  color: #fff !important;
  border-color: var(--color-primary) !important;
  box-shadow: 0 0 16px var(--color-primary-glow);
}

.ep-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Player enter animation */
.player-enter-container {
  overflow: hidden;
}

.player-enter-animation {
  animation: playerSlideDown 0.5s ease-out forwards;
  transform-origin: top center;
}

@keyframes playerSlideDown {
  0% {
    opacity: 0;
    max-height: 0;
    transform: scaleY(0.3);
  }

  50% {
    opacity: 0.8;
    transform: scaleY(1.02);
  }

  100% {
    opacity: 1;
    max-height: 100vh;
    transform: none;
  }
}

/* Play Error Dialog */
.play-error-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(12px) saturate(1.1);
  -webkit-backdrop-filter: blur(12px) saturate(1.1);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9998;
}

.play-error-card {
  position: relative;
  width: 400px;
  max-width: calc(100vw - 32px);
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: var(--glass-border);
  border-radius: var(--radius-lg);
  padding: 32px 28px 24px;
  box-shadow: var(--surface-modal-shadow);
  text-align: center;
}

.play-error-glow {
  position: absolute;
  top: -80px;
  right: -60px;
  width: 200px;
  height: 200px;
  background: radial-gradient(circle at 30% 40%, rgba(239, 68, 68, 0.18), rgba(239, 68, 68, 0.05) 50%, transparent 70%);
  pointer-events: none;
  animation: play-error-glow-pulse 3s ease-in-out infinite;
}

@keyframes play-error-glow-pulse {

  0%,
  100% {
    opacity: 0.5;
    transform: scale(1);
  }

  50% {
    opacity: 0.9;
    transform: scale(1.1);
  }
}

.play-error-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 18px;
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(239, 68, 68, 0.08));
  color: #f87171;
  margin-bottom: 16px;
  animation: play-error-icon-pulse 2s ease-in-out infinite;
}

@keyframes play-error-icon-pulse {

  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.15);
  }

  50% {
    box-shadow: 0 0 0 8px rgba(239, 68, 68, 0.05);
  }
}

.play-error-title {
  font-size: 18px;
  font-weight: 600;
  color: #f1f5f9;
  margin: 0 0 6px;
}

.play-error-source {
  font-size: 12px;
  color: #64748b;
  margin: 0 0 12px;
  padding: 4px 12px;
  background: rgba(100, 116, 139, 0.15);
  border-radius: 6px;
  display: inline-block;
}

.play-error-message {
  font-size: 14px;
  color: #94a3b8;
  margin: 0 0 24px;
  line-height: 1.5;
}

.play-error-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
}

.play-error-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 28px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.22, 1, 0.36, 1);
  border: none;
  outline: none;
}

.play-error-btn-primary {
  background: var(--color-primary);
  color: var(--color-bg-base);
  box-shadow: 0 4px 16px var(--color-primary-glow);
}

.play-error-btn-primary:hover {
  background: var(--color-primary-hover);
  box-shadow: 0 6px 20px var(--color-primary-glow);
  transform: translateY(-1px);
}

.play-error-btn-primary:active {
  transform: translateY(0) scale(0.97);
}

/* Dialog animations */
.play-error-dialog-enter-active {
  transition: opacity 0.2s ease;
}

.play-error-dialog-leave-active {
  transition: opacity 0.15s ease;
}

.play-error-dialog-enter-active .play-error-card {
  transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease;
}

.play-error-dialog-leave-active .play-error-card {
  transition: transform 0.12s ease, opacity 0.1s ease;
}

.play-error-dialog-enter-from,
.play-error-dialog-leave-to {
  opacity: 0;
}

.play-error-dialog-enter-from .play-error-card {
  opacity: 0;
  transform: translateY(20px) scale(0.94);
}

.play-error-dialog-leave-to .play-error-card {
  opacity: 0;
  transform: translateY(-8px) scale(0.97);
}

/* Subtitle Search Dialog */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 250ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.subsearch-overlay {
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

.subsearch-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0;
  max-width: 500px;
  width: calc(100vw - 32px);
  max-height: 80vh;
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: var(--glass-border);
  border-radius: var(--radius-lg, 14px);
  box-shadow: var(--surface-modal-shadow);
  overflow: hidden;
}

.subsearch-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 24px 16px;
}

.subsearch-title {
  font-size: var(--text-lg, 17px);
  font-weight: 600;
  color: var(--color-text-primary);
  line-height: 1.2;
  margin: 0;
}

.subsearch-close {
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

.subsearch-close:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-elevated);
}

.subsearch-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 38px;
  margin: 0 24px 16px;
  width: calc(100% - 48px);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  padding: 0 12px;
  transition: border-color 150ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
}

.subsearch-input-row:focus-within {
  border-color: var(--color-border-active);
}

.subsearch-input-icon {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
}

.subsearch-input {
  background: transparent;
  border: none;
  outline: none;
  flex: 1;
  font-size: var(--text-sm, 13px);
  color: var(--color-text-primary);
  caret-color: var(--color-primary);
}

.subsearch-input::placeholder {
  color: var(--color-text-disabled);
}

.subsearch-divider {
  height: 1px;
  background: var(--color-border);
  margin: 0 24px;
}

.subsearch-list {
  display: flex;
  flex-direction: column;
  padding: 8px 0;
  overflow-y: auto;
  max-height: 400px;
}

.subsearch-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 0;
}

.subsearch-empty-text {
  font-size: var(--text-sm, 13px);
  color: var(--color-text-tertiary);
  margin: 0;
}

.subsearch-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  cursor: pointer;
  transition: background 150ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
}

.subsearch-item:hover {
  background: var(--color-bg-glass-light);
}

.subsearch-item-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.subsearch-item-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.subsearch-item-name {
  font-size: var(--text-sm, 13px);
  font-weight: 500;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.subsearch-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  flex-shrink: 0;
  height: 20px;
  padding: 0 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  border-radius: var(--radius-sm, 6px);
}

.subsearch-badge-zip {
  color: var(--state-warning, #fbbf24);
  background: rgba(251, 191, 36, 0.15);
}

.subsearch-badge-sub {
  color: var(--state-info, #60a5fa);
  background: rgba(96, 165, 250, 0.15);
}

.subsearch-item-meta {
  font-size: var(--text-xs, 11px);
  color: var(--color-text-tertiary);
}

.subsearch-load-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  flex-shrink: 0;
  height: 30px;
  padding: 0 14px;
  font-size: var(--text-xs, 11px);
  font-weight: 600;
  color: var(--color-primary);
  background: var(--color-primary-soft);
  border: none;
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  transition: background 150ms var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
}

.subsearch-load-btn:hover {
  background: color-mix(in srgb, var(--color-primary) 22%, transparent);
}

.subsearch-load-btn:active {
  transform: scale(0.96);
}
</style>
