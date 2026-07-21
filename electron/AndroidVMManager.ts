import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import http from 'http';

const execAsync = promisify(exec);

/**
 * Android VM Manager for Windows
 * 管理Android虚拟机的生命周期
 */
export class AndroidVMManager {
  private vmName = 'Spider-Android';
  private adbPort = 5555;
  private spiderPort = 9978;
  private maxRetries = 30;
  private retryDelay = 2000;

  /**
   * 检查VirtualBox是否安装
   */
  async checkVirtualBox(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('VBoxManage --version');
      console.log(`[AndroidVM] VirtualBox版本: ${stdout.trim()}`);
      return true;
    } catch (error) {
      console.error('[AndroidVM] VirtualBox未安装');
      return false;
    }
  }

  /**
   * 检查虚拟机是否存在
   */
  async checkVMExists(): Promise<boolean> {
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
  async getVMStatus(): Promise<'running' | 'stopped' | 'saved' | 'unknown' | 'not_found'> {
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
  async startVM(headless = true): Promise<boolean> {
    console.log(`[AndroidVM] 启动虚拟机: ${this.vmName}`);
    
    const status = await this.getVMStatus();
    
    if (status === 'running') {
      console.log('[AndroidVM] 虚拟机已在运行');
      return true;
    }
    
    try {
      const mode = headless ? '--type headless' : '';
      await execAsync(`VBoxManage startvm "${this.vmName}" ${mode}`);
      
      console.log('[AndroidVM] 等待虚拟机启动...');
      for (let i = 0; i < this.maxRetries; i++) {
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        
        const currentStatus = await this.getVMStatus();
        if (currentStatus === 'running') {
          console.log('[AndroidVM] ✓ 虚拟机已启动');
          return true;
        }
        
        process.stdout.write('.');
      }
      
      throw new Error('虚拟机启动超时');
    } catch (error: any) {
      console.error('[AndroidVM] ✗ 启动虚拟机失败:', error.message);
      return false;
    }
  }

  /**
   * 停止虚拟机
   */
  async stopVM(): Promise<boolean> {
    console.log(`[AndroidVM] 停止虚拟机: ${this.vmName}`);
    
    const status = await this.getVMStatus();
    
    if (status !== 'running') {
      console.log('[AndroidVM] ✓ 虚拟机已停止');
      return true;
    }
    
    try {
      await execAsync(`VBoxManage controlvm "${this.vmName}" acpipowerbutton`);
      
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const currentStatus = await this.getVMStatus();
        if (currentStatus !== 'running') {
          console.log('[AndroidVM] ✓ 虚拟机已停止');
          return true;
        }
      }
      
      console.log('[AndroidVM] 强制关闭虚拟机...');
      await execAsync(`VBoxManage controlvm "${this.vmName}" poweroff`);
      
      return true;
    } catch (error: any) {
      console.error('[AndroidVM] ✗ 停止虚拟机失败:', error.message);
      return false;
    }
  }

  /**
   * 连接ADB
   */
  async connectADB(): Promise<boolean> {
    console.log('[AndroidVM] 连接ADB...');
    
    try {
      await execAsync('adb kill-server');
      await execAsync('adb start-server');
      await execAsync(`adb connect localhost:${this.adbPort}`);
      
      const { stdout } = await execAsync('adb devices');
      
      if (stdout.includes('localhost:' + this.adbPort)) {
        console.log('[AndroidVM] ✓ ADB连接成功');
        return true;
      }
      
      throw new Error('ADB设备未找到');
    } catch (error: any) {
      console.error('[AndroidVM] ✗ ADB连接失败:', error.message);
      return false;
    }
  }

  /**
   * 启动Spider服务
   */
  async startSpiderService(): Promise<boolean> {
    console.log('[AndroidVM] 启动Spider服务...');
    
    try {
      await execAsync(
        'adb shell am startservice -n com.tvbox.spiderserver/.SpiderHttpService'
      );
      
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const health = await this.checkSpiderHealth();
        if (health) {
          console.log('[AndroidVM] ✓ Spider服务已启动');
          return true;
        }
      }
      
      throw new Error('服务启动超时');
    } catch (error: any) {
      console.error('[AndroidVM] ✗ Spider服务启动失败:', error.message);
      return false;
    }
  }

  /**
   * 停止Spider服务
   */
  async stopSpiderService(): Promise<boolean> {
    console.log('[AndroidVM] 停止Spider服务...');
    
    try {
      await execAsync(
        'adb shell am stopservice -n com.tvbox.spiderserver/.SpiderHttpService'
      );
      console.log('[AndroidVM] ✓ Spider服务已停止');
      return true;
    } catch (error: any) {
      console.error('[AndroidVM] ✗ Spider服务停止失败:', error.message);
      return false;
    }
  }

  /**
   * 检查Spider健康状态
   */
  async checkSpiderHealth(): Promise<boolean> {
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
  async fullStart(apkPath?: string): Promise<boolean> {
    console.log('[AndroidVM] ========================================');
    console.log('[AndroidVM]   Spider Android VM 启动流程');
    console.log('[AndroidVM] ========================================\n');
    
    // 1. 检查VirtualBox
    if (!await this.checkVirtualBox()) {
      return false;
    }
    
    // 2. 检查虚拟机
    if (!await this.checkVMExists()) {
      console.error('[AndroidVM] ✗ 虚拟机不存在，请先运行安装脚本');
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
      console.log('[AndroidVM] 安装Spider APK...');
      try {
        const { stdout } = await execAsync(`adb install -r "${apkPath}"`);
        if (stdout.includes('Success')) {
          console.log('[AndroidVM] ✓ Spider APK安装成功');
        } else {
          throw new Error('安装失败: ' + stdout);
        }
      } catch (error: any) {
        console.error('[AndroidVM] ✗ Spider APK安装失败:', error.message);
        return false;
      }
    }
    
    // 6. 启动服务
    if (!await this.startSpiderService()) {
      return false;
    }
    
    console.log('\n[AndroidVM] ========================================');
    console.log('[AndroidVM]   启动成功！');
    console.log('[AndroidVM] ========================================');
    console.log(`[AndroidVM] Spider API: http://localhost:${this.spiderPort}`);
    console.log(`[AndroidVM] ADB连接: localhost:${this.adbPort}`);
    console.log('[AndroidVM] ========================================\n');
    
    return true;
  }

  /**
   * 完整停止流程
   */
  async fullStop(): Promise<void> {
    console.log('[AndroidVM] ========================================');
    console.log('[AndroidVM]   Spider Android VM 停止流程');
    console.log('[AndroidVM] ========================================\n');
    
    await this.stopSpiderService();
    await this.stopVM();
    
    console.log('\n[AndroidVM] ========================================');
    console.log('[AndroidVM]   停止成功！');
    console.log('[AndroidVM] ========================================\n');
  }
}