/**
 * BasePage - Page Object Model 基类
 *
 * 提供所有页面对象共享的基础功能：
 * - CDP 连接管理
 * - IPC 调用封装
 * - 通用等待和断言方法
 */
class BasePage {
  /**
   * @param {import('playwright').Page} page - Playwright 页面对象
   */
  constructor(page) {
    this.page = page;
  }

  /**
   * 调用 Electron IPC 方法（带超时）
   *
   * 超时通过 invokeWithTimeout 方法设置，此方法使用默认 30s 超时。
   *
   * @param {string} channel - IPC 频道名
   * @param  {...any} args - 参数
   * @returns {Promise<any>}
   */
  async invoke(channel, ...args) {
    return this.invokeWithTimeout(30000, channel, ...args);
  }

  /**
   * 调用 Electron IPC 方法（自定义超时）
   *
   * @param {number} timeoutMs - 超时毫秒
   * @param {string} channel - IPC 频道名
   * @param  {...any} args - 参数
   * @returns {Promise<any>}
   */
  async invokeWithTimeout(timeoutMs, channel, ...args) {
    return await this.page.evaluate(
      async ({ ch, a, t }) => {
        const { ipcRenderer } = require('electron');
        const promise = ipcRenderer.invoke(ch, ...a);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`IPC ${ch} timeout after ${t}ms`)),
            t,
          ),
        );
        return await Promise.race([promise, timeoutPromise]);
      },
      { ch: channel, a: args, t: timeoutMs },
    );
  }

  /**
   * 在页面上下文中执行函数
   * @param {Function} fn - 要执行的函数
   * @param  {...any} args - 参数
   * @returns {Promise<any>}
   */
  async evaluate(fn, ...args) {
    return await this.page.evaluate(fn, ...args);
  }

  /**
   * 等待指定毫秒
   * @param {number} ms
   */
  async wait(ms) {
    await this.page.waitForTimeout(ms);
  }

  /**
   * 断言条件为真
   * @param {boolean} condition
   * @param {string} message
   * @throws {Error}
   */
  assert(condition, message) {
    if (!condition) {
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  /**
   * 断言值不为空
   * @param {*} value
   * @param {string} name
   */
  assertNotEmpty(value, name) {
    this.assert(
      value !== null && value !== undefined && value !== '',
      `${name} should not be empty, got: ${JSON.stringify(value)}`.substring(
        0,
        200,
      ),
    );
  }

  /**
   * 断言数组长度大于等于指定值
   * @param {Array} arr
   * @param {number} minLen
   * @param {string} name
   */
  assertMinLength(arr, minLen, name) {
    this.assert(
      Array.isArray(arr) && arr.length >= minLen,
      `${name} should have at least ${minLen} items, got: ${Array.isArray(arr) ? arr.length : 'not array'}`,
    );
  }
}

module.exports = BasePage;
