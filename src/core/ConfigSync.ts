/**
 * ConfigSync - 配置文件持久化（渲染进程侧）
 *
 * 将关键配置（配置URL、网盘登录、播放设置等）从 localStorage 同步到
 * userData/config.json 文件，确保应用重装或 localStorage 损坏后配置不丢失。
 *
 * 工作流程：
 *   1. 应用启动时调用 restoreFromFile()，将文件中的配置恢复到 localStorage
 *   2. 配置变更时调用 saveToFile()，将 localStorage 关键项写入文件
 */

const PERSISTED_KEYS = [
  // Config
  'tvbox_config_url',
  'tvbox_config_url_history',
  'tvbox_active_site',
  'tvbox_home_source',
  'tvbox_default_parse',
  // Live
  'tvbox_live_url',
  'tvbox_epg_url',
  // Player settings
  'tvbox_play_type',
  'tvbox_autoplay_next',
  'tvbox_doh_index',
  'tvbox_search_view',
  'tvbox_vlc_path',
  'tvbox_screen_display',
  // Subtitle
  'tvbox_subtitle_size',
  'tvbox_subtitle_color',
  'tvbox_subtitle_delay',
  'tvbox_subtitle_enabled',
  // Danmu
  'tvbox_danmu_enabled',
  'tvbox_danmu_max',
  'tvbox_danmu_speed_idx',
  'tvbox_danmu_opacity',
  'tvbox_danmu_lines',
  // Skip
  'tvbox_skip_intro',
  'tvbox_skip_outro',
  'tvbox_time_step',
  // WebDAV / Drives
  'tvbox_webdav_url',
  'tvbox_webdav_user',
  'tvbox_webdav_pass',
  'tvbox_drives',
  // Live settings
  'tvbox_live_last_group',
  'tvbox_live_last_channel',
  'tvbox_live_aspect',
  'tvbox_live_cross_group',
  'tvbox_live_show_speed',
  'tvbox_live_show_time',
  'tvbox_live_channel_reverse',
  'tvbox_live_timeout',
  'tvbox_live_auto_switch',
  // Search
  'tvbox_search_history',
  // Pan login (cookies/tokens)
  'pan_login_quark',
  'pan_login_uc',
  'pan_login_aliyun',
  'pan_login_baidu',
  'pan_login_bili',
];

function getIPC(): any {
  if ((window as any).electronIPC) {
    return (window as any).electronIPC;
  }
  try {
    const { ipcRenderer } = require('electron');
    return {
      invoke: (channel: string, ...args: any[]) =>
        ipcRenderer.invoke(channel, ...args),
    };
  } catch {
    console.warn('[ConfigSync] Electron IPC not available');
    return null;
  }
}

/**
 * 从文件恢复配置到 localStorage。
 * 仅在 localStorage 中没有对应 key 时写入（不覆盖已有值），
 * 这样如果用户在当前会话中已修改配置，不会被文件中的旧值覆盖。
 *
 * 但对于登录信息（pan_login_*），如果 localStorage 中有值则保留，
 * 否则从文件恢复。
 */
export async function restoreFromFile(): Promise<{
  restored: string[];
  error?: string;
}> {
  const ipc = getIPC();
  if (!ipc) {
    return { restored: [], error: 'IPC not available' };
  }

  try {
    const fileConfig: Record<string, string> = await ipc.invoke('config:load');
    if (!fileConfig || Object.keys(fileConfig).length === 0) {
      console.log('[ConfigSync] No config in file to restore');
      return { restored: [] };
    }

    const restored: string[] = [];
    for (const key of PERSISTED_KEYS) {
      if (key in fileConfig) {
        const currentValue = localStorage.getItem(key);
        // Only restore if localStorage doesn't have the value
        if (currentValue === null || currentValue === '') {
          localStorage.setItem(key, fileConfig[key]);
          restored.push(key);
          console.log(`[ConfigSync] Restored: ${key}`);
        }
      }
    }

    console.log(`[ConfigSync] Restored ${restored.length} keys from file`);
    return { restored };
  } catch (e: any) {
    console.error('[ConfigSync] restoreFromFile failed:', e);
    return { restored: [], error: e.message };
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 将 localStorage 中的关键配置保存到文件。
 * 使用防抖（500ms），避免频繁写入。
 */
export function saveToFile(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    doSave();
  }, 500);
}

async function doSave(): Promise<void> {
  const ipc = getIPC();
  if (!ipc) return;

  try {
    const data: Record<string, string> = {};
    for (const key of PERSISTED_KEYS) {
      const value = localStorage.getItem(key);
      if (value !== null && value !== '') {
        data[key] = value;
      }
    }

    const result = await ipc.invoke('config:save', data);
    if (result) {
      console.log(
        `[ConfigSync] Saved ${Object.keys(data).length} keys to file`,
      );
    } else {
      console.warn('[ConfigSync] saveToFile returned false');
    }
  } catch (e: any) {
    console.error('[ConfigSync] saveToFile failed:', e);
  }
}

/**
 * 立即保存（不使用防抖），用于应用退出前确保配置已持久化。
 */
export async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await doSave();
}
