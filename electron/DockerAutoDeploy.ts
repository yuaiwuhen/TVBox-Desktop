// Check Docker environment on startup
async function checkDockerEnvironment(): Promise<void> {
  try {
    console.log('[Main] Checking Docker environment...');
    
    // Import DockerManager
    const { dockerManager } = await import('./DockerIPC');
    
    // Check if Docker is installed and running
    const status = await dockerManager.checkDockerRunning();
    
    if (!status.installed) {
      console.log('[Main] Docker not installed');
      // Notify renderer to show Docker install guide
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('docker:status', {
          installed: false,
          running: false,
          message: 'Docker未安装，请先安装Docker Desktop'
        });
      }
      return;
    }
    
    if (!status.running) {
      console.log('[Main] Docker installed but not running');
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('docker:status', {
          installed: true,
          running: false,
          message: 'Docker已安装但未运行，正在尝试启动...'
        });
      }
      
      // Try to start Docker service
      try {
        await dockerManager.startDockerService();
        console.log('[Main] Docker service started successfully');
      } catch (error: any) {
        console.error('[Main] Failed to start Docker service:', error);
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.webContents.send('docker:status', {
            installed: true,
            running: false,
            error: error.message,
            message: 'Docker服务启动失败，请手动启动Docker Desktop'
          });
        }
        return;
      }
    }
    
    console.log('[Main] Docker is running, version:', status.version);
    
    // Notify renderer that Docker is ready
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send('docker:status', {
        installed: true,
        running: true,
        message: 'Docker运行正常，正在准备Spider服务...'
      });
    }
    
    // Check and pull/build Docker image
    try {
      const imageExists = await dockerManager.imageExists();
      if (!imageExists) {
        console.log('[Main] Spider image not found, pulling/building...');
        
        if (win) {
          win.webContents.send('docker:status', {
            installed: true,
            running: true,
            pullingImage: true,
            message: '正在下载Spider服务镜像，首次运行需要几分钟...'
          });
        }
        
        // Try to build image using docker-compose
        const { promisify } = await import('util');
        const { exec: execCallback } = await import('child_process');
        const exec = promisify(execCallback);
        
        try {
          const projectRoot = path.resolve(__dirname, '..');
          await exec('pnpm docker:build', { 
            cwd: projectRoot,
            timeout: 600000 // 10分钟超时
          });
          console.log('[Main] Spider image built successfully');
        } catch (buildError: any) {
          console.error('[Main] Failed to build image:', buildError);
          throw new Error(`镜像构建失败: ${buildError.message}`);
        }
      } else {
        console.log('[Main] Spider image already exists');
      }
    } catch (error: any) {
      console.error('[Main] Failed to prepare Docker image:', error);
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('docker:status', {
          installed: true,
          running: true,
          error: error.message,
          message: 'Spider镜像准备失败: ' + error.message
        });
      }
      return;
    }
    
    // Check if Spider container is running
    const containerStatus = await dockerManager.getContainerStatus();
    if (!containerStatus.running) {
      console.log('[Main] Spider container not running, starting...');
      
      if (win) {
        win.webContents.send('docker:status', {
          installed: true,
          running: true,
          startingContainer: true,
          message: '正在启动Spider服务容器...'
        });
      }
      
      // Try to start the container
      try {
        await dockerManager.startContainer();
        console.log('[Main] Spider container started successfully');
      } catch (error: any) {
        console.error('[Main] Failed to start Spider container:', error);
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.webContents.send('docker:status', {
            installed: true,
            running: true,
            containerRunning: false,
            error: error.message,
            message: 'Spider容器启动失败: ' + error.message
          });
        }
        return;
      }
    } else {
      console.log('[Main] Spider container is running');
    }
    
    // Wait for Spider service to be ready
    console.log('[Main] Waiting for Spider service to be ready...');
    if (win) {
      win.webContents.send('docker:status', {
        installed: true,
        running: true,
        containerRunning: true,
        initializing: true,
        message: 'Spider容器已启动，等待服务就绪...'
      });
    }
    
    // Check service health
    try {
      const axios = (await import('axios')).default;
      let retries = 0;
      const maxRetries = 30; // 30次，每次2秒，总共60秒
      
      while (retries < maxRetries) {
        try {
          const response = await axios.get('http://localhost:9978/health', { 
            timeout: 3000 
          });
          
          if (response.data && response.data.success) {
            console.log('[Main] Spider service is ready');
            
            if (win) {
              win.webContents.send('docker:status', {
                installed: true,
                running: true,
                containerRunning: true,
                serviceReady: true,
                message: 'Spider服务已就绪，可以正常使用'
              });
            }
            return;
          }
        } catch {
          // Service not ready yet, retry
          retries++;
          if (retries < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }
      
      // If we get here, service didn't become ready
      throw new Error('服务启动超时。可能需要手动安装Spider APK');
      
    } catch (error: any) {
      console.error('[Main] Spider service not ready:', error);
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('docker:status', {
          installed: true,
          running: true,
          containerRunning: true,
          serviceReady: false,
          error: error.message,
          message: 'Spider服务未就绪: ' + error.message
        });
      }
    }
    
  } catch (error: any) {
    console.error('[Main] Docker check failed:', error);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send('docker:status', {
        error: error.message,
        message: 'Docker环境检查失败: ' + error.message
      });
    }
  }
}