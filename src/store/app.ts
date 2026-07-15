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
import { PanLogin, type PanType } from '../core/PanLogin';
import { saveToFile } from '../core/ConfigSync';
import type {
  SourceBean,
  Movie,
  MovieSort,
  FilterGroup,
  ParseBean,
  PlayResult,
  LiveChannelGroup,
} from '../core/models';

async function buildConfigCenterVodList(): Promise<Movie[]> {
  const panTypes: PanType[] = ['quark', 'uc', 'aliyun', 'baidu', 'bili'];
  const results = await Promise.all(
    panTypes.map(async (panType) => {
      const savedLoggedIn = PanLogin.isLoggedIn(panType);
      const info = PanLogin.getLoginInfo(panType);
      const capName = panType.charAt(0).toUpperCase() + panType.slice(1);
      const actionPrefix = panType === 'aliyun' ? 'Ali' : capName;
      // Verify token validity via API call (only for Quark currently)
      let actualLoggedIn = savedLoggedIn;
      if (savedLoggedIn) {
        actualLoggedIn = await PanLogin.checkTokenValid(panType);
        if (savedLoggedIn && !actualLoggedIn) {
          console.log(
            `[Store] buildConfigCenterVodList: ${panType} token expired, auto-logging out`,
          );
          PanLogin.logout(panType);
        }
      }
      const action = actualLoggedIn
        ? `del${actionPrefix}`
        : `add${actionPrefix}`;
      console.log(
        `[Store] buildConfigCenterVodList: ${panType} savedLoggedIn=${savedLoggedIn} actualLoggedIn=${actualLoggedIn} action=${action}`,
      );
      return {
        vod_id: action,
        vod_name: PanLogin.getDisplayName(panType),
        vod_pic: `/icons/${panType}.png`,
        vod_remarks: actualLoggedIn
          ? `已登录: ${info?.nickname || info?.userId || '未知'}`
          : '点击扫码登录',
        action,
      };
    }),
  );
  return results;
}

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
  const activeCategory = ref(''); // 当前选中的分类
  const filterValues = ref<Record<string, string>>({}); // 当前选中的筛选值

  // ===== Category =====
  const categoryVodList = ref<Movie[]>([]);
  const categoryPage = ref(1);
  const categoryPageCount = ref(1);
  const categoryLoading = ref(false);

  // ===== Detail =====
  const currentVod = ref<Movie | null>(null);
  const detailLoading = ref(false);
  const detailError = ref('');

  // ===== Player =====
  const currentPlayUrl = ref('');
  const currentPlayHeader = ref<Record<string, string>>({});
  const currentPlayFlag = ref('');
  const currentPlayIndex = ref(0);
  const currentDanmuUrl = ref('');
  const playLoading = ref(false);
  const currentEpisodes = ref<{ name: string; url: string }[]>([]);
  const resumeProgress = ref(0);
  const playError = ref('');
  // True when loadPlay launched an external player (VLC) for unsupported
  // formats. The test suite uses this to count as "play success" since
  // currentPlayUrl/playError are intentionally left empty in this path.
  const externalPlayerLaunched = ref(false);

  // ===== Request cancellation =====
  let detailAbortController: AbortController | null = null;
  let playAbortController: AbortController | null = null;

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

  function getUniqueKey(source: SourceBean): string {
    return `${source.key}-${source.name}`;
  }

  // ===== Computed =====
  const activeSite = computed(() => {
    const found = sites.value.find(
      (s) => getUniqueKey(s) === activeSiteKey.value,
    );
    if (!found) {
      return sites.value.find((s) => s.key === activeSiteKey.value) || null;
    }
    return found;
  });
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
    saveToFile();
  }

  async function loadConfig(): Promise<boolean> {
    if (!configUrl.value) return false;
    try {
      await configParser.load(configUrl.value);
      sites.value = configParser.getSites().filter((s) => s.hide !== 1);
      parses.value = configParser.getParses();
      wallpaper.value = configParser.getWallpaper();
      liveGroups.value = configParser.getLiveChannelGroups();
      liveUrl.value =
        localStorage.getItem('tvbox_live_url') ||
        configParser.getConfigLiveUrl() ||
        '';
      epgUrl.value = localStorage.getItem('tvbox_epg_url') || '';

      // Pass the spider base URL to SpiderEngine for resolving api key names
      const spiderBase = configParser.getSpider();
      if (spiderBase) {
        spiderEngine.setSpiderBaseUrl(spiderBase);
      }
      // Pass config URL as fallback base URL for resolving relative paths
      spiderEngine.setConfigUrl(configUrl.value);

      if (
        !activeSiteKey.value ||
        !sites.value.find((s) => getUniqueKey(s) === activeSiteKey.value)
      ) {
        if (sites.value.length > 0) setActiveSite(getUniqueKey(sites.value[0]));
      }
      return true;
    } catch (e) {
      console.error('loadConfig failed:', e);
      return false;
    }
  }

  function setActiveSite(key: string) {
    const oldKey = activeSiteKey.value;

    let site = sites.value.find((s) => getUniqueKey(s) === key);
    if (!site) {
      site = sites.value.find((s) => s.key === key);
    }

    const newUniqueKey = site ? getUniqueKey(site) : key;

    // Same site: skip resetHome to preserve cached home/category data
    // (e.g., when returning from Detail page)
    if (oldKey === newUniqueKey) {
      console.log(
        `[Store] setActiveSite: same key (${oldKey}), skipping resetHome`,
      );
      return;
    }

    console.log(
      `[Store] setActiveSite: oldKey=${oldKey}, newKey=${newUniqueKey}`,
    );
    activeSiteKey.value = newUniqueKey;
    localStorage.setItem('tvbox_active_site', newUniqueKey);
    saveToFile();
    if (site) configParser.setHomeSource(site);
    resetHome(oldKey);
  }

  function setDefaultParse(name: string) {
    defaultParseName.value = name;
    localStorage.setItem('tvbox_default_parse', name);
    saveToFile();
    const parse = parses.value.find((p) => p.name === name);
    if (parse) configParser.setDefaultParse(parse);
  }

  function resetHome(oldKey?: string) {
    console.log('[Store] resetHome called, oldKey:', oldKey);
    console.log('[Store] resetHome stack:', new Error().stack);
    classes.value = [];
    filters.value = {};
    homeVodList.value = [];
    categoryVodList.value = [];
    currentVod.value = null;
    currentPlayUrl.value = '';
    if (oldKey) {
      console.log(
        `[Store] resetHome: clearing spider cache for oldKey=${oldKey}`,
      );
      spiderEngine.clear(oldKey);
    }
  }

  // ===== Spider Data Actions =====
  async function loadHome(force = false) {
    if (!activeSite.value) {
      console.warn('[Store] loadHome: no active site');
      return;
    }

    const apiLower = (activeSite.value.api || '').toLowerCase();
    const keyLower = (activeSite.value.key || '').toLowerCase();
    const isConfigCenter =
      keyLower === 'config' ||
      apiLower.includes('config') ||
      (activeSite.value.name || '').includes('配置');

    // Config center always needs fresh data (token states change independently).
    // For non-config sites, use cached data unless forced.
    if (!force && !isConfigCenter && homeVodList.value.length > 0) {
      console.log('[Store] loadHome: using cached data');
      return;
    }

    if (force && activeSite.value.key) {
      console.log(
        '[Store] loadHome: force reload, clearing spider cache for',
        activeSite.value.key,
      );
      spiderEngine.clear(activeSite.value.key);
    }

    homeLoading.value = true;
    console.log(
      '[Store] loadHome request:',
      JSON.stringify(
        {
          siteKey: activeSite.value.key,
          siteName: activeSite.value.name,
          api: activeSite.value.api,
          ext: (activeSite.value.ext || '').substring(0, 300),
          jar: activeSite.value.jar,
          force,
        },
        null,
        2,
      ),
    );

    if (isConfigCenter) {
      console.log('[Store] loadHome: config center (hardcoded)');
      try {
        classes.value = [];
        filters.value = {};
        homeVodList.value = await buildConfigCenterVodList();
      } finally {
        homeLoading.value = false;
      }
      return;
    }

    try {
      const spider = await spiderEngine.getSpider(activeSite.value);
      if (!spider) {
        console.warn(
          `[Store] loadHome: spider is null for ${activeSite.value.key}`,
        );
        homeLoading.value = false;
        return;
      }

      const rawHome = await spider.homeContent(true);
      console.log(
        '[Store] loadHome homeContent response:',
        JSON.stringify(
          {
            rawLength: rawHome.length,
            rawPreview: rawHome.substring(0, 300),
          },
          null,
          2,
        ),
      );
      const homeResult = JSON.parse(rawHome);
      console.log(
        '[Store] loadHome parsed response:',
        JSON.stringify(
          {
            classCount:
              homeResult.class?.length || homeResult.data?.list?.length || 0,
            listCount: homeResult.list?.length || 0,
            filterCount: homeResult.filters
              ? Object.keys(homeResult.filters).length
              : 0,
            firstClass:
              homeResult.class?.[0] || homeResult.data?.list?.[0] || null,
            firstItem: homeResult.list?.[0] || null,
          },
          null,
          2,
        ),
      );

      let hasHomeData = false;
      if (homeResult.list && homeResult.list.length > 0) {
        homeVodList.value = homeResult.list;
        hasHomeData = true;
      }

      if (homeResult.class) {
        classes.value = homeResult.class;
      } else if (homeResult.data?.list && Array.isArray(homeResult.data.list)) {
        classes.value = homeResult.data.list;
      }

      if (hasHomeData && classes.value.length > 0) {
        classes.value = [
          { type_id: '__recommend__', type_name: '推荐' },
          ...classes.value,
        ];
        console.log(
          '[Store] loadHome: added recommend category at front, total classes:',
          classes.value.length,
        );
      }

      if (homeResult.filters) {
        filters.value = homeResult.filters;
      }

      if (!hasHomeData) {
        const rawVod = await spider.homeVideoContent();
        console.log(
          '[Store] loadHome homeVideoContent response:',
          JSON.stringify(
            {
              rawLength: rawVod?.length || 0,
              rawPreview: rawVod ? rawVod.substring(0, 300) : '',
            },
            null,
            2,
          ),
        );
        let vodResult: any = { list: [] };
        if (rawVod && rawVod.trim().length > 0) {
          try {
            vodResult = JSON.parse(rawVod);
          } catch (e) {
            console.warn(
              '[Store] loadHome: homeVideoContent returned invalid JSON, treating as empty',
            );
          }
        }
        homeVodList.value = vodResult.list || vodResult.vod_list || [];
        console.log(
          '[Store] loadHome homeVideoContent parsed:',
          JSON.stringify(
            {
              listCount: homeVodList.value.length,
              firstItem: homeVodList.value[0] || null,
            },
            null,
            2,
          ),
        );
      }
    } catch (e) {
      console.error('[Store] loadHome failed:', e);
    } finally {
      homeLoading.value = false;
    }
  }

  // 设置当前分类
  function setCategory(tid: string) {
    activeCategory.value = tid;
    filterValues.value = {};
  }

  // Toggle a filter value (no API call — caller applies via applyFilters)
  function setFilter(key: string, value: string) {
    if (filterValues.value[key] === value) {
      delete filterValues.value[key];
    } else {
      filterValues.value[key] = value;
    }
    filterValues.value = { ...filterValues.value };
  }

  // Apply current filters and reload category (page 1)
  async function applyFilters() {
    if (activeCategory.value && activeCategory.value !== '__recommend__') {
      await loadCategory(activeCategory.value, '1', filterValues.value);
    }
  }

  async function runSpiderAction(actionId: string, actionData: any) {
    if (!activeSite.value) return;
    console.log(
      `[Store] runSpiderAction: action=${actionId}, site=${activeSite.value.name}`,
    );
    try {
      const spider = await spiderEngine.getSpider(activeSite.value);
      if (!spider) {
        console.warn(`[Store] runSpiderAction: spider is null`);
        return;
      }

      const result = await spider.action(actionId, actionData);
      console.log(`[Store] runSpiderAction: result=`, result);

      const parsed = JSON.parse(result);
      if (parsed.msg) {
        console.log(`[Store] runSpiderAction: message=${parsed.msg}`);
      }

      if (parsed.refresh) {
        await loadHome();
      }
    } catch (e) {
      console.error('runSpiderAction failed:', e);
    }
  }

  async function loadCategory(
    tid: string,
    pg: string = '1',
    filterValues: Record<string, string> = {},
  ) {
    if (!activeSite.value) return;
    categoryLoading.value = true;
    // Only clear the list on page 1 (or first load); scroll-to-bottom appends
    if (pg === '1') {
      categoryVodList.value = [];
    }
    console.log(
      `[Store] loadCategory: site=${activeSite.value.name} key=${activeSite.value.key}, tid=${tid}, pg=${pg}, filterValues=${JSON.stringify(filterValues)}`,
    );
    try {
      const spider = await spiderEngine.getSpider(activeSite.value);
      if (!spider) {
        console.warn(`[Store] loadCategory: spider is null`);
        categoryLoading.value = false;
        return;
      }

      const hasFilter =
        activeSite.value.filterable === 1 &&
        Object.keys(filterValues).length > 0;
      // Vue reactive proxy cannot be cloned by Electron IPC — convert to plain object
      const plainFilterValues = JSON.parse(JSON.stringify(filterValues));
      const rawResult = await spider.categoryContent(
        tid,
        pg,
        hasFilter,
        plainFilterValues,
      );
      let result: any;
      try {
        result =
          typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
      } catch {
        result = { list: [] };
      }
      console.log(`[Store] loadCategory: raw result:`, result);
      console.log(
        `[Store] loadCategory: parsed list=${result.list?.length || 0}, page=${result.page || pg}, pagecount=${result.pagecount || 1}`,
      );

      if (pg === '1') {
        categoryVodList.value = result.list || [];
      } else {
        // Append for scroll-to-bottom pagination
        const newItems = result.list || [];
        categoryVodList.value = [...categoryVodList.value, ...newItems];
      }
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

    if (detailAbortController) {
      detailAbortController.abort();
    }
    detailAbortController = new AbortController();

    detailLoading.value = true;
    detailError.value = '';
    currentVod.value = null;
    try {
      const spider = await spiderEngine.getSpider(activeSite.value);
      if (!spider) {
        detailLoading.value = false;
        detailError.value = '无法加载源，请稍后重试';
        return;
      }

      const rawResult = await spider.detailContent([vodId]);
      console.log(
        '[Store] loadDetail rawResult:',
        rawResult?.substring?.(0, 1000),
      );
      if (!rawResult || !rawResult.trim()) {
        detailError.value =
          '该资源无法解析（源未返回数据），可能已下线或分享链接已失效';
        return;
      }
      let result: any;
      try {
        result = JSON.parse(rawResult);
      } catch {
        detailError.value = '源返回的数据格式异常，可能资源已下线';
        return;
      }
      if (!result.list || result.list.length === 0) {
        detailError.value = '未找到该资源的详情信息，可能已下线';
        return;
      }

      const vod = result.list[0];
      console.log('[Store] loadDetail vod:', {
        vod_id: vod.vod_id,
        vod_name: vod.vod_name,
        vod_play_from: vod.vod_play_from,
        vod_play_url: vod.vod_play_url,
        vod_play_url_length: vod.vod_play_url?.length,
        vod_keys: Object.keys(vod),
      });
      currentVod.value = {
        ...vod,
        sourceKey: activeSite.value.key,
      };
      // 若返回了 vod 但没有播放源，给出更具体的提示
      if (!vod.vod_play_from || !vod.vod_play_url) {
        // Prioritize URL/domain detection from the site's api URL.
        // Falls back to key/name matching for sites without a URL-style api.
        const apiLower = (activeSite.value.api || '').toLowerCase();
        const keyLower = (activeSite.value.key || '').toLowerCase();
        const nameLower = (activeSite.value.name || '').toLowerCase();
        const isPan =
          apiLower.includes('quark.cn') ||
          apiLower.includes('drive.uc.cn') ||
          apiLower.includes('pan.baidu.com') ||
          apiLower.includes('alipan.com') ||
          apiLower.includes('aliyundrive.com') ||
          apiLower.includes('bilibili.com') ||
          keyLower.includes('quark') ||
          keyLower.includes('uc') ||
          keyLower.includes('baidu') ||
          keyLower.includes('ali') ||
          nameLower.includes('夸克') ||
          nameLower.includes('百度') ||
          nameLower.includes('阿里') ||
          (vod as any).needPanLogin;
        if (isPan) {
          // 触发 needPanLogin UI 分支
          (currentVod.value as any).needPanLogin = true;
        } else {
          detailError.value =
            '该资源暂无可播放的源，可能分享链接已失效或资源已下线';
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        console.warn('loadDetail failed:', e.message);
        detailError.value = `加载详情失败: ${e.message || '未知错误'}`;
      }
    } finally {
      detailLoading.value = false;
      detailAbortController = null;
    }
  }

  async function loadPlay(
    flag: string,
    id: string,
    episodeIndex: number = 0,
    episodes?: { name: string; url: string }[],
  ) {
    console.log('[Store] loadPlay ENTER:', {
      flag,
      idPreview: id.substring(0, 80),
      idLength: id.length,
      episodeIndex,
      hasActiveSite: !!activeSite.value,
    });
    if (!activeSite.value) return;

    if (playAbortController) {
      playAbortController.abort();
    }
    playAbortController = new AbortController();

    playLoading.value = true;
    playError.value = '';
    // Reset external player flag at the start of every loadPlay call so
    // previous VLC launches don't leak into this one.
    externalPlayerLaunched.value = false;
    // Clear current URL immediately so old player stops before new
    // one starts loading. Without this, switching sources leaves the
    // old video playing until loadPlay completes (seconds later).
    currentPlayUrl.value = '';
    currentDanmuUrl.value = '';
    currentPlayIndex.value = episodeIndex;
    if (episodes) currentEpisodes.value = episodes;
    try {
      const spider = await spiderEngine.getSpider(activeSite.value);
      console.log('[Store] loadPlay: got spider:', {
        spiderType: spider?.constructor?.name,
        hasPlayerContent: typeof spider?.playerContent,
      });
      if (!spider) {
        playLoading.value = false;
        playError.value = '无法加载源，请稍后重试';
        return;
      }

      const vipFlags = configParser.getVipParseFlags();
      console.log('[Store] loadPlay: calling playerContent...', {
        flag,
        idPreview: id.substring(0, 80),
        vipFlagsCount: vipFlags?.length || 0,
      });
      const rawResult = await spider.playerContent(flag, id, vipFlags);
      console.log('[Store] loadPlay playerContent returned:', {
        rawLength: rawResult?.length || 0,
        rawPreview: rawResult ? rawResult.substring(0, 300) : '(empty)',
        flag,
        idPreview: id.substring(0, 80),
      });
      if (!rawResult || !rawResult.trim()) {
        playError.value = '源未返回播放地址，该资源可能已下线或分享链接已失效';
        return;
      }
      let result: PlayResult;
      try {
        result = JSON.parse(rawResult);
      } catch {
        playError.value = '播放地址解析失败，可能资源已下线';
        return;
      }
      console.log('[Store] loadPlay parsed result:', {
        hasUrl: !!result.url,
        hasHeader: !!result.header,
        parse: result.parse,
        urlPreview: result.url ? result.url.substring(0, 100) : '(none)',
        error: (result as any).error,
      });

      // 检查是否是 UNSUPPORTED_FORMAT 错误（由 ProxyServer 返回）
      if ((result as any).error === 'UNSUPPORTED_FORMAT') {
        console.warn(
          '[Store] loadPlay: 不支持的视频格式:',
          (result as any).format,
        );

        const vlcPath = localStorage.getItem('tvbox_vlc_path') || '';
        const directUrl = (result as any).directUrl || '';

        if (vlcPath) {
          // 已配置VLC，直接使用VLC播放，不弹窗
          console.log('[Store] loadPlay: 使用VLC播放:', vlcPath, directUrl);
          const { ipcRenderer } = window.require('electron');
          await ipcRenderer.invoke('open-external-player', vlcPath, directUrl);

          // 保存播放记录（标记为外部播放）
          if (currentVod.value) {
            await Database.saveHistory({
              ...currentVod.value,
              sourceKey: activeSite.value.key,
              playUrl: directUrl,
              playFlag: flag,
              playIndex: episodeIndex,
              progress: 0,
              duration: 0,
              timestamp: Date.now(),
            });
          }

          // Mark that we handed playback off to VLC so callers (e.g. the
          // E2E test suite) can treat this as a successful play path even
          // though currentPlayUrl/playError are intentionally left empty.
          externalPlayerLaunched.value = true;
          playLoading.value = false;
          return;
        } else {
          // 没有配置VLC，弹窗提示并显示播放地址
          playError.value =
            (result as any).message || '此视频格式不支持网页播放';

          const { ipcRenderer } = window.require('electron');
          ipcRenderer.invoke('show-unsupported-format-dialog', {
            format: (result as any).format || '未知格式',
            directUrl: directUrl,
            hasVlcPath: false,
            vlcPath: '',
          });

          playLoading.value = false;
          return;
        }
      }

      if (!result.url) {
        // 优先使用 spider 返回的具体错误信息
        const spiderMsg = (result as any).msg || (result as any).errMsg || '';
        if (spiderMsg) {
          playError.value = spiderMsg;
        } else {
          playError.value = '视频资源已失效，请尝试其他源或稍后重试';
        }
        playLoading.value = false;
        return;
      }
      // 先获取历史进度，再设置URL（避免时序问题）
      const history = await Database.getHistory(
        activeSite.value.key,
        currentVod.value?.vod_id || '',
        episodeIndex,
        currentVod.value?.vod_name,
      );
      console.log(
        `[Store] loadPlay: getHistory returned progress=${history?.progress || 0}s for episodeIndex=${episodeIndex}`,
      );
      resumeProgress.value = history?.progress || 0;

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
            result.parse = 0;
          }
        } catch (e) {
          console.warn('[App] VIP parse failed:', e);
        }
      }

      // 主动检测视频格式（在播放器弹出前）
      // 通过IPC让主进程发GET请求检测Content-Type
      // 这比文件名检测更可靠，因为使用实际的HTTP响应头
      const isProxyUrl =
        result.url.includes('/proxy?do=ali') ||
        result.url.includes('/proxy?do=quarkDirect') ||
        result.url.includes('/proxy?do=ucDirect') ||
        result.url.includes('/proxy?do=baiduDirect') ||
        result.url.includes('/proxy?do=aliyunDirect') ||
        result.url.includes('/proxy?do=115Direct');

      if (isProxyUrl) {
        console.log(
          '[Store] loadPlay: 检测视频格式...',
          result.url.substring(0, 80),
        );
        const { ipcRenderer } = window.require('electron');
        let headerObj: Record<string, string> = {};
        if (result.header) {
          try {
            headerObj = JSON.parse(result.header);
          } catch {}
        }
        let formatInfo: any;
        try {
          formatInfo = await ipcRenderer.invoke(
            'check-video-format',
            result.url,
            headerObj,
          );
        } catch (e: any) {
          console.warn(
            '[Store] loadPlay: 格式检测失败，继续尝试播放:',
            e.message,
          );
          formatInfo = { error: e.message };
        }
        console.log('[Store] loadPlay: 格式检测结果:', formatInfo);

        if (formatInfo.unsupported) {
          const vlcPath = localStorage.getItem('tvbox_vlc_path') || '';
          // VLC 使用 proxy URL 并添加 player=external 参数
          // ProxyServer 会跳过格式检测，直接流式传输
          const separator = result.url.includes('?') ? '&' : '?';
          const vlcUrl = result.url + separator + 'player=external';

          if (vlcPath) {
            // 已配置VLC，直接调用VLC播放，不弹窗
            console.log('[Store] loadPlay: 使用VLC播放:', vlcPath, vlcUrl);
            await ipcRenderer.invoke('open-external-player', vlcPath, vlcUrl);

            if (currentVod.value) {
              await Database.saveHistory({
                ...currentVod.value,
                sourceKey: activeSite.value.key,
                playUrl: vlcUrl,
                playFlag: flag,
                playIndex: episodeIndex,
                progress: 0,
                duration: 0,
                timestamp: Date.now(),
              });
            }

            // Mark that we handed playback off to VLC so callers (e.g. the
            // E2E test suite) can treat this as a successful play path even
            // though currentPlayUrl/playError are intentionally left empty.
            externalPlayerLaunched.value = true;
            playLoading.value = false;
            return;
          } else {
            // 没有配置VLC，弹窗提示并显示播放地址
            playError.value =
              formatInfo.message ||
              '此视频格式不支持网页播放，请使用第三方播放器打开';
            await ipcRenderer.invoke('show-unsupported-format-dialog', {
              format: formatInfo.format || formatInfo.contentType || '未知格式',
              directUrl: vlcUrl,
              hasVlcPath: false,
              vlcPath: '',
            });
            playLoading.value = false;
            return;
          }
        } else if (formatInfo.invalid) {
          playError.value = '视频资源已失效，请尝试其他源或稍后重试';
          playLoading.value = false;
          return;
        }
        // 格式支持或检测失败，继续播放
      }

      // 设置URL（触发VideoPlayer重新初始化，此时resumeProgress已正确）
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
      currentDanmuUrl.value = (result as any).danmuUrl || '';

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
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        console.warn('loadPlay failed:', e.message);
        playError.value = `播放失败: ${e.message || '未知错误'}`;
      }
    } finally {
      playLoading.value = false;
      playAbortController = null;
    }
  }

  async function savePlayProgress(progress: number, duration: number) {
    if (!activeSite.value || !currentVod.value) return;
    await Database.updateProgress(
      activeSite.value.key,
      currentVod.value.vod_id,
      progress,
      duration,
      currentPlayIndex.value,
      currentVod.value.vod_name,
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
    console.log(
      `[Store] doSearch: keyword=${keyword}, siteKeys=${siteKeys?.join(',') || 'all'}`,
    );
    try {
      const targets =
        siteKeys && siteKeys.length > 0
          ? sites.value.filter(
              (s) => siteKeys.includes(getUniqueKey(s)) && s.searchable !== 0,
            )
          : sites.value.filter((s) => s.searchable !== 0);

      console.log(`[Store] doSearch: searching across ${targets.length} sites`);

      const promises = targets.map(async (site) => {
        try {
          const spider = await spiderEngine.getSpider(site);
          if (!spider) {
            console.warn(`[Store] doSearch: spider is null for ${site.name}`);
            return null;
          }
          const rawResult = await spider.searchContent(keyword, true);
          let parsedRaw: any;
          try {
            parsedRaw = JSON.parse(rawResult);
          } catch {
            parsedRaw = rawResult;
          }
          console.log(`[Store] doSearch: ${site.name} raw result:`, parsedRaw);
          const result = JSON.parse(rawResult);
          const list = result.list || [];
          console.log(
            `[Store] doSearch: ${site.name} found ${list.length} results`,
          );
          return {
            siteKey: getUniqueKey(site),
            siteName: site.name,
            list,
          };
        } catch (e) {
          console.error(`[Store] doSearch: ${site.name} failed:`, e);
          return null;
        }
      });

      const results = await Promise.all(promises);
      const validResults = results.filter(
        (r) => r && r.list.length > 0,
      ) as typeof searchResults.value;
      searchResults.value = validResults;
      console.log(
        `[Store] doSearch: completed, total sites with results=${validResults.length}`,
      );
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
    saveToFile();
  }
  function setAutoPlayNext(v: boolean) {
    autoPlayNext.value = v;
    localStorage.setItem('tvbox_autoplay_next', String(v));
    saveToFile();
  }
  function setDohIndex(v: number) {
    dohIndex.value = v;
    localStorage.setItem('tvbox_doh_index', String(v));
    saveToFile();
  }
  function setSearchViewMode(v: number) {
    searchViewMode.value = v;
    localStorage.setItem('tvbox_search_view', String(v));
    saveToFile();
  }
  function setLiveUrl(v: string) {
    liveUrl.value = v;
    localStorage.setItem('tvbox_live_url', v);
    saveToFile();
  }
  function setEpgUrl(v: string) {
    epgUrl.value = v;
    localStorage.setItem('tvbox_epg_url', v);
    saveToFile();
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
    activeCategory,
    filterValues,
    categoryVodList,
    categoryPage,
    categoryPageCount,
    categoryLoading,
    currentVod,
    detailLoading,
    detailError,
    currentPlayUrl,
    currentPlayHeader,
    currentPlayFlag,
    currentPlayIndex,
    currentDanmuUrl,
    currentEpisodes,
    resumeProgress,
    playLoading,
    playError,
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
    setCategory,
    setFilter,
    applyFilters,
    loadCategory,
    runSpiderAction,
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
