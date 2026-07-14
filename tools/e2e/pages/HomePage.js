/**
 * HomePage - 首页页面对象
 *
 * 封装首页所有操作：
 * - 加载 JAR
 * - 获取 spider
 * - 初始化 spider
 * - 调用 homeContent
 * - 调用 categoryContent
 */
const BasePage = require('./BasePage');

class HomePage extends BasePage {
  constructor(page) {
    super(page);
    this.globalJar =
      'https://img2.gelonghui.com/library/e2693-9aa941a0-f96a-40c2-ac23-e6af358d19a7.png;md5;e2693c58ebc58abecc7282b721db79ca';
  }

  /**
   * 前置条件：加载全局 JAR
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async loadJar() {
    const result = await this.invoke('jar:load', this.globalJar, '', false);
    return result || { success: false, error: 'No result' };
  }

  /**
   * 获取 spider 实例
   * @param {string} key - 源 key
   * @param {string} api - spider 类名
   * @param {string} ext - 扩展配置
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async getSpider(key, api, ext) {
    // 第4个参数必须是 JAR URL，否则 JarLoader 会用 jarKey='main' 查找，导致 "JAR not loaded"
    const result = await this.invoke(
      'jar:getSpider',
      key,
      api,
      ext,
      this.globalJar,
    );
    return result || { success: false, error: 'No result' };
  }

  /**
   * 初始化 spider
   * @param {string} key
   * @param {string} ext
   */
  async initSpider(key, ext) {
    await this.invoke('jar:initSpider', key, ext);
  }

  /**
   * 调用 homeContent 获取首页内容
   * @param {string} key - 源 key
   * @returns {Promise<{list: Array, classes: Array, raw: string}>}
   */
  async getHomeContent(key) {
    const raw = await this.invokeWithTimeout(
      60000,
      'jar:callMethod',
      key,
      'homeContent',
      [true],
      {},
    );
    let parsed = {};
    try {
      parsed = JSON.parse(raw || '{}');
    } catch (e) {
      console.warn(
        `[HomePage] homeContent parse failed for ${key}:`,
        e.message,
      );
    }
    return {
      list: parsed.list || [],
      classes: parsed.class || parsed.classes || [],
      raw: raw || '',
    };
  }

  /**
   * 调用 categoryContent 获取分类内容
   * @param {string} key - 源 key
   * @param {string} tid - 分类 ID
   * @param {string} pg - 页码
   * @returns {Promise<{list: Array, page: number, pagecount: number, raw: string}>}
   */
  async getCategoryContent(key, tid, pg = '1') {
    const raw = await this.invokeWithTimeout(
      30000,
      'jar:callMethod',
      key,
      'categoryContent',
      [tid, pg, true, {}],
      {},
    );
    let parsed = {};
    try {
      parsed = JSON.parse(raw || '{}');
    } catch (e) {
      console.warn(
        `[HomePage] categoryContent parse failed for ${key}/${tid}:`,
        e.message,
      );
    }
    return {
      list: parsed.list || [],
      page: parseInt(parsed.page || pg),
      pagecount: parseInt(parsed.pagecount || '1'),
      raw: raw || '',
    };
  }

  /**
   * 完整的首页测试流程
   * 1. getSpider
   * 2. initSpider
   * 3. homeContent
   * 4. 若 homeContent 无视频，尝试 categoryContent
   *
   * @param {string} key
   * @param {string} api
   * @param {string} ext
   * @returns {Promise<{success: boolean, videoCount: number, classCount: number, firstVideo: object, error?: string}>}
   */
  async testHomeContent(key, api, ext) {
    // 步骤1: 获取 spider
    const spiderResult = await this.getSpider(key, api, ext);
    if (!spiderResult.success) {
      return {
        success: false,
        videoCount: 0,
        classCount: 0,
        firstVideo: null,
        error: `getSpider: ${spiderResult.error || 'failed'}`,
      };
    }

    // 步骤2: 初始化 spider
    await this.initSpider(key, ext);

    // 步骤3: 获取 homeContent
    const home = await this.getHomeContent(key);
    let videos = home.list;
    let classes = home.classes;

    // 步骤4: 若 homeContent 无视频但有分类，尝试前3个分类
    if (videos.length === 0 && classes.length > 0) {
      const maxClassesToTry = Math.min(classes.length, 3);
      for (let ci = 0; ci < maxClassesToTry; ci++) {
        try {
          const cat = await this.getCategoryContent(
            key,
            String(classes[ci].type_id),
            '1',
          );
          if (cat.list.length > 0) {
            videos = cat.list;
            break;
          }
        } catch (e) {
          // Continue to next class on timeout/error
          console.warn(
            `[HomePage] categoryContent failed for class ${ci}: ${e.message}`,
          );
        }
      }
    }

    return {
      success: videos.length > 0,
      videoCount: videos.length,
      classCount: classes.length,
      firstVideo: videos[0] || null,
      allVideos: videos,
      allClasses: classes,
    };
  }
}

module.exports = HomePage;
