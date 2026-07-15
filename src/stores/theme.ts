import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ThemeMode = 'dark' | 'light'

const STORAGE_KEY_MODE = 'tvbox_theme_mode'
const STORAGE_KEY_PRIMARY = 'tvbox_theme_primary'
const STORAGE_KEY_BG_IMAGE = 'tvbox_theme_bg_image'
const STORAGE_KEY_BG_OPACITY = 'tvbox_theme_bg_opacity'

const DEFAULT_PRIMARY = '#e8913a'

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v !== null ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

function saveToStorage(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.replace('#', '')
  let r: number, g: number, b: number
  if (cleaned.length === 3) {
    r = parseInt(cleaned[0] + cleaned[0], 16)
    g = parseInt(cleaned[1] + cleaned[1], 16)
    b = parseInt(cleaned[2] + cleaned[2], 16)
  } else if (cleaned.length === 6) {
    r = parseInt(cleaned.substring(0, 2), 16)
    g = parseInt(cleaned.substring(2, 4), 16)
    b = parseInt(cleaned.substring(4, 6), 16)
  } else {
    return null
  }
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null
  return { r, g, b }
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function mixColors(base: { r: number; g: number; b: number }, mixVal: { r: number; g: number; b: number }, ratio: number): string {
  // ratio: 0 = pure base, 1 = pure mixVal
  return rgbToHex(
    base.r + (mixVal.r - base.r) * ratio,
    base.g + (mixVal.g - base.g) * ratio,
    base.b + (mixVal.b - base.b) * ratio,
  )
}

const WHITE = { r: 255, g: 255, b: 255 }
const BLACK = { r: 0, g: 0, b: 0 }
const DARK_BG = { r: 15, g: 17, b: 23 } // #0f1117 — dark mode page background

function rgbaColor(rgb: { r: number; g: number; b: number }, alpha: number): string {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
}

function generateColorVariants(hex: string, mode: ThemeMode) {
  const rgb = hexToRgb(hex)
  if (!rgb) return {}

  const mixBg = mode === 'dark' ? DARK_BG : WHITE
  const soft = rgbaColor(rgb, mode === 'dark' ? 0.2 : 0.12)
  const border = rgbaColor(rgb, 0.5)
  const light3 = mixColors(rgb, mixBg, 0.3)
  const light5 = mixColors(rgb, mixBg, 0.5)
  const light7 = mixColors(rgb, mixBg, 0.7)
  const light9 = mixColors(rgb, mixBg, 0.9)
  const dark2 = mixColors(rgb, BLACK, 0.2)

  return {
    '--color-primary': hex,
    '--color-primary-hover': mixColors(rgb, WHITE, 0.15),
    '--color-primary-active': mixColors(rgb, BLACK, 0.15),
    '--color-primary-soft': soft,
    '--color-primary-border': border,
    '--el-color-primary': hex,
    '--el-color-primary-light-3': light3,
    '--el-color-primary-light-5': light5,
    '--el-color-primary-light-7': light7,
    '--el-color-primary-light-8': mixColors(rgb, mixBg, 0.8),
    '--el-color-primary-light-9': light9,
    '--el-color-primary-dark-2': dark2,
    // Element Plus components that reference primary color
    '--el-input-hover-border-color': rgbaColor(rgb, 0.6),
    '--el-input-focus-border-color': hex,
    '--el-switch-on-color': hex,
    '--el-table-row-hover-bg-color': light9,
    '--el-tag-primary-bg-color': light9,
    '--el-tag-primary-border-color': light7,
    '--el-tag-primary-text-color': hex,
  }
}

function applyThemeTransition() {
  const html = document.documentElement
  html.classList.add('theme-transition')
  setTimeout(() => html.classList.remove('theme-transition'), 350)
}

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(loadFromStorage<ThemeMode>(STORAGE_KEY_MODE, 'dark'))
  const primaryColor = ref(loadFromStorage<string>(STORAGE_KEY_PRIMARY, DEFAULT_PRIMARY))
  const bgImage = ref(loadFromStorage<string | null>(STORAGE_KEY_BG_IMAGE, null))
  const bgOpacity = ref(loadFromStorage<number>(STORAGE_KEY_BG_OPACITY, 0.15))

  function applyMode(val: ThemeMode) {
    const html = document.documentElement
    if (val === 'dark') {
      html.classList.add('dark')
      html.style.colorScheme = 'dark'
    } else {
      html.classList.remove('dark')
      html.style.colorScheme = 'light'
    }
    saveToStorage(STORAGE_KEY_MODE, val)
    // Re-apply primary color variants for the new mode
    applyPrimaryColor(primaryColor.value)
  }

  function applyPrimaryColor(color: string) {
    const html = document.documentElement
    const currentMode = mode.value
    const variants = generateColorVariants(color, currentMode)
    for (const [key, value] of Object.entries(variants)) {
      html.style.setProperty(key, value)
    }
    saveToStorage(STORAGE_KEY_PRIMARY, color)
  }

  function applyBgImage(url: string | null, opacity: number) {
    const html = document.documentElement
    if (url) {
      html.style.setProperty('--theme-bg-image', `url("${encodeURI(url.replace(/\\/g, '/'))}")`)
      html.style.setProperty('--theme-bg-opacity', String(opacity))
      html.classList.add('has-bg-image')
    } else {
      html.style.removeProperty('--theme-bg-image')
      html.style.removeProperty('--theme-bg-opacity')
      html.classList.remove('has-bg-image')
    }
    saveToStorage(STORAGE_KEY_BG_IMAGE, url)
  }

  function setMode(val: ThemeMode) {
    applyThemeTransition()
    mode.value = val
    applyMode(val)
  }

  function toggleMode() {
    setMode(mode.value === 'dark' ? 'light' : 'dark')
  }

  function setPrimaryColor(color: string) {
    applyThemeTransition()
    primaryColor.value = color
    applyPrimaryColor(color)
  }

  function setBgImage(url: string | null) {
    bgImage.value = url
    applyBgImage(url, bgOpacity.value)
  }

  function setBgOpacity(opacity: number) {
    bgOpacity.value = opacity
    applyBgImage(bgImage.value, opacity)
  }

  function init() {
    applyMode(mode.value)
    applyPrimaryColor(primaryColor.value)
    applyBgImage(bgImage.value, bgOpacity.value)
  }

  return {
    mode, primaryColor, bgImage, bgOpacity,
    setMode, toggleMode, setPrimaryColor, setBgImage, setBgOpacity, init,
  }
})
