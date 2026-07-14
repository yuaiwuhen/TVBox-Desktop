import { app } from 'electron';
import path from 'path';
import fs from 'fs';

const CONFIG_FILE_NAME = 'config.json';

function getConfigPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE_NAME);
}

export function loadConfigFromFile(): Record<string, string> {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
      console.log('[ConfigPersistence] No config file yet:', configPath);
      return {};
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      console.log('[ConfigPersistence] Loaded', Object.keys(data).length, 'keys from', configPath);
      return data as Record<string, string>;
    }
    console.warn('[ConfigPersistence] Invalid config format, ignoring');
    return {};
  } catch (e) {
    console.error('[ConfigPersistence] Failed to load config:', e);
    return {};
  }
}

export function saveConfigToFile(data: Record<string, string>): boolean {
  try {
    const configPath = getConfigPath();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = configPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, configPath);
    console.log('[ConfigPersistence] Saved', Object.keys(data).length, 'keys to', configPath);
    return true;
  } catch (e) {
    console.error('[ConfigPersistence] Failed to save config:', e);
    return false;
  }
}
