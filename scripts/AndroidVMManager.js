#!/usr/bin/env node

/**
 * Android VM Manager
 * 自动管理Android虚拟机的生命周期
 */

const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const http = require('http');

const execAsync = promisify(exec);

class AndroidVMManager {
  constructor() {
    this.vmName = 'Spider-Android';
    this.adbPort = 5555;
    this.spiderPort = 9978;
    this.maxRetries = 30;
    this.retryDelay = 2000; // 2秒
  }

  /**
   * 检查VirtualBox是否安装
   */
  async checkVirtualBox() {
    try {
      const { stdout } = await execAsync('VBoxManage --version');
      console.log(`✓ VirtualBox版本: ${stdout.trim()}`);
      return true;
    } catch (error) {
      console.error('✗ VirtualBox未安装');
      return false;
    }
  }

  /**
   * 检查虚拟机是否存在
   */
  async checkVMExists() {
    try {
      const { stdout } = await execAsync(
        `VBoxManage showvminfo "${this.vmName}"`
      );
      return stdout.includes('Name: ' + this.vmName);
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取虚拟机状态
   */
  async getVMStatus() {
    try {
      const { stdout } = await execAsync(
        `VBoxManage showvminfo "${this.vmName}" | findstr "State"`
      );
      
      if (stdout.includes('running')) return 'running';
      if (stdout.includes('powered off')) return 'stopped';
      if (stdout.includes('saved')) return 'saved';
      return 'unknown';
    } catch (error) {
      return 'not_found';
    }
  }

  /**
   * 启动虚拟机
   */
  async startVM(headless = true) {
    console.log(`启动虚拟机: ${this.vmName}`);
    
    const status = await this.getVMStatus();
    
    if (status === 'running') {
      console.log('✓ 虚拟机已在运行');
      return true;
    }
    
    try {
      // 启动虚拟机
      const mode = headless ? '--type headless' : '';
      await execAsync(`VBoxManage startvm "${this.vmName}" ${mode}`);
      
      // 等待虚拟机启动
      console.log('等待虚拟机启动...');
      for (let i = 0; i < this.maxRetries; i++) {
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        
        const currentStatus = await this.getVMStatus();
        if (currentStatus === 'running') {
          console.log('✓ 虚拟机已启动');
          return true;
        }
        
        process.stdout.write('.');
      }
      
      throw new Error('虚拟机启动超时');
    } catch (error) {
      console.error('✗ 启动虚拟机失败:', error.message);
      return false;
    }
  }

  /**
   * 停止虚拟机
   */
  async stopVM() {
    console.log(`停止虚拟机: ${this.vmName}`);
    
    const status = await this.getVMStatus();
    
    if (status !== 'running') {
      console.log('✓ 虚拟机已停止');
      return true;
    }
    
    try {
      // ACPI关机
      await execAsync(`VBoxManage controlvm "${this.vmName}" acpipowerbutton`);
      
      // 等待虚拟机关闭
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const currentStatus = await this.getVMStatus();
        if (currentStatus !== 'running') {
          console.log('✓ 虚拟机已停止');
          return true;
        }
      }
      
      // 强制关闭
      console.log('强制关闭虚拟机...');
      await execAsync(`VBoxManage controlvm "${this.vmName}" poweroff`);
      
      return true;
    } catch (error) {
      console.error('✗ 停止虚拟机失败:', error.message);
      return false;
    }
  }

  /**
   * 连接ADB
   */
  async connectADB() {
    console.log('连接ADB...');
    
    try {
      // 重启ADB服务器
      await execAsync('adb kill-server');
      await execAsync('adb start-server');
      
      // 连接到虚拟机
      await execAsync(`adb connect localhost:${this.adbPort}`);
      
      // 验证连接
      const { stdout } = await execAsync('adb devices');
      
      if (stdout.includes('localhost:' + this.adbPort)) {
        console.log('✓ ADB连接成功');
        return true;
      }
      
      throw new Error('ADB设备未找到');
    } catch (error) {
      console.error('✗ ADB连接失败:', error.message);
      return false;
    }
  }

  /**
   * 安装Spider APK
   */
  async installSpiderAPK(apkPath) {
    console.log('安装Spider APK...');
    
    try {
      const { stdout } = await execAsync(`adb install -r "${apkPath}"`);
      
      if (stdout.includes('Success')) {
        console.log('✓ Spider APK安装成功');
        return true;
      }
      
      throw new Error('安装失败: ' + stdout);
    } catch (error) {
      console.error('✗ Spider APK安装失败:', error.message);
      return false;
    }
  }

  /**
   * 启动Spider服务
   */
  async startSpiderService() {
    console.log('启动Spider服务...');
    
    try {
      await execAsync(
        'adb shell am startservice -n com.tvbox.spiderserver/.SpiderHttpService'
      );
      
      // 等待服务启动
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const health = await this.checkSpiderHealth();
        if (health) {
          console.log('✓ Spider服务已启动');
          return true;
        }
      }
      
      throw new Error('服务启动超时');
    } catch (error) {
      console.error('✗ Spider服务启动失败:', error.message);
      return false;
    }
  }

  /**
   * 停止Spider服务
   */
  async stopSpiderService() {
    console.log('停止Spider服务...');
    
    try {
      await execAsync(
        'adb shell am stopservice -n com.tvbox.spiderserver/.SpiderHttpService'
      );
      console.log('✓ Spider服务已停止');
      return true;
    } catch (error) {
      console.error('✗ Spider服务停止失败:', error.message);
      return false;
    }
  }

  /**
   * 检查Spider健康状态
   */
  async checkSpiderHealth() {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: this.spiderPort,
          path: '/health',
          method: 'GET',
          timeout: 5000
        },
        (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.success === true);
            } catch {
              resolve(false);
            }
          });
        }
      );
      
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      
      req.end();
    });
  }

  /**
   * 完整启动流程
   */
  async fullStart(apkPath) {
    console.log('========================================');
    console.log('  Spider Android VM 启动流程');
    console.log('========================================\n');
    
    // 1. 检查VirtualBox
    if (!await this.checkVirtualBox()) {
      return false;
    }
    
    // 2. 检查虚拟机
    if (!await this.checkVMExists()) {
      console.error('✗ 虚拟机不存在，请先运行安装脚本');
      return false;
    }
    
    // 3. 启动虚拟机
    if (!await this.startVM()) {
      return false;
    }
    
    // 4. 连接ADB
    if (!await this.connectADB()) {
      return false;
    }
    
    // 5. 安装APK（如果提供）
    if (apkPath) {
      if (!await this.installSpiderAPK(apkPath)) {
        return false;
      }
    }
    
    // 6. 启动服务
    if (!await this.startSpiderService()) {
      return false;
    }
    
    console.log('\n========================================');
    console.log('  启动成功！');
    console.log('========================================');
    console.log(`Spider API: http://localhost:${this.spiderPort}`);
    console.log(`ADB连接: localhost:${this.adbPort}`);
    console.log('========================================\n');
    
    return true;
  }

  /**
   * 完整停止流程
   */
  async fullStop() {
    console.log('========================================');
    console.log('  Spider Android VM 停止流程');
    console.log('========================================\n');
    
    // 1. 停止服务
    await this.stopSpiderService();
    
    // 2. 停止虚拟机
    await this.stopVM();
    
    console.log('\n========================================');
    console.log('  停止成功！');
    console.log('========================================\n');
  }
}

// CLI接口
if (require.main === module) {
  const manager = new AndroidVMManager();
  const command = process.argv[2];
  const apkPath = process.argv[3];
  
  switch (command) {
    case 'start':
      manager.fullStart(apkPath).then(success => {
        process.exit(success ? 0 : 1);
      });
      break;
      
    case 'stop':
      manager.fullStop().then(() => {
        process.exit(0);
      });
      break;
      
    case 'status':
      manager.getVMStatus().then(status => {
        console.log(`虚拟机状态: ${status}`);
        manager.checkSpiderHealth().then(health => {
          console.log(`Spider服务: ${health ? '运行中' : '已停止'}`);
          process.exit(0);
        });
      });
      break;
      
    default:
      console.log('使用方法:');
      console.log('  node AndroidVMManager.js start [apk-path]  # 启动服务');
      console.log('  node AndroidVMManager.js stop             # 停止服务');
      console.log('  node AndroidVMManager.js status           # 查看状态');
      process.exit(1);
  }
}

module.exports = AndroidVMManager;