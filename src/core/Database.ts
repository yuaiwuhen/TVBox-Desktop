import localforage from 'localforage';
import type { HistoryRecord, FavoriteRecord, Movie } from './models';

const historyStore = localforage.createInstance({
  name: 'TVBox-PC',
  storeName: 'history',
});
const favoritesStore = localforage.createInstance({
  name: 'TVBox-PC',
  storeName: 'favorites',
});

export type { HistoryRecord, FavoriteRecord };

export class Database {
  // ---- History ----
  // 使用影视名称作为key，让不同源的相同影视剧共享进度
  static async saveHistory(record: HistoryRecord): Promise<void> {
    const vodName = record.vod_name || '';
    // 包含playIndex，让不同集数有独立的历史记录
    const id = `${vodName}_${record.playIndex || 0}`;
    console.log(
      `[Database] saveHistory key: "${id}" (vod_name="${vodName}", playIndex=${record.playIndex || 0})`,
    );
    const existing = await historyStore.getItem<HistoryRecord>(id);
    await historyStore.setItem(id, {
      ...record,
      timestamp: Date.now(),
      // Preserve progress if updating
      progress: existing?.progress || record.progress || 0,
      duration: existing?.duration || record.duration || 0,
    });
  }

  static async updateProgress(
    sourceKey: string,
    vodId: string,
    progress: number,
    duration: number,
    episodeIndex: number = 0,
    vodName?: string,
  ): Promise<void> {
    // 使用影视名称作为key
    const name = vodName || vodId;
    const id = `${name}_${episodeIndex}`;
    const existing = await historyStore.getItem<HistoryRecord>(id);
    // 如果记录存在，更新进度；否则创建新记录
    if (existing) {
      await historyStore.setItem(id, { ...existing, progress, duration });
    } else {
      // 没有现有记录时也保存进度
      await historyStore.setItem(id, {
        sourceKey,
        vod_id: vodId,
        vod_name: name,
        playIndex: episodeIndex,
        progress,
        duration,
        timestamp: Date.now(),
      } as HistoryRecord);
    }
  }

  static async getHistory(
    sourceKey: string,
    vodId: string,
    episodeIndex: number = 0,
    vodName?: string,
  ): Promise<HistoryRecord | null> {
    // 使用影视名称作为key
    const name = vodName || vodId;
    const id = `${name}_${episodeIndex}`;
    console.log(
      `[Database] getHistory key: "${id}" (vodName="${vodName || ''}", vodId="${vodId}", episodeIndex=${episodeIndex})`,
    );
    const result = await historyStore.getItem<HistoryRecord>(id);
    console.log(
      `[Database] getHistory result: ${result ? `progress=${result.progress}s` : 'null'}`,
    );
    return result;
  }

  static async getAllHistory(): Promise<HistoryRecord[]> {
    const results: HistoryRecord[] = [];
    await historyStore.iterate<HistoryRecord, void>((value) => {
      results.push(value);
    });
    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  static async clearHistory(): Promise<void> {
    await historyStore.clear();
  }

  static async removeHistory(
    vodName: string,
    episodeIndex?: number,
  ): Promise<void> {
    if (episodeIndex !== undefined) {
      // 删除特定集数的历史
      await historyStore.removeItem(`${vodName}_${episodeIndex}`);
    } else {
      // 删除该影视剧所有集数的历史
      const keysToRemove: string[] = [];
      await historyStore.iterate<HistoryRecord, void>((_, key) => {
        if (key.startsWith(`${vodName}_`)) {
          keysToRemove.push(key);
        }
      });
      for (const key of keysToRemove) {
        await historyStore.removeItem(key);
      }
    }
  }

  // ---- Favorites ----
  static async toggleFavorite(sourceKey: string, vod: Movie): Promise<boolean> {
    const id = `${sourceKey}_${vod.vod_id}`;
    const existing = await favoritesStore.getItem(id);
    if (existing) {
      await favoritesStore.removeItem(id);
      return false;
    } else {
      await favoritesStore.setItem(id, {
        ...vod,
        sourceKey,
        timestamp: Date.now(),
      } as FavoriteRecord);
      return true;
    }
  }

  static async isFavorite(sourceKey: string, vodId: string): Promise<boolean> {
    return !!(await favoritesStore.getItem(`${sourceKey}_${vodId}`));
  }

  static async getAllFavorites(): Promise<FavoriteRecord[]> {
    const results: FavoriteRecord[] = [];
    await favoritesStore.iterate<FavoriteRecord, void>((value) => {
      results.push(value);
    });
    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  static async removeFavorite(sourceKey: string, vodId: string): Promise<void> {
    await favoritesStore.removeItem(`${sourceKey}_${vodId}`);
  }
}
