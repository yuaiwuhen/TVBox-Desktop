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
  static async saveHistory(record: HistoryRecord): Promise<void> {
    const id = `${record.sourceKey}_${record.vod_id}`;
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
  ): Promise<void> {
    const id = `${sourceKey}_${vodId}`;
    const existing = await historyStore.getItem<HistoryRecord>(id);
    if (existing) {
      await historyStore.setItem(id, { ...existing, progress, duration });
    }
  }

  static async getHistory(
    sourceKey: string,
    vodId: string,
  ): Promise<HistoryRecord | null> {
    return await historyStore.getItem<HistoryRecord>(`${sourceKey}_${vodId}`);
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

  static async removeHistory(sourceKey: string, vodId: string): Promise<void> {
    await historyStore.removeItem(`${sourceKey}_${vodId}`);
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
