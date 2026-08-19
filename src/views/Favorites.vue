<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <div class="px-6 pt-4 pb-2 flex items-center justify-between flex-shrink-0">
      <h2 class="text-xl font-bold" style="color: var(--color-text-primary)">我的收藏</h2>
      <span
        class="text-xs px-2.5 py-1 rounded-md"
        style="
          color: var(--color-text-secondary);
          background: var(--color-bg-elevated);
          border: 1px solid var(--color-border);
        "
      >
        共 {{ store.favoriteList.length }} 部
      </span>
    </div>

    <div v-if="store.favoriteList.length === 0" class="flex-1 flex flex-col items-center justify-center" style="color: var(--color-text-tertiary)">
      <div class="w-20 h-20 mb-4 rounded-full flex items-center justify-center" style="background: var(--color-bg-elevated); border: 1px solid var(--color-border)">
        <el-icon :size="36"><Star /></el-icon>
      </div>
      <p class="text-sm mb-1" style="color: var(--color-text-secondary)">暂无收藏</p>
      <p class="text-xs mb-6">在影片详情页点击「收藏」，就会出现在这里</p>
      <div class="flex items-center gap-3">
        <button
          class="px-5 h-10 text-sm font-medium cursor-pointer border-none transition-all duration-200"
          style="background: var(--color-primary); color: white; border-radius: var(--radius-md, 10px); box-shadow: 0 4px 16px var(--color-primary-soft)"
          @click="goHome"
        >去首页看看</button>
        <button
          class="px-5 h-10 text-sm font-medium cursor-pointer transition-all duration-200"
          style="background: transparent; color: var(--color-text-secondary); border: 1px solid var(--color-border); border-radius: var(--radius-md, 10px)"
          @click="goSearch"
        >去搜索</button>
      </div>
    </div>

    <div v-else class="flex-1 overflow-auto px-4 pb-4">
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 mt-2">
        <div
          v-for="item in store.favoriteList"
          :key="`${item.sourceKey}-${item.vod_id}`"
          class="cursor-pointer rounded-lg overflow-hidden transition-all duration-300 hover:-translate-y-1 group"
          style="background: var(--color-bg-surface)"
          @click="goToPlay(item)"
        >
          <div class="relative overflow-hidden aspect-[3/4]">
            <img
              v-if="item.vod_pic && !imgFailed[favKey(item)]"
              :src="processImageUrl(item.vod_pic)"
              class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
              loading="lazy"
              @error="onImgError(favKey(item))"
            />
            <div v-else class="w-full h-full flex items-center justify-center" style="background: var(--color-bg-elevated)">
              <el-icon :size="32" style="color: var(--color-text-tertiary)"><Film /></el-icon>
            </div>
            <!-- Delete button (hover only) -->
            <el-button
              class="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity"
              circle
              size="small"
              type="danger"
              :icon="Delete"
              @click.stop="handleRemove(item)"
            />
          </div>
          <div class="p-3">
            <span class="text-sm font-medium truncate block" style="color: var(--color-text-primary)" :title="item.vod_name">{{ item.vod_name }}</span>
            <div class="flex items-center justify-between mt-1 gap-2">
              <span
                class="text-xs px-2 py-0.5 rounded-full truncate flex-shrink-0"
                style="color: var(--color-text-secondary); background: var(--color-bg-elevated)"
                :title="getSourceName(item.sourceKey)"
              >
                {{ getSourceName(item.sourceKey) }}
              </span>
              <span
                v-if="item.vod_remarks"
                class="text-xs truncate"
                style="color: var(--color-text-tertiary)"
              >
                {{ item.vod_remarks }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Star, Delete, Film } from '@element-plus/icons-vue'
import { useAppStore } from '../store/app'
import type { FavoriteRecord } from '../core/Database'
import { processImageUrl } from '../core/models'

const store = useAppStore()
const router = useRouter()

// Track images that failed to load, keyed by `${sourceKey}_${vod_id}`
const imgFailed = reactive<Record<string, boolean>>({})

function favKey(item: FavoriteRecord): string {
  return `${item.sourceKey}_${item.vod_id}`
}

function onImgError(key: string) {
  imgFailed[key] = true
}

onMounted(() => {
  store.refreshFavorites()
})

function getSourceName(sourceKey: string): string {
  const site = store.sites.find(s => s.key === sourceKey)
  return site?.name || sourceKey
}

function goToPlay(item: FavoriteRecord) {
  router.push({ name: 'detail', params: { sourceKey: item.sourceKey, vodId: item.vod_id } })
}

function goHome() {
  router.push({ name: 'home' })
}

function goSearch() {
  router.push({ name: 'search' })
}

async function handleRemove(item: FavoriteRecord) {
  await store.toggleFavorite(item as any, item.sourceKey)
  ElMessage.success('已取消收藏')
}
</script>
