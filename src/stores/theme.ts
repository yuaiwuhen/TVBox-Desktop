import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type ThemeMode = 'dark' | 'light' | 'system' | 'custom'
export type ThemeBaseMode = 'dark' | 'light'

const STORAGE_KEY_MODE = 'tvbox_theme_mode'
const STORAGE_KEY_PRIMARY = 'tvbox_theme_primary'
const STORAGE_KEY_BG_COLOR = 'tvbox_theme_bg_color'
const STORAGE_KEY_BG_IMAGE = 'tvbox_theme_bg_image'
const STORAGE_KEY_BG_OPACITY = 'tvbox_theme_bg_opacity'
const STORAGE_KEY_CUSTOM_BASE = 'tvbox_theme_custom_base'

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

function normalizeHex(hex: string): string | null {
  let cleaned = hex.trim().replace('#', '')
  if (cleaned.length === 3) {
    cleaned = cleaned[0] + cleaned[0] + cleaned[1] + cleaned[1] + cleaned[2] + cleaned[2]
  }
  if (cleaned.length !== 6) return null
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null
  return `#${cleaned.toLowerCase()}`
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeHex(hex)
  if (!normalized) return null
  const cleaned = normalized.replace('#', '')
  const r = parseInt(cleaned.substring(0, 2), 16)
  const g = parseInt(cleaned.substring(2, 4), 16)
  const b = parseInt(cleaned.substring(4, 6), 16)
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null
  return { r, g, b }
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function mixColors(base: { r: number; g: number; b: number }, mixVal: { r: number; g: number; b: number }, ratio: number): string {
  return rgbToHex(
    base.r + (mixVal.r - base.r) * ratio,
    base.g + (mixVal.g - base.g) * ratio,
    base.b + (mixVal.b - base.b) * ratio,
  )
}

const WHITE = { r: 255, g: 255, b: 255 }
const BLACK = { r: 0, g: 0, b: 0 }
const DARK_BG = { r: 15, g: 17, b: 23 }
const LIGHT_BG = { r: 255, g: 255, b: 255 }

function rgbaColor(rgb: { r: number; g: number; b: number }, alpha: number): string {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
}

function getLuminance(rgb: { r: number; g: number; b: number }): number {
  return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255
}

function generateColorVariants(hex: string, mode: ThemeBaseMode) {
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
  const bgColor = ref<string | null>(loadFromStorage<string | null>(STORAGE_KEY_BG_COLOR, null))
  const bgImage = ref(loadFromStorage<string | null>(STORAGE_KEY_BG_IMAGE, null))
  const bgOpacity = ref(loadFromStorage<number>(STORAGE_KEY_BG_OPACITY, 0.15))
  const customBase = ref<ThemeBaseMode>(loadFromStorage<ThemeBaseMode>(STORAGE_KEY_CUSTOM_BASE, 'dark'))
  const systemDark = ref(false)

  let systemMediaQuery: MediaQueryList | null = null

  const effectiveMode = computed<ThemeBaseMode>(() => {
    if (mode.value === 'system') {
      return systemDark.value ? 'dark' : 'light'
    }
    if (mode.value === 'custom') {
      if (bgColor.value && !bgImage.value) {
        const rgb = hexToRgb(bgColor.value)
        if (rgb) {
          return getLuminance(rgb) < 0.5 ? 'dark' : 'light'
        }
      }
      return customBase.value
    }
    return mode.value as ThemeBaseMode
  })

  function handleSystemThemeChange(e: MediaQueryListEvent) {
    systemDark.value = e.matches
    if (mode.value === 'system') {
      applyBaseMode(effectiveMode.value)
    }
  }

  function applyBaseMode(val: ThemeBaseMode) {
    const html = document.documentElement
    if (val === 'dark') {
      html.classList.add('dark')
      html.style.colorScheme = 'dark'
    } else {
      html.classList.remove('dark')
      html.style.colorScheme = 'light'
    }
    applyPrimaryColor(primaryColor.value)
  }

  function applyMode(val: ThemeMode) {
    if (val === 'system') {
      if (!systemMediaQuery && typeof window !== 'undefined') {
        systemMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
        systemDark.value = systemMediaQuery.matches
        systemMediaQuery.addEventListener('change', handleSystemThemeChange)
      }
      if (systemMediaQuery) {
        systemDark.value = systemMediaQuery.matches
      }
      applyBaseMode(effectiveMode.value)
    } else if (val === 'custom') {
      applyBaseMode(effectiveMode.value)
      applyBgColor(bgColor.value)
    } else {
      applyBaseMode(val)
    }
    saveToStorage(STORAGE_KEY_MODE, val)
  }

  function applyPrimaryColor(color: string) {
    const html = document.documentElement
    const variants = generateColorVariants(color, effectiveMode.value)
    for (const [key, value] of Object.entries(variants)) {
      html.style.setProperty(key, value)
    }
    saveToStorage(STORAGE_KEY_PRIMARY, color)
  }

  function applyBgColor(color: string | null) {
    const html = document.documentElement
    if (color && !bgImage.value) {
      const normalized = normalizeHex(color)
      if (normalized) {
        html.style.setProperty('--theme-bg-color', normalized)
        html.classList.add('has-bg-color')
      }
    } else {
      html.style.removeProperty('--theme-bg-color')
      html.classList.remove('has-bg-color')
    }
  }

  function applyBgImage(url: string | null, opacity: number) {
    const html = document.documentElement
    if (url) {
      html.style.setProperty('--theme-bg-image', `url("${encodeURI(url.replace(/\\/g, '/'))}")`)
      html.style.setProperty('--theme-bg-opacity', String(opacity))
      html.classList.add('has-bg-image')
      html.style.removeProperty('--theme-bg-color')
      html.classList.remove('has-bg-color')
    } else {
      html.style.removeProperty('--theme-bg-image')
      html.style.removeProperty('--theme-bg-opacity')
      html.classList.remove('has-bg-image')
      if (bgColor.value) {
        applyBgColor(bgColor.value)
      }
    }
    saveToStorage(STORAGE_KEY_BG_IMAGE, url)
  }

  function setMode(val: ThemeMode) {
    applyThemeTransition()
    mode.value = val
    applyMode(val)
  }

  function toggleMode() {
    if (mode.value === 'dark') {
      setMode('light')
    } else if (mode.value === 'light') {
      setMode('system')
    } else if (mode.value === 'system') {
      setMode('dark')
    } else {
      setMode(customBase.value === 'dark' ? 'light' : 'dark')
    }
  }

  function setPrimaryColor(color: string) {
    const normalized = normalizeHex(color)
    if (!normalized) return
    applyThemeTransition()
    primaryColor.value = normalized
    applyPrimaryColor(normalized)
  }

  function setBgColor(color: string | null) {
    if (color) {
      const normalized = normalizeHex(color)
      if (!normalized) return
      bgColor.value = normalized
      saveToStorage(STORAGE_KEY_BG_COLOR, normalized)
    } else {
      bgColor.value = null
      saveToStorage(STORAGE_KEY_BG_COLOR, null)
    }
    if (mode.value === 'custom') {
      applyThemeTransition()
      applyBgColor(bgColor.value)
      applyBaseMode(effectiveMode.value)
    }
  }

  function setBgImage(url: string | null) {
    bgImage.value = url
    applyBgImage(url, bgOpacity.value)
    if (mode.value === 'custom') {
      applyThemeTransition()
      applyBaseMode(effectiveMode.value)
    }
  }

  function setBgOpacity(opacity: number) {
    bgOpacity.value = opacity
    applyBgImage(bgImage.value, opacity)
  }

  function setCustomBase(base: ThemeBaseMode) {
    customBase.value = base
    saveToStorage(STORAGE_KEY_CUSTOM_BASE, base)
    if (mode.value === 'custom') {
      applyThemeTransition()
      applyBaseMode(effectiveMode.value)
    }
  }

  function init() {
    if (typeof window !== 'undefined') {
      systemMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      systemDark.value = systemMediaQuery.matches
      systemMediaQuery.addEventListener('change', handleSystemThemeChange)
    }
    applyMode(mode.value)
    applyPrimaryColor(primaryColor.value)
    if (bgImage.value) {
      applyBgImage(bgImage.value, bgOpacity.value)
    } else if (bgColor.value) {
      applyBgColor(bgColor.value)
    }
  }

  return {
    mode,
    primaryColor,
    bgColor,
    bgImage,
    bgOpacity,
    customBase,
    systemDark,
    effectiveMode,
    setMode,
    toggleMode,
    setPrimaryColor,
    setBgColor,
    setBgImage,
    setBgOpacity,
    setCustomBase,
    init,
  }
})
