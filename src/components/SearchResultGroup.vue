<template>
  <div class="mb-8">
    <!-- Group header -->
    <div class="flex items-center gap-2 mb-3 border-l-4 pl-3" style="border-color: var(--color-primary)">
      <h3 class="text-lg font-bold" style="color: var(--color-text-primary)">{{ group.siteName }}</h3>
      <span
        class="px-2 py-0.5 rounded text-xs font-medium"
        style="background: var(--color-primary-soft); color: var(--color-primary)"
      >{{ group.list.length }}</span>
    </div>

    <!-- Grid mode -->
    <div v-if="!listMode" class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
      <div
        v-for="vod in group.list"
        :key="vod.vod_id"
        class="cursor-pointer rounded-lg overflow-hidden transition-all duration-300 hover:-translate-y-1 group"
        style="background: var(--color-bg-surface)"
        @click="emit('go-to-detail', group.siteKey, vod)"
      >
        <div class="relative overflow-hidden aspect-[3/4]">
          <img
            v-if="vod.vod_pic"
            :src="vod.vod_pic"
            class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            loading="lazy"
          />
          <div v-else class="w-full h-full flex items-center justify-center" style="background: var(--color-bg-elevated)">
            <el-icon :size="32" style="color: var(--color-text-tertiary)"><Film /></el-icon>
          </div>
          <div
            v-if="vod.vod_remarks"
            class="absolute bottom-0 left-0 right-0 p-2 pt-6"
            style="background: linear-gradient(to top, rgba(0,0,0,0.8), transparent)"
          >
            <span class="text-white text-xs font-medium">{{ vod.vod_remarks }}</span>
          </div>
        </div>
        <div class="p-2">
          <span class="text-sm font-bold truncate block" style="color: var(--color-text-primary)">{{ vod.vod_name }}</span>
          <span v-if="vod.vod_remarks" class="text-xs truncate block mt-0.5" style="color: var(--color-text-tertiary)">{{ vod.vod_remarks }}</span>
        </div>
      </div>
    </div>

    <!-- List mode -->
    <div v-else class="space-y-2">
      <div
        v-for="vod in group.list"
        :key="vod.vod_id"
        class="flex items-center gap-3 p-2 rounded cursor-pointer transition-colors"
        style="background: var(--color-bg-surface)"
        @click="emit('go-to-detail', group.siteKey, vod)"
      >
        <img
          v-if="vod.vod_pic"
          :src="vod.vod_pic"
          class="w-12 h-16 object-cover rounded flex-shrink-0"
          loading="lazy"
        />
        <div v-else class="w-12 h-16 rounded flex-shrink-0 flex items-center justify-center" style="background: var(--color-bg-elevated)">
          <el-icon :size="16" style="color: var(--color-text-tertiary)"><Film /></el-icon>
        </div>
        <div class="flex-1 min-w-0">
          <span class="text-sm font-bold" style="color: var(--color-text-primary)">{{ vod.vod_name }}</span>
          <span v-if="vod.vod_remarks" class="text-xs ml-2" style="color: var(--color-text-tertiary)">{{ vod.vod_remarks }}</span>
          <span v-if="vod.type_name" class="text-xs ml-2" style="color: var(--color-text-secondary)">{{ vod.type_name }}</span>
          <span v-if="vod.vod_year" class="text-xs ml-2" style="color: var(--color-text-tertiary)">{{ vod.vod_year }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Film } from '@element-plus/icons-vue'
import type { Movie } from '../core/models'

interface SearchResultGroup {
  siteKey: string
  siteName: string
  list: Movie[]
}

defineProps<{
  group: SearchResultGroup
  listMode: boolean
}>()

const emit = defineEmits<{
  'go-to-detail': [siteKey: string, vod: Movie]
}>()
</script>
