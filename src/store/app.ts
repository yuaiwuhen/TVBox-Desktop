import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref, computed } from 'vue';
import axios from 'axios';
import { configParser, checkReplaceProxy, getSpiderApiBaseUrl } from '../core/ConfigParser';
import { spiderEngine } from '../core/SpiderEngine';
import { ParseEngine } from '../core/ParseEngine';
import {
  Database,
  type HistoryRecord,
  type FavoriteRecord,
} from '../core/Database';
import { saveToFile } from '../core/ConfigSync';
import type {
  SourceBean,
  Movie,
  MovieSort,
  FilterGroup,
  ParseBean,
  PlayResult,
  LiveChannelGroup,
  MediaTrack,
} from '../core/models';

export const useAppStore = defineStore('app', () => {
  // ===== Config =====
  // The user must provide a config URL; there is no default.
  const configUrl = ref(localStorage.getItem('tvbox_config_url') || '');
  const sites = ref<SourceBean[]>([]);
  const activeSiteKey = ref(localStorage.getItem('tvbox_active_site') || '');
  const parses = ref<ParseBean[]>([]);
  const defaultParseName = ref(
    localStorage.getItem('tvbox_default_parse') || '',
  );
  const wallpaper = ref('');

  // ===== Multi-Config (多仓) =====
  const subConfigs = ref<Array<{ name: string; url: string }>>([]);
  const activeSubConfigIndex = ref(-1);
  const mergeSubConfigs = ref(
    localStorage.getItem('tvbox_merge_subconfigs') === 'true',
  ); // 多仓合并开关

  // ===== Home =====
  const classes = ref<MovieSort[]>([]);
  const filters = ref<Record<string, FilterGroup[]>>({});
  const homeVodList = ref<Movie[]>([]);
  const homeLoading = ref(false);
  // 首页加载失败时的具体错误信息（spider init 失败 / JAR 404 / 源不可用等）。
  // 为空表示无错误。用于替代"暂无数据"这种泛化提示，让用户知道真正原因。
  const homeError = ref('');
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
  const currentAudioUrls = ref<MediaTrack[]>([]);
  const currentSubtitleUrls = ref<MediaTrack[]>([]);
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
  // Playback settings (reference FongMi/TV Playback settings).
  // Persisted so the same speed/scale survives across videos & restarts.
  const playSpeed = ref(
    Number(localStorage.getItem('tvbox_play_speed') || '1'),
  ); // 0.5 - 3.0
  const scaleType = ref(localStorage.getItem('tvbox_scale_type') || 'default'); // default / 16:9 / 4:3 / fill / original / crop
  const hardDecode = ref(localStorage.getItem('tvbox_hard_decode') !== 'false'); // hardware-accelerated decoding
  const skipIntro = ref(
    Number(localStorage.getItem('tvbox_skip_intro') || '0'),
  ); // seconds to skip at start
  const skipOutro = ref(
    Number(localStorage.getItem('tvbox_skip_outro') || '0'),
  ); // seconds before end to trigger next ep

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

  // 多仓模式判断
  const isMultiConfig = computed(() => subConfigs.value.length > 0);

  // ===== Config Actions =====
  function setConfigUrl(url: string) {
    configUrl.value = url;
    localStorage.setItem('tvbox_config_url', url);
    saveToFile();
  }

  // 多仓相关方法
  function setSubConfigs(configs: Array<{ name: string; url: string }>) {
    subConfigs.value = configs;
    activeSubConfigIndex.value = -1;
  }

  function clearSubConfigs() {
    subConfigs.value = [];
    activeSubConfigIndex.value = -1;
  }

  async function loadSubConfig(index: number): Promise<boolean> {
    if (index < 0 || index >= subConfigs.value.length) return false;
    const sub = subConfigs.value[index];
    const savedUrl = configUrl.value;
    try {
      await configParser.load(sub.url);
      configUrl.value = sub.url;
      activeSubConfigIndex.value = index;

      sites.value = configParser.getSites().filter((s) => s.hide !== 1);
      parses.value = configParser.getParses();
      wallpaper.value = configParser.getWallpaper();
      liveGroups.value = configParser.getLiveChannelGroups();
      liveUrl.value =
        localStorage.getItem('tvbox_live_url') ||
        configParser.getConfigLiveUrl() ||
        '';
      epgUrl.value = localStorage.getItem('tvbox_epg_url') || '';

      // Set config URL FIRST so setSpiderBaseUrl can resolve relative
      // spider URLs (e.g. "./jar/fan.txt;md5;hash") against it.
      spiderEngine.setConfigUrl(sub.url);
      const spiderBase = configParser.getSpider();
      if (spiderBase) {
        spiderEngine.setSpiderBaseUrl(spiderBase);
      }

      if (
        !activeSiteKey.value ||
        !sites.value.find((s) => getUniqueKey(s) === activeSiteKey.value)
      ) {
        if (sites.value.length > 0) setActiveSite(getUniqueKey(sites.value[0]));
      }

      return true;
    } catch (e) {
      console.error(`loadSubConfig failed for ${sub.name}:`, e);
      configUrl.value = savedUrl;
      return false;
    }
  }

  // 设置多仓合并开关
  function setMergeSubConfigs(merge: boolean) {
    const wasMerged = mergeSubConfigs.value;
    mergeSubConfigs.value = merge;
    localStorage.setItem('tvbox_merge_subconfigs', String(merge));
    saveToFile();

    // 只有在状态真正改变且有多仓配置时才执行
    if (wasMerged !== merge && subConfigs.value.length > 0) {
      if (merge) {
        // 切换到合并模式：合并所有子配置
        mergeAllSubConfigs();
      } else {
        // 切换到非合并模式：加载第一个子配置
        if (activeSubConfigIndex.value < 0) {
          loadSubConfig(0);
        } else {
          loadSubConfig(activeSubConfigIndex.value);
        }
      }
    }
  }

  // 合并所有子配置的站点
  async function mergeAllSubConfigs() {
    if (subConfigs.value.length === 0) return;

    const allSites: SourceBean[] = [];
    const allParses: ParseBean[] = [];

    for (let i = 0; i < subConfigs.value.length; i++) {
      const sub = subConfigs.value[i];
      try {
        const savedUrl = configUrl.value;
        configUrl.value = sub.url;
        await configParser.load(sub.url);
        const subSites = configParser.getSites().filter((s) => s.hide !== 1);
        // 为每个站点添加前缀以区分来源
        subSites.forEach((site) => {
          allSites.push({
            ...site,
            key: `${sub.name}__${site.key}`,
            name: `${sub.name}/${site.name}`,
          });
        });
        const subParses = configParser.getParses();
        subParses.forEach((parse) => {
          allParses.push({
            ...parse,
            name: `${sub.name}/${parse.name}`,
          });
        });
        configUrl.value = savedUrl;
      } catch (e) {
        console.error(
          `[mergeAllSubConfigs] Failed to load sub config ${sub.name}:`,
          e,
        );
      }
    }

    sites.value = allSites;
    parses.value = allParses;

    // 设置默认源
    if (
      allSites.length > 0 &&
      !sites.value.find((s) => getUniqueKey(s) === activeSiteKey.value)
    ) {
      setActiveSite(getUniqueKey(allSites[0]));
    }
  }

  async function loadConfig(): Promise<boolean> {
    if (!configUrl.value) return false;
    try {
      await configParser.load(configUrl.value);
      const config = configParser.config;

      // 检查是否是多仓模式
      if (
        config &&
        (config as any).isMultiConfig &&
        Array.isArray((config as any).subConfigs)
      ) {
        setSubConfigs((config as any).subConfigs);

        // 根据合并开关决定行为
        if (mergeSubConfigs.value) {
          // 合并所有子配置
          await mergeAllSubConfigs();
        } else {
          // 未合并时，自动加载第一个子配置
          if (subConfigs.value.length > 0) {
            await loadSubConfig(0);
          } else {
            sites.value = [];
          }
        }
        pushGlobalConfig();
        return true;
      }

      // 单仓模式：加载站点
      sites.value = configParser.getSites().filter((s) => s.hide !== 1);
      parses.value = configParser.getParses();
      wallpaper.value = configParser.getWallpaper();
      liveGroups.value = configParser.getLiveChannelGroups();
      liveUrl.value =
        localStorage.getItem('tvbox_live_url') ||
        configParser.getConfigLiveUrl() ||
        '';
      epgUrl.value = localStorage.getItem('tvbox_epg_url') || '';

      // Set config URL FIRST so setSpiderBaseUrl can resolve relative
      // spider URLs (e.g. "./jar/fan.txt;md5;hash") against it.
      spiderEngine.setConfigUrl(configUrl.value);
      const spiderBase = configParser.getSpider();
      if (spiderBase) {
        spiderEngine.setSpiderBaseUrl(spiderBase);
      }

      if (
        !activeSiteKey.value ||
        !sites.value.find((s) => getUniqueKey(s) === activeSiteKey.value)
      ) {
        if (sites.value.length > 0) setActiveSite(getUniqueKey(sites.value[0]));
      }

      clearSubConfigs();
      pushGlobalConfig();
      return true;
    } catch (e) {
      console.error('loadConfig failed:', e);
      return false;
    }
  }

  /**
   * Push the config JSON's global `hosts`/`cors` rules to the Android JAR
   * runtime (/spider/config). Fire-and-forget: best-effort, never blocks the
   * UI. This mirrors FongMi/TV applying OkHttp.dns().addAll(hosts) +
   * responseInterceptor().addAll(cors) when a config loads.
   */
  function pushGlobalConfig() {
    const hosts = configParser.getHosts();
    const cors = configParser.getCors();
    if (hosts.length === 0 && cors.length === 0) return;
    const base = getSpiderApiBaseUrl();
    axios
      .post(`${base}/spider/config`, {
        hosts,
        cors: cors.map((c) => ({ host: c.host, header: c.header })),
      })
      .then((res) => {
        console.log('[Store] pushGlobalConfig:', res.data?.data || res.data);
      })
      .catch((e) => {
        console.warn('[Store] pushGlobalConfig failed:', e.message || e);
      });
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

  /**
   * Switch to the config center site (csp_Config) so the user can log into the
   * netdisk (夸克 / UC盘 / 百度 …) that a source requires for playback.
   * Returns true if a config center source was found and activated.
   */
  function goToConfigCenter(): boolean {
    const configSite = sites.value.find(
      (s) =>
        (s.key || '').toLowerCase() === 'config' ||
        (s.api || '').toLowerCase().includes('config'),
    );
    if (!configSite) return false;
    const key = getUniqueKey(configSite);
    if (activeSiteKey.value !== key) {
      setActiveSite(key);
    }
    return true;
  }

  /**
   * Detect whether a spider playback error means "you need to log into a
   * netdisk first" and normalize the message to a clear, drive-accurate hint.
   *
   * Many netdisk-based sources (e.g. csp_Duopan / 蜡笔影视) return a hardcoded
   * "未登录UC" / "请去配置中心设置" string regardless of which Alibaba drive the
   * video actually lives on (夸克网盘 or UC盘). This makes the raw message
   * misleading. We rewrite it into a generic-but-accurate login prompt and let
   * the caller point the user at the config center.
   */
  function isNetdiskLoginError(msg: string): boolean {
    if (!msg) return false;
    return (
      /未登录|请登录|需要登录|请先登录|登录后|未授权|请授权|请扫码|扫码登录|cookie/i.test(
        msg,
      )
    );
  }

  function normalizePlayError(raw: string): string {
    if (!raw) return '';
    // Only rewrite messages that clearly require a netdisk login.
    if (!isNetdiskLoginError(raw)) return raw;
    // Sources like 蜡笔影视 (csp_Duopan) hardcode a label (often "UC") that can
    // be wrong for the actual drive (e.g. the video is on 夸克网盘). Quark and
    // UC are distinct Alibaba drives with separate cookie entries in the config
    // center, so we never echo a possibly-wrong drive name back. Instead we
    // show a clear, actionable prompt and let the config-center button take the
    // user to the exact cookie entry they need.
    if (/夸克|quark|pan.quark/i.test(raw)) {
      return '未登录夸克网盘，请去配置中心登录后重试';
    }
    if (/uc盘|pan.uc|uc\.cn/i.test(raw)) {
      return '未登录UC盘，请去配置中心登录后重试';
    }
    return '未登录网盘，请去配置中心登录对应网盘（夸克网盘 / UC盘 / 百度等）后重试';
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
    // 清空上一次的错误，重新加载
    homeError.value = '';

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
      console.log('[Store] loadHome: config center — using spider homeContent');
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
      // Parse homeContent response. If the response is empty or invalid JSON,
      // treat it as empty data so the fallback chain (homeVideoContent,
      // categoryContent, searchContent) can still run.
      let homeResult: any = { list: [] };
      if (rawHome && rawHome.trim()) {
        try {
          homeResult = JSON.parse(rawHome);
        } catch (e) {
          console.warn(
            '[Store] loadHome: homeContent returned invalid JSON, treating as empty',
          );
        }
      }
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

      // Fallback: if homeContent returned classes (categories) but no videos,
      // try calling categoryContent for the first few classes. Common for
      // csp_AppRJ / csp_AppXGS / AppYingTong etc. — they only populate list
      // via categoryContent, not homeContent.
      if (homeVodList.value.length === 0 && classes.value.length > 0) {
        for (const cls of classes.value.slice(0, 5)) {
          const tid = String(cls.type_id || '');
          console.log(
            `[Store] loadHome: empty list with classes — trying categoryContent(${tid})`,
          );
          try {
            const rawCat = await spider.categoryContent(tid, 1, true, {});
            if (rawCat) {
              let catResult: any = { list: [] };
              try {
                catResult = JSON.parse(rawCat);
              } catch {
                /* keep empty */
              }
              const catList = catResult.list || [];
              if (catList.length > 0) {
                homeVodList.value = catList;
                activeCategory.value = tid;
                console.log(
                  `[Store] loadHome: categoryContent fallback (${tid}) returned ${catList.length} items`,
                );
                break;
              }
            }
          } catch (e) {
            console.warn(
              `[Store] loadHome: categoryContent fallback failed:`,
              e,
            );
          }
        }
      }

      // Fallback: if homeContent and homeVideoContent both returned empty
      // (common for search-only sources like BookShiJie, Music163, bilibili,
      // SoHaiYin, etc.), perform a default search to populate the homepage.
      // Only attempt if site is searchable (searchable !== 0).
      if (homeVodList.value.length === 0 && activeSite.value.searchable !== 0) {
        console.log(
          '[Store] loadHome: empty home — falling back to default search',
        );
        const defaultKeywords = ['热门', '2024', '2025', '电影'];
        for (const kw of defaultKeywords) {
          try {
            const rawSearch = await spider.searchContent(kw, false, '1');
            if (!rawSearch) continue;
            let searchResult: any = { list: [] };
            try {
              searchResult = JSON.parse(rawSearch);
            } catch {
              continue;
            }
            const list = searchResult.list || [];
            if (list.length > 0) {
              homeVodList.value = list;
              console.log(
                `[Store] loadHome: search fallback "${kw}" returned ${list.length} items`,
              );
              break;
            }
          } catch (e) {
            console.warn(
              `[Store] loadHome: search fallback "${kw}" failed:`,
              e,
            );
          }
        }
      }
    } catch (e: any) {
      console.error('[Store] loadHome failed:', e);
      // 提炼对用户有用的错误信息：JAR 404/加载失败、spider init 失败、
      // 服务不可达等，让首页显示具体原因而不是空白。
      const msg = String(e?.message || e || '');
      homeError.value = normalizeSpiderError(msg, activeSite.value);
    } finally {
      homeLoading.value = false;
    }
  }

  /**
   * 把 spider/配置加载错误转成对用户友好的中文提示。
   * 例如：JAR 404 → "源 JAR 已失效，请切换其他源或更新配置"；
   * 服务不可达 → "Spider 服务未连接，请确认模拟器/服务已启动"。
   */
  function normalizeSpiderError(raw: string, site: any): string {
    if (!raw) return `当前源加载失败：${site?.name || ''}`;
    if (/Failed to load JAR|Failed to load jar/i.test(raw)) {
      return `当前源（${site?.name || ''}）的 JAR 已失效或无法下载，请切换其他源或更换配置地址`;
    }
    if (/JAR reload failed/i.test(raw)) {
      return `当前源（${site?.name || ''}）的 JAR 已失效，请切换其他源或更换配置地址`;
    }
    if (/spider not found|no spider for key/i.test(raw)) {
      return `当前源（${site?.name || ''}）未成功加载爬虫，请切换其他源重试`;
    }
    if (/ECONNREFUSED|Failed to fetch|Network Error|网络错误/i.test(raw)) {
      return `Spider 服务未连接，请确认模拟器和服务已启动后重试`;
    }
    if (/timeout|Timed out|超时/i.test(raw)) {
      return `当前源响应超时，请切换其他源或稍后重试`;
    }
    return `当前源加载失败：${raw.substring(0, 200)}`;
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

      // Fallback: if categoryContent returned empty on page 1 and the site
      // is searchable, run a search using the category's type_name as
      // keyword. This handles search-only sources (BookShiJie, Music163,
      // bilibili, etc.) whose categoryContent always returns empty.
      if (
        pg === '1' &&
        categoryVodList.value.length === 0 &&
        activeSite.value.searchable !== 0 &&
        tid !== '__recommend__'
      ) {
        const cat = classes.value.find((c: any) => c.type_id === tid);
        const kw = cat?.type_name || tid;
        console.log(
          `[Store] loadCategory: empty list — falling back to search "${kw}"`,
        );
        try {
          const rawSearch = await spider.searchContent(kw, false, pg);
          if (rawSearch) {
            let sres: any = { list: [] };
            try {
              sres = JSON.parse(rawSearch);
            } catch {}
            if (Array.isArray(sres.list) && sres.list.length > 0) {
              categoryVodList.value = sres.list;
              console.log(
                `[Store] loadCategory: search fallback returned ${sres.list.length} items`,
              );
            }
          }
        } catch (e) {
          console.warn(`[Store] loadCategory: search fallback failed:`, e);
        }
      }
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

      // FongMi/TV behavior: vod_ids starting with "msearch:" are virtual
      // ids produced by aggregator spiders (e.g. NewDouBan). The spider's
      // detailContent returns empty for these — the real playable sources
      // are discovered by searching the movie title across all searchable
      // spiders. Mirror that flow: populate currentVod from the home list,
      // then kick off a cross-source search whose results are shown as
      // alternative play sources on the detail page.
      if (typeof vodId === 'string' && vodId.startsWith('msearch:')) {
        // msearch vod_ids are virtual ids produced by aggregator spiders
        // (e.g. NewDouBan). The spider's detailContent returns empty for
        // these — the real playable sources are discovered by searching
        // the movie title across all searchable spiders. Look up the
        // movie in homeVodList OR categoryVodList to get its vod_name.
        if (
          homeVodList.value.length === 0 &&
          categoryVodList.value.length === 0
        ) {
          console.log(
            '[Store] loadDetail: msearch id but both lists empty — loading home first',
          );
          await loadHome(true).catch((e) =>
            console.warn('[Store] loadDetail: loadHome failed:', e),
          );
        }
        const fromHome = homeVodList.value.find((m) => m.vod_id === vodId);
        const fromCategory = !fromHome
          ? categoryVodList.value.find((m) => m.vod_id === vodId)
          : null;
        const msearchVod = fromHome || fromCategory;
        if (msearchVod) {
          currentVod.value = {
            ...msearchVod,
            sourceKey: activeSite.value.key,
          } as any;
          console.log(
            '[Store] loadDetail: msearch id detected, auto-searching for:',
            msearchVod.vod_name,
            fromHome ? '(from home)' : '(from category)',
          );
          // Mark as msearch so Detail.vue shows search results as sources.
          (currentVod.value as any).isMsearchResult = true;
          // Trigger search in the background (don't await — results stream in).
          doSearch(msearchVod.vod_name).catch((e) =>
            console.warn('[Store] msearch auto-search failed:', e),
          );
          detailLoading.value = false;
          return;
        }
        // Movie not in any list — we can't get the vod_name to search.
        // Show a clear error instead of falling through to detailContent
        // (which returns empty for msearch ids).
        if (!msearchVod) {
          console.warn(
            '[Store] loadDetail: msearch id not found in home or category list:',
            vodId,
          );
          detailError.value =
            '无法获取该资源的标题信息，请从首页或分类列表进入详情页';
          detailLoading.value = false;
          return;
        }
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
        detailError.value =
          '该资源暂无可播放的源，可能分享链接已失效或资源已下线';
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
    currentAudioUrls.value = [];
    currentSubtitleUrls.value = [];
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
        // Some netdisk JARs return a *plain string* instead of JSON when the
        // user is not logged in (e.g. Quark's "未登录夸克, 请去配置中心设置").
        // Detect that here so the PC shows a clear login prompt rather than a
        // generic "parse failed" error.
        const trimmed = String(rawResult || '').trim();
        if (isNetdiskLoginError(trimmed)) {
          playError.value = normalizePlayError(trimmed);
          console.warn('[Store] loadPlay: spider returned plain login-required text:', trimmed);
        } else {
          playError.value = '播放地址解析失败，可能资源已下线';
        }
        return;
      }

      // Some spiders (e.g. BiliGuard) return url as an array of [name, url, name, url, ...] pairs
      // instead of a single URL string. Extract the first URL (index 1) and merge headers.
      // Mirrors Android SourceViewModel.java handling of multi-quality play URLs.
      if (Array.isArray((result as any).url)) {
        const urlArray = (result as any).url as any[];
        console.log(
          '[Store] loadPlay: url is array, length=',
          urlArray.length,
          'first pairs=',
          urlArray.slice(0, 4),
        );
        // Find first element that looks like a URL (starts with http/proxy/magnet)
        let pickedUrl = '';
        for (let i = 1; i < urlArray.length; i += 2) {
          const candidate = String(urlArray[i] || '');
          if (
            candidate.startsWith('http') ||
            candidate.startsWith('proxy://') ||
            candidate.startsWith('magnet:')
          ) {
            pickedUrl = candidate;
            break;
          }
        }
        // Fallback: scan all elements for a URL
        if (!pickedUrl) {
          for (const item of urlArray) {
            const s = String(item || '');
            if (
              s.startsWith('http') ||
              s.startsWith('proxy://') ||
              s.startsWith('magnet:')
            ) {
              pickedUrl = s;
              break;
            }
          }
        }
        (result as any).url = pickedUrl;
        console.log(
          '[Store] loadPlay: picked URL from array:',
          pickedUrl.substring(0, 120),
        );
      } else if (typeof (result as any).url === 'string') {
        // Some spiders return url as a comma-separated "name,url,name,url,..." string
        // (or a single url with trailing comma). Parse it the same way as the array
        // case: pick the first token that looks like a URL.
        const raw = (result as any).url as string;
        if (raw.includes(',')) {
          const tokens = raw.split(',').map((t) => t.trim()).filter(Boolean);
          let pickedUrl = '';
          for (let i = 1; i < tokens.length; i += 2) {
            const candidate = tokens[i] || '';
            if (
              candidate.startsWith('http') ||
              candidate.startsWith('proxy://') ||
              candidate.startsWith('magnet:')
            ) {
              pickedUrl = candidate;
              break;
            }
          }
          if (!pickedUrl) {
            for (const t of tokens) {
              if (
                t.startsWith('http') ||
                t.startsWith('proxy://') ||
                t.startsWith('magnet:')
              ) {
                pickedUrl = t;
                break;
              }
            }
          }
          if (pickedUrl && pickedUrl !== raw) {
            console.log(
              '[Store] loadPlay: parsed comma-separated url string, picked:',
              pickedUrl.substring(0, 120),
            );
            (result as any).url = pickedUrl;
          }
        }
      }

      console.log('[Store] loadPlay parsed result:', {
        hasUrl: !!result.url,
        hasHeader: !!result.header,
        parse: result.parse,
        urlPreview: result.url ? result.url.substring(0, 100) : '(none)',
        error: (result as any).error,
      });

      // Convert proxy:// URLs (and http://127.0.0.1:<port>/proxy?... URLs
      // returned by spiders whose Proxy.a() probe ran inside the Android
      // container) to local proxy URLs.
      // Spiders return either:
      //   proxy://do=bili&aid=...&cid=...
      //   http://127.0.0.1:-1/proxy?do=hxq&url=...  (probe failed in container)
      //   http://127.0.0.1:9978/proxy?do=...        (probe hit container's own port)
      // All must be rewritten to http://127.0.0.1:<ProxyServer port>/proxy?do=...
      // so the browser reaches the PC's local ProxyServer (main process,
      // port 9979-9999). Port is resolved dynamically via IPC — see
      // ConfigParser.getLocalProxy(). Mirrors Android DefaultConfig.checkReplaceProxy.
      if (result.url) {
        const rewritten = checkReplaceProxy(result.url);
        if (rewritten !== result.url) {
          console.log('[Store] loadPlay: rewritten proxy URL:', {
            from: result.url.substring(0, 80),
            to: rewritten.substring(0, 80),
          });
          result.url = rewritten;
        }
      }

      // Netdisk sources (Quark/UC/Baidu) require the account Cookie that
      // playerContent returns in `header`. FongMi's player attaches it to the
      // goproxy request directly, but a browser <video>/fetch cannot send a
      // custom Cookie header. So when the play URL was rewritten to the
      // /goproxy endpoint, we append the cookie as a query param and the
      // Android handler injects it into the upstream goproxy request.
      if (result.url && result.header && /\/goproxy\?/i.test(result.url)) {
        try {
          const playHeader = JSON.parse(result.header) as Record<string, string>;
          const cookie = playHeader.Cookie || playHeader.cookie || '';
          if (cookie && !/[?&]cookie=/.test(result.url)) {
            const sep = result.url.includes('?') ? '&' : '?';
            result.url = result.url + sep + 'cookie=' + encodeURIComponent(cookie);
            console.log('[Store] loadPlay: attached netdisk cookie to /goproxy URL');
          }
        } catch (e) {
          console.warn('[Store] loadPlay: failed to parse header for cookie:', e);
        }
      }

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

      // FongMi 返回模式：url 为空但 header 存在时，
      // 表示应使用原始播放地址（id）并附加返回的请求头直接播放。
      // 与 Android SourceViewModel 行为一致：空 url 时回退到原始 url，
      // 并剥离播放器类型标记（如 |lzm3u8）。
      if (!result.url && result.header && typeof id === 'string' && id.startsWith('http')) {
        result.url = id.split('|')[0];
        console.log(
          '[Store] loadPlay: header-only response, using original id as play url:',
          result.url.substring(0, 120),
        );
      }

      if (!result.url) {
        // 优先使用 spider 返回的具体错误信息
        const spiderMsg = (result as any).msg || (result as any).errMsg || '';
        if (spiderMsg) {
          playError.value = normalizePlayError(spiderMsg);
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
      const isProxyUrl = result.url.includes('/proxy?');

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
      // TVBox standard JARs return the barrage URL under `danmaku`; some
      // return it as `danmuUrl`. Accept both and normalize proxy URLs so the
      // browser can reach them (JAR-internal loopback → adb forward).
      let rawDanmu =
        (result as any).danmaku || (result as any).danmuUrl || '';
      if (rawDanmu) {
        rawDanmu = checkReplaceProxy(String(rawDanmu));
        // Some netdisk JARs return a *placeholder* danmu URL with an empty
        // vodUrl= parameter (e.g. `proxy?do=danmu&vodName=...&vodIndex=...&vodUrl=`).
        // They expect the frontend to fill in the actual play address. Do that
        // so the danmu endpoint doesn't fail with "Missing url parameter".
        if (
          /do=danmu/i.test(rawDanmu) &&
          /[?&]vodUrl=(?:$|&|#)/i.test(rawDanmu)
        ) {
          try {
            const u = new URL(rawDanmu);
            u.searchParams.set('vodUrl', result.url || currentPlayUrl.value || '');
            rawDanmu = u.toString();
          } catch {
            /* keep raw */
          }
        }
      }
      currentDanmuUrl.value = rawDanmu;

      // TVBox standard: `audio` = alternate audio tracks, `sub`/`subtitle` =
      // external subtitles. 真实 spider（夸克/饭米 等）返回的可能是：
      //  - 纯 URL 字符串数组
      //  - "url#url" 形式的字符串
      //  - [{ name, url }] 对象数组（最常见，且含可读名称）
      //  - "名称,地址#名称,地址" 形式的字符串
      // 这里统一归一化为 { name, url } 并经过代理重写。
      const toMediaList = (v: unknown): MediaTrack[] => {
        if (v == null) return [];
        const raw = Array.isArray(v) ? v : String(v).split('#');
        const list: MediaTrack[] = [];
        for (const item of raw) {
          if (item == null) continue;
          let name = '';
          let url = '';
          if (typeof item === 'object') {
            const o = item as Record<string, unknown>;
            url = String(o.url ?? o.src ?? o.link ?? '').trim();
            name = String(o.name ?? o.lang ?? o.label ?? '').trim();
          } else {
            const s = String(item).trim();
            if (!s) continue;
            // 支持 "名称,地址" 形式
            const comma = s.indexOf(',');
            if (comma > 0 && /^https?:\/\//.test(s.slice(comma + 1).trim())) {
              name = s.slice(0, comma).trim();
              url = s.slice(comma + 1).trim();
            } else {
              url = s;
            }
          }
          if (!url) continue;
          url = checkReplaceProxy(url);
          list.push({ name: name || url, url });
        }
        return list;
      };
      currentAudioUrls.value = toMediaList((result as any).audio);
      currentSubtitleUrls.value = toMediaList(
        (result as any).sub ?? (result as any).subtitle,
      );

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

  // Mirrors Android's SearchActivity.searchResult(): concurrent search across
  // selected sites, with results streamed into searchResults as each site
  // returns (Android uses EventBus + addData; we just push into the ref).
  // quick flag maps to Android's getSearch (false) vs getQuickSearch (true).
  async function doSearch(
    keyword: string,
    siteKeys?: string[],
    quick: boolean = false,
  ) {
    searchLoading.value = true;
    searchResults.value = [];
    console.log(
      `[Store] doSearch: keyword=${keyword}, siteKeys=${siteKeys?.join(',') || 'all'}, quick=${quick}`,
    );
    try {
      const targets =
        siteKeys && siteKeys.length > 0
          ? sites.value.filter(
              (s) => siteKeys.includes(getUniqueKey(s)) && s.searchable !== 0,
            )
          : sites.value.filter((s) => s.searchable !== 0);

      console.log(`[Store] doSearch: searching across ${targets.length} sites`);

      // Android uses newFixedThreadPool(5); cap concurrent in-flight searches
      // to avoid hammering all sources simultaneously.
      const CONCURRENCY = 5;
      let cursor = 0;
      let completed = 0;
      const total = targets.length;

      async function runOne(site: any): Promise<void> {
        try {
          const spider = await spiderEngine.getSpider(site);
          if (!spider) {
            console.warn(`[Store] doSearch: spider is null for ${site.name}`);
            return;
          }
          const rawResult = await spider.searchContent(keyword, quick);
          const result = JSON.parse(rawResult || '{}');
          const list = result.list || [];
          console.log(
            `[Store] doSearch: ${site.name} found ${list.length} results`,
          );
          if (list.length > 0) {
            // Stream result into searchResults immediately (mirrors Android
            // searchAdapter.addData on EventBus event).
            searchResults.value = [
              ...searchResults.value,
              {
                siteKey: getUniqueKey(site),
                siteName: site.name,
                list,
              },
            ];
          }
        } catch (e) {
          console.error(`[Store] doSearch: ${site.name} failed:`, e);
        } finally {
          completed++;
          console.log(`[Store] doSearch: progress ${completed}/${total}`);
          if (completed >= total) {
            console.log(
              `[Store] doSearch: completed, sites with results=${searchResults.value.length}`,
            );
          }
        }
      }

      // Simple N-at-a-time scheduler to emulate Executors.newFixedThreadPool(5).
      async function scheduleNext(): Promise<void> {
        if (cursor >= total) return;
        const idx = cursor++;
        const site = targets[idx];
        await runOne(site);
        await scheduleNext();
      }

      const workers: Promise<void>[] = [];
      for (let i = 0; i < Math.min(CONCURRENCY, total); i++) {
        workers.push(scheduleNext());
      }
      await Promise.all(workers);
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
  // Playback settings (mirror FongMi/TV Playback settings). Each setter
  // persists to localStorage so the value survives restarts, and also
  // pushes the change to the Android side via the spider server so that
  // JAR-based players (ExoPlayer in redroid) honor the same settings.
  function setPlaySpeed(v: number) {
    playSpeed.value = v;
    localStorage.setItem('tvbox_play_speed', String(v));
    saveToFile();
    syncPlaybackSetting('playSpeed', String(v));
  }
  function setScaleType(v: string) {
    scaleType.value = v;
    localStorage.setItem('tvbox_scale_type', v);
    saveToFile();
    syncPlaybackSetting('scaleType', v);
  }
  function setHardDecode(v: boolean) {
    hardDecode.value = v;
    localStorage.setItem('tvbox_hard_decode', String(v));
    saveToFile();
    syncPlaybackSetting('hardDecode', String(v));
  }
  function setSkipIntro(v: number) {
    skipIntro.value = v;
    localStorage.setItem('tvbox_skip_intro', String(v));
    saveToFile();
    syncPlaybackSetting('skipIntro', String(v));
  }
  function setSkipOutro(v: number) {
    skipOutro.value = v;
    localStorage.setItem('tvbox_skip_outro', String(v));
    saveToFile();
    syncPlaybackSetting('skipOutro', String(v));
  }
  // Push a single playback preference to the Android spider server, which
  // writes it into SharedPreferences so JAR spiders can read the same value
  // when constructing playerContent. Failures are non-fatal: PC-side playback
  // still works via the local VideoPlayer.
  async function syncPlaybackSetting(key: string, value: string) {
    try {
      const { ipcRenderer } = (window as any).require?.('electron') || {};
      if (!ipcRenderer) return;
      await ipcRenderer.invoke('spider-set-pref', { key, value });
    } catch (e) {
      console.warn('[Store] syncPlaybackSetting failed:', e);
    }
  }

  return {
    configUrl,
    sites,
    activeSiteKey,
    parses,
    defaultParseName,
    wallpaper,
    // 多仓
    subConfigs,
    activeSubConfigIndex,
    mergeSubConfigs,
    isMultiConfig,
    setMergeSubConfigs,
    mergeAllSubConfigs,
    classes,
    filters,
    homeVodList,
    homeLoading,
    homeError,
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
    currentAudioUrls,
    currentSubtitleUrls,
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
    // Playback settings (FongMi/TV Playback)
    playSpeed,
    scaleType,
    hardDecode,
    skipIntro,
    skipOutro,
    activeSite,
    activeParse,
    setConfigUrl,
    loadConfig,
    setActiveSite,
    goToConfigCenter,
    isNetdiskLoginError,
    normalizePlayError,
    setDefaultParse,
    setSubConfigs,
    clearSubConfigs,
    loadSubConfig,
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
    setPlaySpeed,
    setScaleType,
    setHardDecode,
    setSkipIntro,
    setSkipOutro,
    resetHome,
  };
});

// Enable HMR for Pinia setup stores. Without this, edits to actions like
// doSearch / loadHome are not picked up by vite-plugin-electron's HMR — the
// renderer keeps calling the old action implementation until a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAppStore, import.meta.hot));
}
