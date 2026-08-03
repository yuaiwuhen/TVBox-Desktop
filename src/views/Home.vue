<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <!-- Empty state -->
    <div v-if="store.sites.length === 0" class="flex-1 flex flex-col items-center justify-center"
      style="color: var(--color-text-tertiary)">
      <el-icon :size="64">
        <Box />
      </el-icon>
      <p class="text-lg mt-4">请先前往设置页面加载配置源</p>
      <el-button type="primary" class="mt-4" @click="$router.push('/settings')">去设置</el-button>
    </div>

    <div v-else class="flex-1 flex flex-col overflow-hidden">
      <div ref="scrollContainer" class="flex-1 overflow-auto p-4" @scroll="onScroll">
        <!-- Home Loading -->
        <div v-if="store.homeLoading && store.homeVodList.length === 0">
          <el-skeleton :rows="6" animated />
        </div>

        <template v-else>
          <!-- Config Center: embed JAR's wexconfig page directly.
               Falls back to the pan login grid when the spider fails to
               load (e.g. itv666 awdm-v8.so is ARM-only on Windows x64) OR
               when the iframe URL returns empty/non-HTML body (itv666,
               feimao). The pan login grid is in homeVodList (built by
               buildConfigCenterVodList) and renders via the v-else branch. -->
          <div v-if="isConfigCenter && store.configCenterSpiderLoaded && !configCenterIframeEmpty" class="config-center-iframe-wrapper">
            <div class="flex items-center justify-between mb-4 px-1">
              <h2 class="text-lg font-semibold" style="color: var(--color-text-primary)">配置中心</h2>
              <el-button size="small" :loading="store.homeLoading" @click="refreshConfigCenter">
                <el-icon>
                  <Refresh />
                </el-icon>
                <span class="ml-1">刷新</span>
              </el-button>
            </div>
            <div v-if="configCenterLoading" class="flex-1 flex flex-col items-center justify-center py-20"
              style="color: var(--color-text-tertiary)">
              <el-icon :size="32" class="rotating" style="color: var(--color-primary)">
                <Loading />
              </el-icon>
              <p class="mt-3 text-sm">正在加载配置页面...</p>
            </div>
            <div v-else-if="configCenterError" class="flex-1 flex flex-col items-center justify-center py-20"
              style="color: var(--color-text-tertiary)">
              <el-icon :size="32" color="#f56c6c">
                <Box />
              </el-icon>
              <p class="mt-3 text-sm" style="color: var(--color-danger)">{{ configCenterError }}</p>
              <el-button class="mt-3" size="small" @click="loadConfigCenterUrl">重试</el-button>
            </div>
            <iframe
              v-else-if="configCenterUrl"
              :src="configCenterUrl"
              class="config-center-iframe"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              @load="onConfigCenterIframeLoad"
            />
          </div>

          <!-- Normal content (non-config-center) -->
          <template v-else>
          <!-- Config center fallback header (when iframe is empty/failing) -->
          <div v-if="isConfigCenter && configCenterIframeEmpty" class="flex items-center justify-between mb-4 px-1">
            <h2 class="text-lg font-semibold" style="color: var(--color-text-primary)">配置中心</h2>
            <el-button size="small" :loading="store.homeLoading" @click="refreshConfigCenter">
              <el-icon>
                <Refresh />
              </el-icon>
              <span class="ml-1">刷新</span>
            </el-button>
          </div>
          <!-- Category Tabs (horizontally scrollable) -->
          <div v-if="displayClasses.length > 0" class="mb-4 flex items-center gap-2 pb-2">
            <div class="flex-1 overflow-x-auto flex gap-2 scrollbar-hide">
              <button v-for="cls in displayClasses" :key="cls.type_id"
                class="category-pill px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-200 flex-shrink-0 cursor-pointer"
                :class="{ 'category-pill-active': activeCategory === cls.type_id }"
                @click="onCategoryChange(cls.type_id)">{{ cls.type_name }}</button>
            </div>
            <!-- View mode toggle (only for sources that support it) -->
            <div v-if="sourceStyle.supportsViewToggle" class="flex items-center gap-1 p-1 flex-shrink-0"
              style="background: var(--color-bg-glass); border: var(--glass-border); border-radius: var(--radius-md, 8px)">
              <button class="view-toggle-btn p-1.5 rounded-md transition-all cursor-pointer"
                :class="{ 'view-toggle-active': viewMode === 'card' }"
                :title="'卡片视图'" @click="setViewMode('card')">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="3" width="7" height="7"></rect>
                  <rect x="14" y="3" width="7" height="7"></rect>
                  <rect x="3" y="14" width="7" height="7"></rect>
                  <rect x="14" y="14" width="7" height="7"></rect>
                </svg>
              </button>
              <button class="view-toggle-btn p-1.5 rounded-md transition-all cursor-pointer"
                :class="{ 'view-toggle-active': viewMode === 'list' }"
                :title="'列表视图'" @click="setViewMode('list')">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round">
                  <line x1="8" y1="6" x2="21" y2="6"></line>
                  <line x1="8" y1="12" x2="21" y2="12"></line>
                  <line x1="8" y1="18" x2="21" y2="18"></line>
                  <line x1="3" y1="6" x2="3.01" y2="6"></line>
                  <line x1="3" y1="12" x2="3.01" y2="12"></line>
                  <line x1="3" y1="18" x2="3.01" y2="18"></line>
                </svg>
              </button>
            </div>
          </div>

          <!-- Pan folder breadcrumb (Quark-style navigation path) -->
          <div v-if="panFolderStack.length > 0" class="mb-3 flex items-center gap-1.5 px-2 py-1.5 rounded-lg"
            style="background: var(--color-bg-glass); border: var(--glass-border)">
            <button class="pan-breadcrumb-back flex items-center gap-1 px-2 py-1 rounded text-sm transition-colors"
              style="color: var(--color-text-secondary)"
              @click="navigateBackPanFolder">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
              <span>返回</span>
            </button>
            <div class="w-px h-4" style="background: var(--color-border)"></div>
            <div class="flex items-center gap-1 overflow-x-auto scrollbar-hide flex-1">
              <button class="px-2 py-1 rounded text-sm whitespace-nowrap transition-colors"
                :style="{
                  color: panFolderStack.length === 1 ? 'var(--color-primary)' : 'var(--color-text-tertiary)',
                  fontWeight: panFolderStack.length === 1 ? '500' : 'normal'
                }"
                @click="panFolderStack.length > 1 && navigateBackToIndex(0)">
                {{ panFolderStack[0].name }}
              </button>
              <template v-for="(entry, idx) in panFolderStack.slice(1)" :key="idx">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"
                  style="color: var(--color-text-tertiary); flex-shrink: 0">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
                <button class="px-2 py-1 rounded text-sm whitespace-nowrap transition-colors"
                  :style="{
                    color: idx === panFolderStack.length - 2 ? 'var(--color-primary)' : 'var(--color-text-tertiary)',
                    fontWeight: idx === panFolderStack.length - 2 ? '500' : 'normal'
                  }"
                  @click="idx < panFolderStack.length - 2 && navigateBackToIndex(idx + 1)">
                  {{ entry.name }}
                </button>
              </template>
            </div>
          </div>

          <!-- Category Loading -->
          <div v-if="store.categoryLoading && displayVodList.length === 0">
            <el-skeleton :rows="6" animated />
          </div>

          <!-- ===== MUSIC/AUDIO LIST LAYOUT (album-art style rows) ===== -->
          <div v-else-if="displayVodList.length > 0 && effectiveLayout === 'list' && (sourceStyle.type === 'music' || sourceStyle.type === 'audio')"
            class="music-list flex flex-col gap-1.5">
            <div v-for="(vod, idx) in displayVodList" :key="vod.vod_id"
              class="music-item cursor-pointer group flex items-center gap-4 p-2.5 transition-all duration-200"
              :class="{ 'music-item-action': vod.action }"
              @click="handleVodClick(vod)">
              <!-- Track number / album art -->
              <div class="flex-shrink-0 relative overflow-hidden music-cover"
                style="width: 56px; height: 56px; border-radius: 8px; background: var(--color-bg-elevated)">
                <img v-if="vod.vod_pic" :src="processImageUrl(vod.vod_pic)"
                  class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" loading="lazy" />
                <div v-else class="w-full h-full flex items-center justify-center"
                  style="color: var(--color-primary); background: var(--color-primary-soft)">
                  <el-icon :size="22"><Headset /></el-icon>
                </div>
                <!-- Track index overlay (shown by default, hidden on hover) -->
                <div v-if="!vod.vod_pic" class="absolute inset-0 flex items-center justify-center text-xs font-medium"
                  style="color: var(--color-text-tertiary); background: var(--color-bg-elevated)">
                  {{ String(idx + 1).padStart(2, '0') }}
                </div>
                <!-- Hover play overlay -->
                <div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                  style="background: rgba(0,0,0,0.55); backdrop-filter: blur(2px)">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="white">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </div>
              <!-- Title + artist + remarks -->
              <div class="flex-1 min-w-0 flex flex-col gap-1">
                <p class="text-sm font-medium truncate" style="color: var(--color-text-primary)" :title="vod.vod_name">
                  {{ vod.vod_name }}
                </p>
                <div class="flex items-center gap-2 text-xs" style="color: var(--color-text-tertiary)">
                  <span v-if="vod.vod_actor" class="truncate">{{ vod.vod_actor }}</span>
                  <span v-if="vod.vod_actor && vod.vod_remarks">·</span>
                  <span v-if="vod.vod_remarks" class="truncate">{{ vod.vod_remarks }}</span>
                </div>
              </div>
              <!-- Duration / play count -->
              <div v-if="vod.vod_remarks && !vod.vod_actor" class="flex-shrink-0 text-xs px-2 py-0.5 rounded"
                style="color: var(--color-text-tertiary); background: var(--color-bg-elevated)">
                {{ vod.vod_remarks }}
              </div>
              <!-- Hover play button -->
              <div class="flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-full transition-all opacity-0 group-hover:opacity-100"
                style="background: var(--color-primary); color: white; box-shadow: 0 2px 12px var(--color-primary-glow)">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </div>
          </div>

          <!-- ===== PAN LIST LAYOUT (file-browser style — Quark netdisk) ===== -->
          <div v-else-if="displayVodList.length > 0 && effectiveLayout === 'list' && sourceStyle.type === 'pan'"
            class="pan-list flex flex-col gap-1">
            <!-- Column header (Quark-style) — hidden for config center login items -->
            <div v-if="!isConfigCenter" class="pan-list-header flex items-center gap-3 px-3 py-2 text-xs font-medium"
              style="color: var(--color-text-tertiary); border-bottom: 1px solid var(--color-border)">
              <div class="flex-shrink-0" style="width: 44px">类型</div>
              <div class="flex-1">名称</div>
              <div class="flex-shrink-0" style="width: 100px">备注</div>
              <div class="flex-shrink-0" style="width: 32px"></div>
            </div>
            <div v-for="vod in displayVodList" :key="vod.vod_id"
              class="pan-list-item cursor-pointer group flex items-center gap-3 px-3 py-2.5 transition-all duration-150"
              :class="{ 'pan-list-item-action': vod.action }"
              style="border-radius: 8px"
              @click="handleVodClick(vod)">
              <!-- File type icon (folder/file/login) -->
              <div class="flex-shrink-0 flex items-center justify-center" style="width: 44px; height: 36px">
                <svg v-if="vod.action" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5"
                  :style="{ color: vod.action.startsWith('del') ? '#10b981' : '#3b82f6' }">
                  <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/>
                  <path d="M12 6v6l4 2"/>
                </svg>
                <svg v-else-if="isPanFolderItem(vod)" viewBox="0 0 24 24" width="32" height="32" fill="#f59e0b">
                  <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                </svg>
                <svg v-else viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5"
                  style="color: var(--color-text-tertiary)">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
              </div>
              <!-- File name + tag badges -->
              <div class="flex-1 min-w-0 flex flex-col gap-0.5">
                <p class="text-sm font-medium truncate" style="color: var(--color-text-primary)" :title="vod.vod_name">
                  {{ vod.vod_name }}
                </p>
                <div v-if="vod.type_name || vod.vod_year" class="flex items-center gap-2 text-xs" style="color: var(--color-text-tertiary)">
                  <span v-if="vod.type_name">{{ vod.type_name }}</span>
                  <span v-if="vod.type_name && vod.vod_year">·</span>
                  <span v-if="vod.vod_year">{{ vod.vod_year }}</span>
                </div>
              </div>
              <!-- Right column: remarks / size / status -->
              <div class="flex-shrink-0" style="width: 100px">
                <span v-if="vod.vod_remarks" class="text-xs px-2 py-1 rounded inline-block truncate"
                  style="color: var(--color-text-tertiary); background: var(--color-bg-elevated; max-width: 100px"
                  :title="vod.vod_remarks">{{ vod.vod_remarks }}</span>
              </div>
              <!-- Action menu (three dots) -->
              <div class="flex-shrink-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                style="width: 32px; color: var(--color-text-tertiary)">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
                </svg>
              </div>
              <!-- Login status badge for pan actions -->
              <div v-if="vod.action" class="flex-shrink-0 text-xs px-2 py-1 rounded"
                :style="{
                  background: vod.action.startsWith('del') ? 'rgba(16,185,129,0.12)' : 'var(--color-primary-soft)',
                  color: vod.action.startsWith('del') ? '#10b981' : 'var(--color-primary)'
                }">
                {{ vod.action.startsWith('del') ? '已登录' : '点击登录' }}
              </div>
            </div>
          </div>

          <!-- ===== GENERIC LIST LAYOUT (fallback for other list-type sources) ===== -->
          <div v-else-if="displayVodList.length > 0 && effectiveLayout === 'list'" class="flex flex-col gap-2">
            <div v-for="vod in displayVodList" :key="vod.vod_id"
              class="list-card cursor-pointer group flex items-center gap-3 p-3 transition-all duration-200"
              :class="{ 'list-card-action': vod.action }"
              style="background: var(--color-bg-glass); border: var(--glass-border); border-radius: var(--radius-md, 10px)"
              @click="handleVodClick(vod)">
              <!-- Thumbnail (square) -->
              <div class="flex-shrink-0 overflow-hidden relative"
                style="width: 56px; height: 56px; border-radius: var(--radius-sm, 6px); background: var(--color-bg-elevated)">
                <img v-if="vod.vod_pic" :src="processImageUrl(vod.vod_pic)"
                  class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" loading="lazy" />
                <div v-else class="w-full h-full flex items-center justify-center"
                  style="color: var(--color-text-tertiary)">
                  <el-icon :size="20"><Film /></el-icon>
                </div>
              </div>
              <!-- Title + meta -->
              <div class="flex-1 min-w-0 flex flex-col gap-0.5">
                <p class="text-sm font-medium truncate" style="color: var(--color-text-primary)" :title="vod.vod_name">
                  {{ vod.vod_name }}
                </p>
                <p v-if="vod.vod_remarks" class="text-xs truncate" style="color: var(--color-text-tertiary)">
                  {{ vod.vod_remarks }}
                </p>
              </div>
              <!-- Action hint for pan sources -->
              <div v-if="vod.action" class="flex-shrink-0 text-xs px-2 py-1 rounded"
                style="background: var(--color-primary-soft); color: var(--color-primary)">
                {{ vod.action.startsWith('del') ? '已登录' : '点击登录' }}
              </div>
            </div>
          </div>

          <!-- ===== CHILDREN GRID LAYOUT (bright, playful, square cards) ===== -->
          <div v-else-if="displayVodList.length > 0 && sourceStyle.type === 'children'" :class="[
            'grid gap-3',
            gridColsClass,
          ]">
            <div v-for="vod in displayVodList" :key="vod.vod_id"
              class="children-card cursor-pointer group" @click="handleVodClick(vod)">
              <div class="relative overflow-hidden children-poster"
                :style="{ aspectRatio: sourceStyle.ratio }">
                <img v-if="vod.vod_pic" :src="processImageUrl(vod.vod_pic)"
                  class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" loading="lazy" />
                <div v-else class="w-full h-full flex items-center justify-center"
                  style="background: linear-gradient(135deg, #ffeaa7 0%, #fab1a0 100%)">
                  <el-icon :size="36" style="color: #d63031"><Star /></el-icon>
                </div>
                <!-- Category badge (top-left) -->
                <div v-if="vod.type_name || vod.vod_remarks"
                  class="absolute top-2 left-2 children-badge">
                  <span class="text-[10px] font-bold px-2 py-0.5 rounded-full"
                    style="background: rgba(255,255,255,0.95); color: #ff6b6b; box-shadow: 0 1px 4px rgba(0,0,0,0.15)">
                    {{ vod.type_name || vod.vod_remarks }}
                  </span>
                </div>
                <!-- Play overlay (hover) -->
                <div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                  style="background: rgba(0,0,0,0.4)">
                  <div class="flex items-center justify-center w-12 h-12 rounded-full"
                    style="background: #ff6b6b; box-shadow: 0 4px 20px rgba(255,107,107,0.5)">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="white">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                </div>
              </div>
              <p class="mt-2 text-sm font-semibold truncate text-center"
                style="color: var(--color-text-primary)" :title="vod.vod_name">{{ vod.vod_name }}</p>
            </div>
          </div>

          <!-- ===== PAN CARD GRID LAYOUT (Quark netdisk — file cards) ===== -->
          <div v-else-if="displayVodList.length > 0 && sourceStyle.type === 'pan'" :class="[
            'grid gap-3',
            gridColsClass,
          ]">
            <div v-for="vod in displayVodList" :key="vod.vod_id"
              class="pan-card cursor-pointer group" @click="handleVodClick(vod)">
              <div class="relative overflow-hidden pan-card-poster"
                :style="{ aspectRatio: sourceStyle.ratio }">
                <img v-if="vod.vod_pic" :src="processImageUrl(vod.vod_pic)"
                  class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" loading="lazy" />
                <div v-else class="w-full h-full flex flex-col items-center justify-center gap-2"
                  :style="{ background: vod.action ? 'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)' : 'linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)' }">
                  <svg v-if="vod.action" viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5"
                    :style="{ color: vod.action.startsWith('del') ? '#10b981' : '#3b82f6' }">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 6v6l4 2"/>
                  </svg>
                  <svg v-else-if="isPanFolderItem(vod)" viewBox="0 0 24 24" width="36" height="36" fill="#f59e0b">
                    <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                  </svg>
                  <svg v-else viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5"
                    style="color: #64748b">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                  </svg>
                </div>
                <!-- Quark-style top-right badge -->
                <div v-if="vod.vod_remarks" class="absolute top-2 right-2">
                  <span class="text-[10px] font-medium px-1.5 py-0.5 rounded"
                    style="background: rgba(255,255,255,0.95); color: #1e293b; box-shadow: 0 1px 3px rgba(0,0,0,0.1)">
                    {{ vod.vod_remarks }}
                  </span>
                </div>
                <!-- Login status for pan actions -->
                <div v-if="vod.action" class="absolute bottom-2 right-2">
                  <span class="text-[10px] font-medium px-1.5 py-0.5 rounded"
                    :style="{
                      background: vod.action.startsWith('del') ? 'rgba(16,185,129,0.95)' : 'rgba(59,130,246,0.95)',
                      color: 'white'
                    }">
                    {{ vod.action.startsWith('del') ? '已登录' : '未登录' }}
                  </span>
                </div>
              </div>
              <p class="mt-2 text-xs font-medium truncate"
                style="color: var(--color-text-primary)" :title="vod.vod_name">{{ vod.vod_name }}</p>
              <p v-if="vod.type_name || vod.vod_year" class="text-[11px] mt-0.5 truncate"
                style="color: var(--color-text-tertiary)">
                {{ [vod.type_name, vod.vod_year].filter(Boolean).join(' · ') }}
              </p>
            </div>
          </div>

          <!-- ===== CARD/GRID LAYOUT (default video / config center) ===== -->
          <div v-else-if="displayVodList.length > 0" :class="[
            'grid gap-4',
            gridColsClass,
          ]">
            <div v-for="vod in displayVodList" :key="vod.vod_id"
              class="vod-card cursor-pointer group"
              :class="{
                'vod-card-action': vod.action,
                'vod-card-config': isConfigCenter,
              }" @click="handleVodClick(vod)">
              <!-- Poster -->
              <div class="relative overflow-hidden"
                :style="{ borderRadius: 'var(--radius-md, 10px)', aspectRatio: sourceStyle.ratio }">
                <img v-if="vod.vod_pic" :src="processImageUrl(vod.vod_pic)" :class="[
                  'group-hover:scale-105 transition-transform duration-500',
                  isConfigCenter
                    ? 'w-3/5 h-3/5 object-contain absolute inset-0 m-auto'
                    : 'w-full h-full object-cover',
                ]" loading="lazy" />
                <div v-else class="w-full h-full flex items-center justify-center"
                  style="background: var(--color-bg-elevated)">
                  <el-icon :size="32" style="color: var(--color-text-tertiary)">
                    <Film />
                  </el-icon>
                </div>
                <!-- Bottom gradient -->
                <div v-if="!isConfigCenter" class="absolute inset-0"
                  style="background: linear-gradient(to top, rgba(10,11,16,0.85) 0%, rgba(10,11,16,0.1) 50%, transparent 100%)"></div>
                <!-- Remark badge -->
                <div v-if="vod.vod_remarks && !isConfigCenter" class="absolute bottom-0 left-0 right-0 p-2.5">
                  <span class="text-[11px] font-medium px-1.5 py-0.5 inline-block"
                    style="background: var(--color-primary); color: white; border-radius: 3px;">{{ vod.vod_remarks }}</span>
                </div>
                <!-- Shimmer effect on hover -->
                <div class="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-400 pointer-events-none"
                  style="background: linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.06) 45%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.06) 55%, transparent 60%); background-size: 200% 100%;"></div>
              </div>
              <!-- Title below poster -->
              <p class="mt-2 text-[13px] font-medium truncate"
                style="color: var(--color-text-primary)" :title="vod.vod_name">{{ vod.vod_name }}</p>
              <p v-if="isConfigCenter && vod.vod_remarks" class="text-xs mt-0.5 truncate"
                style="color: var(--color-text-tertiary)">{{ vod.vod_remarks }}</p>
            </div>
          </div>

          <!-- Empty State -->
          <div v-else class="flex-1 flex flex-col items-center justify-center py-20"
            style="color: var(--color-text-tertiary)">
            <el-icon :size="48" class="mb-3">
              <component :is="emptyStateIcon" />
            </el-icon>
            <p>{{ sourceStyle.emptyHint || '暂无数据' }}</p>
            <p class="text-xs mt-2">请检查 DevTools 控制台日志，或尝试切换其他源</p>
          </div>

          <!-- Scroll-to-bottom loading indicator -->
          <div v-if="isCategoryActive && store.categoryLoading" class="flex flex-col items-center justify-center py-8">
            <div class="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style="border-color: var(--color-primary); border-top-color: transparent;"></div>
            <span class="text-xs mt-2" style="color: var(--color-text-tertiary)">加载中...</span>
          </div>

          <!-- End of list indicator -->
          <div
            v-if="isCategoryActive && !store.categoryLoading && store.categoryPage >= store.categoryPageCount && store.categoryVodList.length > 0"
            class="flex justify-center py-6">
            <span class="text-xs" style="color: var(--color-text-tertiary)">— 已加载全部 —</span>
          </div>
          </template>
        </template>
      </div>
    </div>

    <!-- 网盘配置中心对话框（iframe 嵌入 JAR 的 wexconfig 页面） -->
    <WexConfigDialog v-model:visible="qrDialogVisible" :target-pan-type="qrDialogPanType" @success="onQrLoginSuccess" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onActivated, onDeactivated } from 'vue'
import { useRouter } from 'vue-router'
import {
  Box, Film, Refresh, Loading, Headset, Star, Folder,
  VideoCamera, VideoPlay, Football, Reading, Notebook, Microphone, Connection, Monitor,
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '../store/app'
import { spiderEngine } from '../core/SpiderEngine'
import { PanLogin, type PanType } from '../core/PanLogin'
import { detectSourceType, isPanOnlySource, type SourceStyleConfig, type SourceType } from '../core/SourceTypeDetector'
import WexConfigDialog from '../components/WexConfigDialog.vue'
import type { Movie, SourceBean } from '../core/models'
import { processImageUrl } from '../core/models'

const store = useAppStore()
const router = useRouter()

const isMounted = ref(false)
const scrollTop = ref(0)
const scrollContainer = ref<HTMLElement | null>(null)

// 使用store中的状态
const activeCategory = computed(() => store.activeCategory)
const filterValues = computed(() => store.filterValues)

// 网盘扫码登录对话框状态
const qrDialogVisible = ref(false)
const qrDialogPanType = ref<PanType>('quark')

// 当 classes 为空但有 filters 时，从 filters 的 key 生成虚拟分类
const displayClasses = computed(() => {
  // 如果 classes 有数据，直接使用
  if (store.classes.length > 0) {
    return store.classes
  }
  // 如果 classes 为空但有 filters，从 filters 的 key 生成虚拟分类
  const filterKeys = Object.keys(store.filters)
  if (filterKeys.length > 0) {
    return filterKeys.map(key => ({
      type_id: key,
      type_name: `分类${key}`,
    }))
  }
  return []
})

watch([displayClasses, () => store.homeLoading], ([classes, loading]) => {
  if (!isMounted.value || classes.length === 0 || loading || store.activeCategory) return
  // 有推荐分类且首页有数据时，选中推荐
  const recommendClass = classes.find(c => c.type_id === '__recommend__')
  if (recommendClass && store.homeVodList.length > 0) {
    console.log('[Home] Auto-selecting recommend category')
    store.setCategory('__recommend__')
    return
  }
  // 否则选中第一个分类并加载
  const firstClass = classes[0]
  console.log('[Home] Auto-selecting first category:', firstClass.type_id)
  store.setCategory(firstClass.type_id)
  if (firstClass.type_id !== '__recommend__') {
    store.loadCategory(firstClass.type_id, '1')
  }
}, { immediate: true })

const isCategoryActive = computed(() => activeCategory.value !== '' && activeCategory.value !== '__recommend__')
const displayVodList = computed(() =>
  isCategoryActive.value ? store.categoryVodList : store.homeVodList
)
const isConfigCenter = computed(
  () =>
    displayVodList.value.length > 0 && displayVodList.value.every((v) => v.action),
)

// ===== Source type detection (Children / Music / Pan / Video) =====
// Detects source type from source bean + categories returned by homeContent.
// Used to switch between dedicated layouts (square cards for children, list
// for music, pan browser for personal cloud drives, default grid for video).
const sourceStyle = computed<SourceStyleConfig>(() => {
  // Config center always uses pan/card style
  if (isConfigCenter.value || isPanOnlySource(store.activeSite, store.homeVodList)) {
    return detectSourceType(store.activeSite, store.classes)
  }
  return detectSourceType(store.activeSite, store.classes)
})

// View mode for sources that support list/card toggle (pan sources).
// Persisted per-source-type so user preference is remembered.
const viewMode = ref<'list' | 'card'>(
  (localStorage.getItem('tvbox_home_view_mode') as 'list' | 'card') || 'card',
)

function setViewMode(mode: 'list' | 'card') {
  viewMode.value = mode
  localStorage.setItem('tvbox_home_view_mode', mode)
}

// Effective layout: honor sourceStyle.layout unless user toggled view mode
// for pan sources (which support both card and list views).
const effectiveLayout = computed<'grid' | 'list' | 'card'>(() => {
  if (sourceStyle.value.supportsViewToggle) {
    return viewMode.value
  }
  return sourceStyle.value.layout
})

// Grid columns class based on source type and ratio
const gridColsClass = computed(() => {
  if (isConfigCenter.value) {
    return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 max-w-3xl mx-auto'
  }
  switch (sourceStyle.value.type) {
    case 'children':
      // Square cards — show more per row
      return 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7'
    case 'music':
    case 'audio':
      return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'
    case 'pan':
      return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6'
    case 'anime':
      // Portrait posters, dense
      return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7'
    case 'shortPlay':
      // Vertical 9:16 — more compact
      return 'grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8'
    case 'sport':
    case 'bilibili':
    case 'education':
    case 'live':
      // Landscape 16:9 — fewer per row
      return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'
    case 'mediaServer':
      return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6'
    default:
      // Regular video — standard 2/3 poster grid
      return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6'
  }
})

// Empty-state icon based on source type
const emptyStateIcon = computed(() => {
  const iconMap: Record<SourceType, any> = {
    music: Headset,
    audio: Microphone,
    children: Star,
    pan: Folder,
    anime: VideoCamera,
    shortPlay: VideoPlay,
    sport: Football,
    education: Reading,
    bilibili: VideoCamera,
    mediaServer: Connection,
    live: Monitor,
    video: Film,
  }
  return iconMap[sourceStyle.value.type] || Film
})

// 配置中心内嵌 iframe 状态
const configCenterUrl = ref('')
const configCenterLoading = ref(false)
const configCenterError = ref('')
// True when the JAR's wexconfig URL returns empty/non-HTML body (e.g.
// itv666 AAConfigAmns returns 0 bytes, feimao Config returns 502). In
// that case the iframe is useless, so we fall back to the hardcoded
// pan login grid (homeVodList built by buildConfigCenterVodList).
const configCenterIframeEmpty = ref(false)

async function loadConfigCenterUrl() {
  configCenterLoading.value = true
  configCenterError.value = ''
  configCenterIframeEmpty.value = false
  try {
    // SpiderEngine caches spiders under `${source.key}-${source.name}` (the
    // uniqueKey), so the proxy must look up the spider by the same key.
    // Passing only source.key (e.g. "config") would miss the cache and the
    // proxy would fall back to static Proxy.proxy, which always serves the
    // 王小二 (NewWexFnw) page regardless of which config is active.
    const site = store.activeSite
    const siteKey = site ? `${site.key}-${site.name}` : undefined
    const url = await PanLogin.getWexConfigUrl(siteKey)
    console.log('[Home] configCenter iframe URL:', url, 'siteKey:', siteKey)

    // Pre-fetch the iframe URL to detect empty/error responses.
    // Some config center spiders (itv666 AAConfigAmns) return 200 with
    // empty body; others (feimao Config) return 502. In both cases the
    // iframe would be blank, so we fall back to the pan login grid.
    try {
      const resp = await fetch(url)
      const text = await resp.text()
      const isHtml = (resp.headers.get('content-type') || '').includes('text/html')
      const bodyLen = text.length
      console.log('[Home] configCenter prefetch:', {
        status: resp.status,
        mime: resp.headers.get('content-type'),
        bodyLen,
      })
      if (!resp.ok || bodyLen < 100 || !isHtml) {
        console.warn(
          '[Home] configCenter iframe empty/failing, falling back to pan login grid',
        )
        configCenterIframeEmpty.value = true
        configCenterUrl.value = ''
        return
      }
    } catch (prefetchErr: any) {
      console.warn(
        '[Home] configCenter prefetch failed, falling back to pan login grid:',
        prefetchErr.message,
      )
      configCenterIframeEmpty.value = true
      configCenterUrl.value = ''
      return
    }

    configCenterUrl.value = url
  } catch (e: any) {
    console.error('[Home] loadConfigCenterUrl error:', e)
    configCenterError.value = e.message || '加载配置页面失败'
  } finally {
    // loading is cleared on iframe @load; fallback timeout in case load
    // event doesn't fire
    setTimeout(() => {
      if (configCenterLoading.value) {
        configCenterLoading.value = false
      }
    }, 5000)
  }
}

function onConfigCenterIframeLoad() {
  configCenterLoading.value = false
  console.log('[Home] configCenter iframe loaded')
}

// 当配置中心激活时自动加载 iframe URL。
// 同时等待 configCenterSpiderLoaded，确保 spider 加载完成后再加载
// iframe，避免请求过早到达 proxy 时 spider 尚未就绪。
watch([isConfigCenter, () => store.configCenterSpiderLoaded], ([ic, loaded]) => {
  if (ic && loaded) {
    loadConfigCenterUrl()
  } else {
    configCenterUrl.value = ''
    configCenterLoading.value = false
    configCenterError.value = ''
  }
}, { immediate: true })

const activeFilters = computed(() => {
  if (activeCategory.value) {
    return store.filters[activeCategory.value] || []
  }
  return []
})

const currentTid = computed(() => {
  return activeCategory.value
})

watch(() => store.activeSiteKey, async (newKey, oldKey) => {
  console.log(`[Home] activeSiteKey changed: oldKey=${oldKey}, newKey=${newKey}`)
  if (newKey) {
    store.setCategory('')
    console.log(`[Home] Calling loadHome(true) for key=${newKey}`)
    await store.loadHome(true)

    if (store.homeVodList.length > 0) {
      const recommendClass = store.classes.find(c => c.type_id === '__recommend__')
      if (recommendClass) {
        console.log(`[Home] homeVodList has data, selecting recommend category`)
        store.setCategory('__recommend__')
      }
    } else if (store.classes.length > 0) {
      const firstClass = store.classes[0]
      console.log(`[Home] homeVodList empty, selecting first category: ${firstClass.type_name} (${firstClass.type_id})`)
      store.setCategory(firstClass.type_id)
      store.loadCategory(firstClass.type_id, '1')
    }
  }
})

onMounted(() => {
  isMounted.value = true
  if (store.activeSite) {
    store.loadHome()
  } else {
    const stop = watch(() => store.activeSite, (site) => {
      if (site) {
        stop()
        store.loadHome()
      }
    })
  }
})

onActivated(() => {
  console.log('[Home] onActivated — homeVodList:', store.homeVodList.length, 'categoryVodList:', store.categoryVodList.length, 'activeCategory:', store.activeCategory, 'homeLoading:', store.homeLoading)
  if (store.activeSite) {
    if (store.homeVodList.length === 0) {
      console.log('[Home] onActivated: homeVodList empty, calling loadHome()')
      store.loadHome()
    }
    // 非推荐分类且分类数据为空时，重新加载分类数据（保持 tab 选中状态）
    if (store.activeCategory && store.activeCategory !== '__recommend__' && store.categoryVodList.length === 0) {
      store.loadCategory(store.activeCategory, String(store.categoryPage))
    }
  }
  // 双重 rAF 确保 DOM 重新挂载完成后再恢复滚动位置
  const savedTop = scrollTop.value
  console.log('[Home] onActivated, saved scrollTop:', savedTop, 'hasContainer:', !!scrollContainer.value)
  if (savedTop > 0) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (scrollContainer.value) {
          scrollContainer.value.scrollTop = savedTop
          console.log('[Home] scroll restored to:', scrollContainer.value.scrollTop, '(target:', savedTop + ')')
        }
      })
    })
  }
})

onDeactivated(() => {
  if (scrollContainer.value) {
    scrollTop.value = scrollContainer.value.scrollTop
    console.log('[Home] onDeactivated, saved scrollTop:', scrollTop.value)
  }
})

function onScroll() {
  if (!scrollContainer.value) return
  scrollTop.value = scrollContainer.value.scrollTop

  // Scroll-to-bottom auto-load next page
  if (isCategoryActive.value && !store.categoryLoading) {
    const el = scrollContainer.value
    const scrollBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // Trigger when within 200px of bottom
    if (scrollBottom < 200 && store.categoryPage < store.categoryPageCount) {
      console.log('[Home] scroll-to-bottom, loading next page:', store.categoryPage + 1)
      store.loadCategory(currentTid.value, String(store.categoryPage + 1), store.filterValues)
    }
  }
}

function onCategoryChange(tid: string) {
  store.setCategory(tid)
  if (tid === '__recommend__') {
    console.log('[Home] onCategoryChange: recommend clicked, showing homeVodList')
    store.categoryVodList = []
  } else {
    store.loadCategory(tid, '1')
  }
}

// onFilterSelect 已移到 App.vue 的顶栏筛选按钮中

async function handleVodClick(vod: Movie) {
  if (vod.action) {
    try {
      console.log('[handleVodClick] action clicked:', vod.action, 'vod:', vod.vod_name)
      // 自行实现配置中心的所有 addXxx/delXxx 扫码登录，不再调用 JAR
      const panType = PanLogin.detectPanTypeFromAction(vod.action)
      if (panType) {
        if (PanLogin.isAddAction(vod.action)) {
          await showPanQrCode(panType)
        } else if (PanLogin.isDelAction(vod.action)) {
          try {
            await ElMessageBox.confirm(
              `确定要清除${PanLogin.getDisplayName(panType)}的登录状态吗？`,
              '确认清除',
              {
                confirmButtonText: '确定',
                cancelButtonText: '取消',
                type: 'warning',
              },
            )
          } catch {
            // 用户取消
            return
          }
          PanLogin.logout(panType)
          ElMessage.success(`${PanLogin.getDisplayName(panType)}登录已清除`)
          await store.loadHome(true)
        }
        return
      }

      // 非 addXxx/delXxx action，回退到 JAR 调用（如 startGoProxy 等）
      const site = store.activeSite
      if (!site) return
      await spiderEngine.getSpider(site as SourceBean)
      const { ipcRenderer } = require('electron')
      const result = await ipcRenderer.invoke('jar:callMethod', site.key, 'action', [vod.action])
      if (result && result !== '{}' && result !== '') {
        try {
          const parsed = JSON.parse(result)
          if (parsed.msg) {
            ElMessage.info(parsed.msg)
          }
          if (parsed.refresh) {
            await store.loadHome()
          }
        } catch {
          // 非 JSON 返回，忽略
        }
      }
    } catch (e) {
      console.error('[handleVodClick] action failed:', e)
      ElMessage.error('操作失败: ' + (e instanceof Error ? e.message : String(e)))
    }
  } else {
    // msearch: 前缀表示发现类源（如豆瓣），无 detailContent 方法，重定向到快速搜索
    if (typeof vod.vod_id === 'string' && vod.vod_id.startsWith('msearch:')) {
      console.log('[Home] msearch vod clicked, redirecting to quick search:', vod.vod_name)
      router.push({ name: 'search', query: { keyword: vod.vod_name, fast: '1' } })
      // 直接触发搜索（Search.vue 被 keep-alive 缓存，watch/onActivated 在重新激活时不可靠）
      store.doSearch(vod.vod_name, undefined, true)
      return
    }
    // Folder/cover navigation: clicking a folder or cover item navigates
    // into it via categoryContent (mirrors Android GridFragment.changeView
    // for tag=folder/cover). Applies to ALL sources, not just pan — ManJu
    // sources return rank_folder:* items, pan sources return folder:* items,
    // Android uses vod_tag=folder|cover as the universal signal.
    if (isFolderItem(vod)) {
      await navigateIntoPanFolder(vod)
      return
    }
    router.push({ name: 'detail', params: { sourceKey: store.activeSiteKey, vodId: vod.vod_id } })
  }
}

async function showPanQrCode(panType: PanType) {
  console.log(`[showPanQrCode] opening QR dialog for ${panType}`)
  // 如果已登录，提示用户
  if (PanLogin.isLoggedIn(panType)) {
    const info = PanLogin.getLoginInfo(panType)
    ElMessage.info(`${PanLogin.getDisplayName(panType)}已登录（${info?.nickname || info?.userId || ''}），如需切换账号请先清除登录`)
  }
  qrDialogPanType.value = panType
  qrDialogVisible.value = true
}

function onQrLoginSuccess(info: { panType: PanType; cookieLength?: number }) {
  console.log('[onQrLoginSuccess] login success:', info)
  // WexConfigDialog already shows a success toast; just refresh the config
  // center so the updated login status is reflected immediately.
  store.loadHome(true)
}

function refreshConfigCenter() {
  console.log('[refreshConfigCenter] manual refresh')
  store.loadHome(true)
}

// Detect if a pan-source vod item represents a folder (vs a playable file).
// Used to render folder vs file icons in Quark-style list/card views.
function isPanFolderItem(vod: Movie): boolean {
  if (!vod) return false
  // Items with action (login/add/del) are not folders — they are config items
  if (vod.action) return false
  // vod_tag "folder" or vod_id starting with "folder" indicates a folder entry
  const tag = (vod.vod_tag || '').toLowerCase()
  const id = String(vod.vod_id || '').toLowerCase()
  return tag === 'folder' || id.startsWith('folder') || tag === 'dir'
}

// Universal folder/cover detection for click handling — mirrors Android
// GridFragment.onItemClick: if video.tag is "folder" or "cover", navigate
// into the folder via categoryContent instead of going to detail page.
// Also covers ManJu (rank_folder:* vod_id) and pan (folder:* vod_id) cases
// where the spider may not set vod_tag.
function isFolderItem(vod: Movie): boolean {
  if (!vod) return false
  if (vod.action) return false
  const tag = (vod.vod_tag || '').toLowerCase()
  const id = String(vod.vod_id || '').toLowerCase()
  return (
    tag === 'folder' ||
    tag === 'cover' ||
    tag === 'dir' ||
    id.startsWith('folder') ||
    id.startsWith('rank_folder:')
  )
}

// ===== Pan folder navigation (mirrors Android GridFragment.changeView) =====
// When user clicks a folder item, we navigate into it by calling
// categoryContent(folderId). A stack tracks the navigation history so the
// back button can pop to the parent folder.
interface PanFolderEntry {
  tid: string
  name: string
}
const panFolderStack = ref<PanFolderEntry[]>([])

// The effective tid for category loading: if we're inside a folder, use the
// folder's id; otherwise use the active category.
const effectiveTid = computed(() => {
  if (panFolderStack.value.length > 0) {
    return panFolderStack.value[panFolderStack.value.length - 1].tid
  }
  return activeCategory.value
})

// Navigate into a folder (pan source folder, ManJu rank_folder, etc.)
async function navigateIntoPanFolder(vod: Movie) {
  console.log('[Home] navigateIntoPanFolder:', vod.vod_name, vod.vod_id)
  // Push current state — only on first entry (stack empty)
  if (panFolderStack.value.length === 0) {
    if (activeCategory.value) {
      // Remember the root category (the tab user clicked)
      const rootClass = store.classes.find(c => c.type_id === activeCategory.value)
      panFolderStack.value.push({
        tid: activeCategory.value,
        name: rootClass?.type_name || '根目录',
      })
    } else {
      // No active category — user entered folder from home page.
      // Push a synthetic "首页" root so breadcrumb shows the home path.
      panFolderStack.value.push({
        tid: '__home__',
        name: '首页',
      })
    }
  }
  panFolderStack.value.push({
    tid: String(vod.vod_id),
    name: vod.vod_name,
  })
  // Load the folder's contents
  await store.loadCategory(String(vod.vod_id), '1', {})
  // Scroll to top
  if (scrollContainer.value) {
    scrollContainer.value.scrollTop = 0
  }
}

// Navigate back to parent folder
async function navigateBackPanFolder() {
  if (panFolderStack.value.length === 0) return
  console.log('[Home] navigateBackPanFolder, stack depth:', panFolderStack.value.length)
  panFolderStack.value.pop() // remove current
  if (panFolderStack.value.length === 0) {
    // Back to root category or home (when user entered folder from home page
    // without selecting a category — e.g., ManJu rank_folder cards)
    if (activeCategory.value) {
      await store.loadCategory(activeCategory.value, '1', {})
    } else {
      await store.loadHome(true)
    }
  } else {
    const parent = panFolderStack.value[panFolderStack.value.length - 1]
    if (parent.tid === '__home__') {
      await store.loadHome(true)
    } else {
      await store.loadCategory(parent.tid, '1', {})
    }
  }
  if (scrollContainer.value) {
    scrollContainer.value.scrollTop = 0
  }
}

// Navigate back to a specific index in the folder stack (breadcrumb click)
async function navigateBackToIndex(targetIdx: number) {
  if (targetIdx < 0 || targetIdx >= panFolderStack.value.length - 1) return
  console.log('[Home] navigateBackToIndex:', targetIdx, 'stack depth:', panFolderStack.value.length)
  // Truncate stack to keep entries [0..targetIdx]
  panFolderStack.value = panFolderStack.value.slice(0, targetIdx + 1)
  const target = panFolderStack.value[panFolderStack.value.length - 1]
  if (target.tid === '__home__') {
    await store.loadHome(true)
  } else {
    await store.loadCategory(target.tid, '1', {})
  }
  if (scrollContainer.value) {
    scrollContainer.value.scrollTop = 0
  }
}

// Reset folder stack when switching source or category
watch(() => store.activeSiteKey, () => {
  panFolderStack.value = []
})
watch(activeCategory, () => {
  panFolderStack.value = []
})
</script>

<style scoped>
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}

.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

/* Category pills - glassmorphic blur */
.category-pill {
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  color: var(--color-text-secondary);
  border: 1px solid transparent;
}

.category-pill:hover {
  background: var(--color-bg-glass-heavy);
  color: var(--color-text-primary);
}

.category-pill-active {
  background: var(--color-primary) !important;
  color: #fff !important;
  box-shadow: 0 2px 12px var(--color-primary-glow);
}

/* Filter chips */
.filter-chip {
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
}

.filter-chip:hover {
  border-color: var(--color-primary-border);
  color: var(--color-text-primary);
}

.filter-chip-active {
  background: var(--color-primary-soft) !important;
  color: var(--color-primary) !important;
  border-color: var(--color-primary-border) !important;
}

/* Video card hover effect */
.vod-card {
  box-shadow: var(--surface-static-shadow);
  transition: transform 300ms var(--ease-out-expo, ease), box-shadow 300ms ease;
}

.vod-card:hover {
  box-shadow: var(--surface-floating-shadow);
}

.vod-card-action {
  border: 1px solid var(--color-primary-border);
}

.vod-card-config {
  border: 1px solid transparent;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.vod-card-config:hover {
  border-color: var(--color-primary-border);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
}

/* Children source cards — brighter, more playful */
.vod-card-children:hover {
  transform: translateY(-2px);
}

/* Children grid card — rounded, bright, kid-friendly */
.children-card {
  transition: transform 250ms var(--ease-out-expo, ease);
}

.children-card:hover {
  transform: translateY(-3px);
}

.children-poster {
  border-radius: 14px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  border: 2px solid rgba(255, 255, 255, 0.5);
  transition: box-shadow 250ms ease, transform 250ms ease;
}

.children-card:hover .children-poster {
  box-shadow: 0 8px 24px rgba(255, 107, 107, 0.3);
}

.children-badge {
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

/* Music list — album-art style rows */
.music-list {
  padding: 4px 0;
}

.music-item {
  border-radius: 10px;
  transition: background 180ms ease, transform 180ms ease;
}

.music-item:hover {
  background: var(--color-bg-glass);
}

.music-item-action {
  background: var(--color-primary-soft);
}

.music-cover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

/* Pan list — Quark netdisk file-browser style */
.pan-list {
  padding: 8px 0;
  background: var(--color-bg-glass);
  border: var(--glass-border);
  border-radius: 12px;
  overflow: hidden;
}

.pan-list-header {
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.5px;
}

.pan-list-item {
  border-bottom: 1px solid transparent;
}

.pan-list-item:hover {
  background: var(--color-bg-glass-heavy);
}

.pan-list-item-action {
  background: var(--color-primary-soft);
}

/* Pan card — Quark netdisk grid card */
.pan-card {
  transition: transform 200ms var(--ease-out-expo, ease);
}

.pan-card:hover {
  transform: translateY(-2px);
}

/* Pan folder breadcrumb — Quark-style navigation */
.pan-breadcrumb-back:hover {
  background: var(--color-bg-glass-heavy);
  color: var(--color-text-primary) !important;
}

.pan-card-poster {
  border-radius: 10px;
  background: var(--color-bg-elevated);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  border: 1px solid var(--color-border);
  transition: box-shadow 200ms ease, border-color 200ms ease;
}

.pan-card:hover .pan-card-poster {
  box-shadow: 0 6px 18px rgba(59, 130, 246, 0.2);
  border-color: #3b82f6;
}

/* List card (fallback for generic list layout) */
.list-card {
  border: 1px solid transparent;
  transition: transform 200ms var(--ease-out-expo, ease),
    background 200ms ease, border-color 200ms ease;
}

.list-card:hover {
  background: var(--color-bg-glass-heavy) !important;
  border-color: var(--color-primary-border);
  transform: translateX(2px);
}

.list-card-action {
  border-color: var(--color-primary-border);
}

/* View mode toggle (list/card) */
.view-toggle-btn {
  background: transparent;
  color: var(--color-text-tertiary);
  border: none;
  outline: none;
}

.view-toggle-btn:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-elevated);
}

.view-toggle-active {
  background: var(--color-primary) !important;
  color: #fff !important;
}

/* Config center iframe */
.config-center-iframe-wrapper {
  display: flex;
  flex-direction: column;
  /* Fill the scroll container's viewport. Parent (.scrollContainer) has
     overflow-auto + p-4; using 100% of the flex parent height makes the
     iframe area match the visible region instead of growing with content. */
  height: 100%;
  min-height: 0;
}

.config-center-iframe {
  /* flex:1 alone doesn't work inside an overflow-auto scroll container —
     the iframe needs an explicit height to render. Use flex:1 plus
     min-height:0 so it fills the remaining space after the header. */
  width: 100%;
  flex: 1 1 0;
  min-height: 0;
  /* Fallback for browsers where flex sizing of iframe is unreliable
     inside an overflow-auto container: claim most of the viewport. */
  height: calc(100vh - 160px);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 10px);
  background: var(--color-bg-elevated);
}

.rotating {
  animation: rotating 1.5s linear infinite;
}

@keyframes rotating {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
