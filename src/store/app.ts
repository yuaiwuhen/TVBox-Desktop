import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { configParser } from '../core/ConfigParser';
import { spiderEngine } from '../core/SpiderEngine';
import { ParseEngine } from '../core/ParseEngine';
import {
  Database,
  type HistoryRecord,
  type FavoriteRecord,
} from '../core/Database';
import type {
  SourceBean,
  Movie,
  MovieSort,
  FilterGroup,
  ParseBean,
  PlayResult,
  LiveChannelGroup,
} from '../core/models';

export const useAppStore = defineStore('app', () => {
  // ===== Config =====
  const configUrl = ref(localStorage.getItem('tvbox_config_url') || '');
  const sites = ref<SourceBean[]>([]);
  const activeSiteKey = ref(localStorage.getItem('tvbox_active_site') || '');
  const parses = ref<ParseBean[]>([]);
  const defaultParseName = ref(
    localStorage.getItem('tvbox_default_parse') || '',
  );
  const wallpaper = ref('');

  // ===== Home =====
  const classes = ref<MovieSort[]>([]);
  const filters = ref<Record<string, FilterGroup[]>>({});
  const homeVodList = ref<Movie[]>([]);
  const homeLoading = ref(false);

  // ===== Category =====
  const categoryVodList = ref<Movie[]>([]);
  const categoryPage = ref(1);
  const categoryPageCount = ref(1);
  const categoryLoading = ref(false);

  // ===== Detail =====
  const currentVod = ref<Movie | null>(null);
  const detailLoading = ref(false);

  // ===== Player =====
  const currentPlayUrl = ref('');
  const currentPlayHeader = ref<Record<string, string>>({});
  const currentPlayFlag = ref('');
  const currentPlayIndex = ref(0);
  const playLoading = ref(false);
  const currentEpisodes = ref<{ name: string; url: string }[]>([]);
  const resumeProgress = ref(0);

  // ===== Search =====
  const searchResults = ref<
    { siteKey: string; siteName: string; list: Movie[] }[]
  >([]);
  const searchLoading = ref(false);

  // ===== Live =====
  const liveGroups = ref<LiveChannelGroup[]>([]);
  const liveUrl = ref(localStorage.getItem('tvbox_live_url') || '');
  const epgUrl = ref(localStorage.getItem('tvbox_epg_url') || '');

  // ===== History / Favorites =====
  const historyList = ref<HistoryRecord[]>([]);
  const favoriteList = ref<FavoriteRecord[]>([]);

  // ===== Settings =====
  const playType = ref(Number(localStorage.getItem('tvbox_play_type') || '0'));
  const autoPlayNext = ref(
    localStorage.getItem('tvbox_autoplay_next') !== 'false',
  );
  const dohIndex = ref(Number(localStorage.getItem('tvbox_doh_index') || '0'));
  const searchViewMode = ref(
    Number(localStorage.getItem('tvbox_search_view') || '1'),
  );

  // ===== Computed =====
  const activeSite = computed(
    () => sites.value.find((s) => s.key === activeSiteKey.value) || null,
  );
  const activeParse = computed(() => {
    if (!defaultParseName.value && parses.value.length > 0)
      return parses.value[0];
    return (
      parses.value.find((p) => p.name === defaultParseName.value) ||
      parses.value[0] ||
      null
    );
  });

  // ===== Config Actions =====
  function setConfigUrl(url: string) {
    configUrl.value = url;
    localStorage.setItem('tvbox_config_url', url);
  }

  async function loadConfig(): Promise<boolean> {
    if (!configUrl.value) return false;
    try {
      await configParser.load(configUrl.value);
      sites.value = configParser.getSites().filter((s) => s.hide !== 1);
      parses.value = configParser.getParses();
      wallpaper.value = configParser.getWallpaper();
      liveGroups.value = configParser.getLiveChannelGroups();
      liveUrl.value = localStorage.getItem('tvbox_live_url') || '';
      epgUrl.value = localStorage.getItem('tvbox_epg_url') || '';

      if (
        !activeSiteKey.value ||
        !sites.value.find((s) => s.key === activeSiteKey.value)
      ) {
        if (sites.value.length > 0) setActiveSite(sites.value[0].key);
      }
      return true;
    } catch (e) {
      console.error('loadConfig failed:', e);
      return false;
    }
  }

  function setActiveSite(key: string) {
    activeSiteKey.value = key;
    localStorage.setItem('tvbox_active_site', key);
    const site = sites.value.find((s) => s.key === key);
    if (site) configParser.setHomeSource(site);
    resetHome();
  }

  function setDefaultParse(name: string) {
    defaultParseName.value = name;
    localStorage.setItem('tvbox_default_parse', name);
    const parse = parses.value.find((p) => p.name === name);
    if (parse) configParser.setDefaultParse(parse);
  }

  function resetHome() {
    classes.value = [];
    filters.value = {};
    homeVodList.value = [];
    categoryVodList.value = [];
    currentVod.value = null;
    currentPlayUrl.value = '';
  }

  // ===== Spider Data Actions =====
  async function loadHome() {
    if (!activeSite.value) return;
    homeLoading.value = true;
    try {
      const spider = await spiderEngine.getSpider(activeSite.value);
      if (!spider) {
        homeLoading.value = false;
        return;
      }

      const homeResult = JSON.parse(await spider.homeContent(true));
      if (homeResult.class) {
        classes.value = homeResult.class;
      }
      if (homeResult.filters) {
        filters.value = homeResult.filters;
      }
      if (homeResult.list && homeResult.list.length > 0) {
        homeVodList.value = homeResult.list;
      } else {
        const vodResult = JSON.parse(await spider.homeVideoContent());
        homeVodList.value = vodResult.list || vodResult.vod_list || [];
      }
    } catch (e) {
      console.error('loadHome failed:', e);
    } finally {
      homeLoading.value = false;
    }
  }

  async function loadCategory(
    tid: string,
    pg: string = '1',
    filterValues: Record<string, string> = {},
  ) {
    if (!activeSite.value) return;
    categoryLoading.value = true;
    try {
      const spider = await spiderEngine.getSpider(activeSite.value);
      if (!spider) {
        categoryLoading.value = false;
        return;
      }

      const hasFilter =
        activeSite.value.filterable === 1 &&
        Object.keys(filterValues).length > 0;
      const result = JSON.parse(
        await spider.categoryContent(tid, pg, hasFilter, filterValues),
      );

      if (result.class) classes.value = result.class;
      categoryVodList.value = result.list || [];
      categoryPage.value = parseInt(result.page || pg);
      categoryPageCount.value = parseInt(result.pagecount || '1');
    } catch (e) {
      console.error('loadCategory failed:', e);
    } finally {
      categoryLoading.value = false;
    }
  }

  async function loadDetail(vodId: string) {
    if (!activeSite.value) return;
    detailLoading.value = true;
    try {
      const spider = await spiderEngine.getSpider(activeSite.value);
      if (!spider) {
        detailLoading.value = false;
        return;
      }

      const result = JSON.parse(await spider.detailContent([vodId]));
      if (result.list && result.list.length > 0) {
        currentVod.value = {
          ...result.list[0],
          sourceKey: activeSite.value.key,
        };
      }
    } catch (e) {
      console.error('loadDetail failed:', e);
    } finally {
      detailLoading.value = false;
    }
  }

  async function loadPlay(
    flag: string,
    id: string,
    episodeIndex: number = 0,
    episodes?: { name: string; url: string }[],
  ) {
    if (!activeSite.value) return;
    playLoading.value = true;
    currentPlayIndex.value = episodeIndex;
    if (episodes) currentEpisodes.value = episodes;
    try {
      const spider = await spiderEngine.getSpider(activeSite.value);
      if (!spider) {
        playLoading.value = false;
        return;
      }

      const vipFlags = configParser.getVipParseFlags();
      const result: PlayResult = JSON.parse(
        await spider.playerContent(flag, id, vipFlags),
      );

      if (result.url) {
        // VIP parse: if parse === 1 or URL matches VIP flags, resolve via ParseEngine
        if (ParseEngine.needsParse(result)) {
          try {
            const resolvedUrl = await ParseEngine.resolve(
              result.url,
              result.header || '',
              vipFlags,
              activeParse.value || undefined,
              flag,
              activeSite.value?.clickSelector,
            );
            if (resolvedUrl && resolvedUrl !== result.url) {
              result.url = resolvedUrl;
              result.parse = 0; // Mark as resolved
            }
          } catch (e) {
            console.error('[App] VIP parse failed:', e);
          }
        }

        currentPlayUrl.value = result.url;
        currentPlayFlag.value = flag;
        if (result.header) {
          try {
            currentPlayHeader.value = JSON.parse(result.header);
          } catch {
            currentPlayHeader.value = {};
          }
        } else {
          currentPlayHeader.value = {};
        }

        // Restore progress from history
        const history = await Database.getHistory(
          activeSite.value.key,
          currentVod.value?.vod_id || '',
        );
        resumeProgress.value = history?.progress || 0;

        // Save to history
        if (currentVod.value) {
          await Database.saveHistory({
            ...currentVod.value,
            sourceKey: activeSite.value.key,
            playUrl: result.url,
            playFlag: flag,
            playIndex: episodeIndex,
            progress: 0,
            duration: 0,
            timestamp: Date.now(),
          });
        }
      }
    } catch (e) {
      console.error('loadPlay failed:', e);
    } finally {
      playLoading.value = false;
    }
  }

  async function savePlayProgress(progress: number, duration: number) {
    if (!activeSite.value || !currentVod.value) return;
    await Database.updateProgress(
      activeSite.value.key,
      currentVod.value.vod_id,
      progress,
      duration,
    );
  }

  function playNextEpisode(): string | null {
    if (currentPlayIndex.value < currentEpisodes.value.length - 1) {
      const next = currentEpisodes.value[currentPlayIndex.value + 1];
      currentPlayIndex.value++;
      return next.url;
    }
    return null;
  }

  function playPrevEpisode(): string | null {
    if (currentPlayIndex.value > 0) {
      const prev = currentEpisodes.value[currentPlayIndex.value - 1];
      currentPlayIndex.value--;
      return prev.url;
    }
    return null;
  }

  async function doSearch(keyword: string, siteKeys?: string[]) {
    searchLoading.value = true;
    searchResults.value = [];
    try {
      const targets =
        siteKeys && siteKeys.length > 0
          ? sites.value.filter(
              (s) => siteKeys.includes(s.key) && s.searchable !== 0,
            )
          : sites.value.filter((s) => s.searchable !== 0);

      const promises = targets.map(async (site) => {
        try {
          const spider = await spiderEngine.getSpider(site);
          if (!spider) return null;
          const result = JSON.parse(await spider.searchContent(keyword, true));
          return {
            siteKey: site.key,
            siteName: site.name,
            list: result.list || [],
          };
        } catch {
          return null;
        }
      });

      const results = await Promise.all(promises);
      searchResults.value = results.filter(
        (r) => r && r.list.length > 0,
      ) as typeof searchResults.value;
    } catch (e) {
      console.error('doSearch failed:', e);
    } finally {
      searchLoading.value = false;
    }
  }

  // ===== History / Favorites =====
  async function refreshHistory() {
    historyList.value = await Database.getAllHistory();
  }

  async function refreshFavorites() {
    favoriteList.value = await Database.getAllFavorites();
  }

  async function toggleFavorite(vod: Movie, sourceKey: string) {
    await Database.toggleFavorite(sourceKey, vod);
    await refreshFavorites();
  }

  async function clearHistory() {
    await Database.clearHistory();
    historyList.value = [];
  }

  // ===== Settings Persistence =====
  function setPlayType(v: number) {
    playType.value = v;
    localStorage.setItem('tvbox_play_type', String(v));
  }
  function setAutoPlayNext(v: boolean) {
    autoPlayNext.value = v;
    localStorage.setItem('tvbox_autoplay_next', String(v));
  }
  function setDohIndex(v: number) {
    dohIndex.value = v;
    localStorage.setItem('tvbox_doh_index', String(v));
  }
  function setSearchViewMode(v: number) {
    searchViewMode.value = v;
    localStorage.setItem('tvbox_search_view', String(v));
  }
  function setLiveUrl(v: string) {
    liveUrl.value = v;
    localStorage.setItem('tvbox_live_url', v);
  }
  function setEpgUrl(v: string) {
    epgUrl.value = v;
    localStorage.setItem('tvbox_epg_url', v);
  }

  return {
    configUrl,
    sites,
    activeSiteKey,
    parses,
    defaultParseName,
    wallpaper,
    classes,
    filters,
    homeVodList,
    homeLoading,
    categoryVodList,
    categoryPage,
    categoryPageCount,
    categoryLoading,
    currentVod,
    detailLoading,
    currentPlayUrl,
    currentPlayHeader,
    currentPlayFlag,
    currentPlayIndex,
    currentEpisodes,
    resumeProgress,
    playLoading,
    searchResults,
    searchLoading,
    liveGroups,
    liveUrl,
    epgUrl,
    historyList,
    favoriteList,
    playType,
    autoPlayNext,
    dohIndex,
    searchViewMode,
    activeSite,
    activeParse,
    setConfigUrl,
    loadConfig,
    setActiveSite,
    setDefaultParse,
    loadHome,
    loadCategory,
    loadDetail,
    loadPlay,
    savePlayProgress,
    playNextEpisode,
    playPrevEpisode,
    doSearch,
    refreshHistory,
    refreshFavorites,
    toggleFavorite,
    clearHistory,
    setPlayType,
    setAutoPlayNext,
    setDohIndex,
    setSearchViewMode,
    setLiveUrl,
    setEpgUrl,
    resetHome,
  };
});
