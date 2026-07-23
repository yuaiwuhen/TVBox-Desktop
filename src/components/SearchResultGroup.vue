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
    <div v-if="!listMode" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
      <div
        v-for="vod in group.list"
        :key="vod.vod_id"
        class="cursor-pointer rounded-lg overflow-hidden transition-all duration-300 hover:-translate-y-1 group"
        style="background: var(--color-bg-surface)"
        @click="emit('go-to-detail', group.siteKey, vod)"
      >
        <div class="relative overflow-hidden aspect-[3/4]">
          <img
            v-if="vod.vod_pic && !imgErrors[vod.vod_id]"
            :src="vod.vod_pic"
            class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            loading="lazy"
            @error="handleImgError(vod.vod_id)"
          />
          <div
            v-else
            class="w-full h-full flex flex-col items-center justify-center p-3 default-poster"
            :style="getDefaultPosterStyle(vod.vod_name)"
          >
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: rgba(255,255,255,0.7); margin-bottom: 8px">
              <rect x="2" y="2" width="20" height="20" rx="2.5" ry="2.5"></rect>
              <polygon points="10 8 16 12 10 16 10 8"></polygon>
            </svg>
            <span class="text-white text-sm font-bold text-center line-clamp-3 leading-snug">{{ vod.vod_name }}</span>
          </div>
          <div
            v-if="vod.vod_remarks"
            class="absolute bottom-0 left-0 right-0 p-2 pt-6"
            style="background: linear-gradient(to top, rgba(0,0,0,0.8), transparent)"
          >
            <span class="text-white text-xs font-medium">{{ vod.vod_remarks }}</span>
          </div>
        </div>
        <div class="p-3">
          <span class="text-base font-bold truncate block" style="color: var(--color-text-primary)">{{ vod.vod_name }}</span>
          <span v-if="vod.vod_remarks" class="text-sm truncate block mt-1" style="color: var(--color-text-tertiary)">{{ vod.vod_remarks }}</span>
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
          v-if="vod.vod_pic && !imgErrors[vod.vod_id]"
          :src="vod.vod_pic"
          class="w-12 h-16 object-cover rounded flex-shrink-0"
          loading="lazy"
          @error="handleImgError(vod.vod_id)"
        />
        <div
          v-else
          class="w-12 h-16 rounded flex-shrink-0 flex items-center justify-center"
          :style="getDefaultPosterStyle(vod.vod_name)"
        >
          <span class="text-white text-xs font-bold text-center px-1 line-clamp-2 leading-tight">{{ vod.vod_name }}</span>
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
import { reactive } from 'vue'
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

const imgErrors = reactive<Record<string, boolean>>({})

function handleImgError(vodId: string) {
  imgErrors[vodId] = true
}

const gradientColors = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
  'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)',
  'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)',
  'linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)',
  'linear-gradient(135deg, #d299c2 0%, #fef9d7 100%)',
  'linear-gradient(135deg, #89f7fe 0%, #66a6ff 100%)',
  'linear-gradient(135deg, #fddb92 0%, #d1fdff 100%)',
]

function getDefaultPosterStyle(name: string): Record<string, string> {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  const index = Math.abs(hash) % gradientColors.length
  return {
    background: gradientColors[index],
  }
}
</script>

<style scoped>
.default-poster {
  position: relative;
}

.default-poster::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 30% 20%, rgba(255,255,255,0.2) 0%, transparent 50%);
  pointer-events: none;
}

.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.line-clamp-3 {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
