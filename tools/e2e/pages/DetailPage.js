/**
 * DetailPage - 详情页页面对象
 *
 * 封装详情页所有操作：
 * - detailContent 获取视频详情
 * - 解析 vod_play_from 和 vod_play_url
 * - playerContent 测试每个播放源
 */
const BasePage = require('./BasePage');

class DetailPage extends BasePage {
  constructor(page) {
    super(page);
  }

  /**
   * 调用 detailContent 获取视频详情
   * @param {string} key - 源 key
   * @param {string} vodId - 视频 ID
   * @returns {Promise<{list: Array, raw: string}>}
   */
  async getDetailContent(key, vodId) {
    const raw = await this.invokeWithTimeout(
      30000,
      'jar:callMethod',
      key,
      'detailContent',
      [vodId],
      {},
    );
    let parsed = {};
    try {
      parsed = JSON.parse(raw || '{}');
    } catch (e) {
      console.warn(
        `[DetailPage] detailContent parse failed for ${key}/${vodId}:`,
        e.message,
      );
    }
    return {
      list: parsed.list || [],
      raw: raw || '',
    };
  }

  /**
   * 解析 vod_play_from 和 vod_play_url，提取所有播放源
   *
   * 格式说明:
   *   vod_play_from: "flag1#count1$$$flag2#count2$$$..."
   *   vod_play_url:  "name1$id1#name2$id2#...$$$name3$id3#..."
   * 每个 $$$ 分段对应一个播放源(flag)
   *
   * @param {object} vod - 视频详情对象
   * @returns {Array<{flag: string, episodes: Array<{name: string, id: string}>}>}
   */
  parsePlaySources(vod) {
    const playFrom = vod?.vod_play_from || '';
    const playUrl = vod?.vod_play_url || '';

    if (!playFrom || !playUrl) return [];

    const flags = playFrom.split('$$$');
    const urlGroups = playUrl.split('$$$');

    return flags.map((flagRaw, index) => {
      // flag 格式: "夸克原画#02" 或 "夸克原画"
      const flag = flagRaw.split('#')[0];
      const urlGroup = urlGroups[index] || '';
      const rawEps = urlGroup.split('#');

      const episodes = rawEps
        .map((ep, idx) => {
          const parts = ep.split('$');
          if (parts.length >= 2) {
            return { name: parts[0] || '正片', id: parts[1] || '' };
          }
          return { name: String(idx + 1), id: parts[0] || '' };
        })
        .filter((ep) => ep.id);

      return { flag, episodes };
    });
  }

  /**
   * 调用 playerContent 获取播放地址
   * @param {string} key - 源 key
   * @param {string} flag - 播放源标识
   * @param {string} playId - 播放 ID
   * @returns {Promise<{url: string, msg: string, raw: string}>}
   */
  async getPlayerContent(key, flag, playId) {
    const raw = await this.invokeWithTimeout(
      30000,
      'jar:callMethod',
      key,
      'playerContent',
      [flag, playId, ['']],
      {},
    );
    let parsed = {};
    try {
      parsed = JSON.parse(raw || '{}');
    } catch (e) {
      console.warn(
        `[DetailPage] playerContent parse failed for ${key}/${flag}:`,
        e.message,
      );
    }
    // Ensure url is a string — some spiders return an object or array
    let url = parsed.url || '';
    if (typeof url !== 'string') {
      url = JSON.stringify(url);
      if (url === '""' || url === '[]' || url === '{}') url = '';
    }
    let msg = parsed.msg || parsed.errMsg || '';
    if (typeof msg !== 'string') {
      msg = String(msg);
    }
    return {
      url,
      msg,
      raw: raw || '',
    };
  }

  /**
   * 完整的详情页测试流程
   * 1. detailContent 获取详情
   * 2. 解析播放源
   * 3. 对每个播放源调用 playerContent
   *
   * @param {string} key - 源 key
   * @param {string} vodId - 视频 ID
   * @returns {Promise<{success: boolean, detailItems: number, playSources: Array, error?: string}>}
   */
  async testDetailContent(key, vodId) {
    // 步骤1: 获取详情
    const detail = await this.getDetailContent(key, vodId);
    if (detail.list.length === 0) {
      return {
        success: false,
        detailItems: 0,
        playSources: [],
        error: 'detailContent returned empty list',
      };
    }

    const vod = detail.list[0];

    // 步骤2: 解析播放源
    const playSources = this.parsePlaySources(vod);
    if (playSources.length === 0) {
      return {
        success: false,
        detailItems: detail.list.length,
        playSources: [],
        error: 'No vod_play_from or vod_play_url',
      };
    }

    return {
      success: true,
      detailItems: detail.list.length,
      playSources,
      vodName: vod.vod_name || '',
    };
  }

  /**
   * 测试单个播放源
   * @param {string} key - 源 key
   * @param {{flag: string, episodes: Array}} source - 播放源
   * @returns {Promise<{flag: string, success: boolean, url: string, msg: string, episodeName: string, error?: string}>}
   */
  async testPlaySource(key, source) {
    if (!source.episodes || source.episodes.length === 0) {
      return {
        flag: source.flag,
        success: false,
        url: '',
        msg: 'No episodes',
        episodeName: '',
      };
    }

    // 测试第一集
    const ep = source.episodes[0];
    try {
      const player = await this.getPlayerContent(key, source.flag, ep.id);
      return {
        flag: source.flag,
        success: !!player.url,
        url: player.url,
        msg: player.msg,
        episodeName: ep.name,
        playId: ep.id,
      };
    } catch (e) {
      return {
        flag: source.flag,
        success: false,
        url: '',
        msg: e.message,
        episodeName: ep.name,
        playId: ep.id,
        error: e.message,
      };
    }
  }
}

module.exports = DetailPage;
