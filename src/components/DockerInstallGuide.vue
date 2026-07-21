<template>
  <el-dialog
    title="需要安装Docker Desktop"
    :visible.sync="visible"
    width="650px"
    :close-on-click-modal="false"
    :show-close="false"
    custom-class="docker-install-dialog"
  >
    <div class="install-container">
      <!-- 警告提示 -->
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        class="warning-alert"
      >
        <template #title>
          <span class="warning-title">检测到您的系统未安装Docker</span>
        </template>
        <div class="warning-content">
          TVBox需要Docker来运行Spider服务。Docker是一个容器化平台，用于在隔离环境中运行Android应用。
        </div>
      </el-alert>

      <!-- 安装方式选择 -->
      <div class="install-options">
        <h3 class="section-title">请选择安装方式：</h3>

        <el-radio-group v-model="selectedMethod" class="method-group">
          <!-- 自动安装 -->
          <el-card
            class="method-card"
            :class="{ active: selectedMethod === 'auto' }"
          >
            <el-radio label="auto" class="method-radio">
              <div class="method-header">
                <span class="method-title">自动安装（推荐）</span>
                <el-tag v-if="hasAdmin" type="success" size="mini">推荐</el-tag>
              </div>
            </el-radio>
            <div class="method-content">
              <p class="method-desc">
                自动下载并安装Docker Desktop
              </p>
              <el-button
                type="primary"
                size="small"
                :loading="installing"
                :disabled="!hasAdmin || installing"
                @click="handleAutoInstall"
              >
                {{ installing ? '安装中...' : '开始安装' }}
              </el-button>
              <el-alert
                v-if="!hasAdmin"
                type="info"
                :closable="false"
                class="permission-hint"
              >
                需要管理员权限，请右键应用选择"以管理员身份运行"
              </el-alert>
            </div>
          </el-card>

          <!-- 手动安装 -->
          <el-card
            class="method-card"
            :class="{ active: selectedMethod === 'manual' }"
          >
            <el-radio label="manual" class="method-radio">
              <div class="method-header">
                <span class="method-title">手动下载安装</span>
              </div>
            </el-radio>
            <div class="method-content">
              <p class="method-desc">
                访问官网下载安装器并手动安装
              </p>
              <el-button
                type="primary"
                size="small"
                @click="handleManualInstall"
              >
                打开下载页面
              </el-button>
            </div>
          </el-card>

          <!-- Chocolatey安装 -->
          <el-card
            class="method-card"
            :class="{ active: selectedMethod === 'chocolatey' }"
          >
            <el-radio label="chocolatey" class="method-radio">
              <div class="method-header">
                <span class="method-title">通过Chocolatey安装</span>
                <el-tag v-if="hasChoco" type="success" size="mini">可用</el-tag>
                <el-tag v-else type="info" size="mini">需要安装</el-tag>
              </div>
            </el-radio>
            <div class="method-content">
              <p class="method-desc">
                使用Chocolatey包管理器安装
              </p>
              <el-button
                type="primary"
                size="small"
                :loading="installing"
                :disabled="!hasAdmin || !hasChoco || installing"
                @click="handleChocoInstall"
              >
                开始安装
              </el-button>
              <el-button
                v-if="!hasChoco"
                type="text"
                size="small"
                @click="openChocolateyPage"
              >
                安装Chocolatey
              </el-button>
            </div>
          </el-card>
        </el-radio-group>
      </div>

      <!-- 系统要求 -->
      <div class="requirements">
        <h3 class="section-title">系统要求：</h3>
        <ul class="requirements-list">
          <li>
            <el-icon v-if="checkWsl" class="check-icon success"><check /></el-icon>
            <el-icon v-else class="check-icon warning"><warning /></el-icon>
            Windows 10 版本 2004+ 或 Windows 11
          </li>
          <li>
            <el-icon class="check-icon"><info-filled /></el-icon>
            启用WSL 2功能
          </li>
          <li>
            <el-icon class="check-icon"><info-filled /></el-icon>
            至少4GB内存
          </li>
          <li>
            <el-icon class="check-icon"><info-filled /></el-icon>
            BIOS中启用虚拟化（VT-x/AMD-V）
          </li>
        </ul>

        <div class="guide-links">
          <el-button type="text" @click="showDetailedGuide">
            查看详细安装教程 →
          </el-button>
          <el-button type="text" @click="showWSLGuide">
            WSL 2安装指南 →
          </el-button>
        </div>
      </div>

      <!-- 安装进度 -->
      <el-progress
        v-if="installing"
        :percentage="installProgress.percent || 0"
        :status="installProgress.status"
        class="install-progress"
      />
      <p v-if="installing" class="install-message">
        {{ installProgress.message }}
      </p>
    </div>

    <!-- 底部按钮 -->
    <div slot="footer" class="dialog-footer">
      <el-button @click="handleSkip">跳过（手动启动）</el-button>
      <el-button
        type="primary"
        :disabled="installing"
        @click="handleCheckAgain"
      >
        已安装，检测
      </el-button>
    </div>
  </el-dialog>
</template>

<script>
import { ref, computed, onMounted } from 'vue';
import { Check, Warning, InfoFilled } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';

export default {
  name: 'DockerInstallGuide',
  components: {
    Check,
    Warning,
    InfoFilled,
  },
  props: {
    visible: {
      type: Boolean,
      default: false,
    },
  },
  setup(props, { emit }) {
    const selectedMethod = ref('auto');
    const hasAdmin = ref(false);
    const hasChoco = ref(false);
    const checkWsl = ref(false);
    const installing = ref(false);
    const installProgress = ref({
      percent: 0,
      status: '',
      message: '',
    });

    // 检测系统状态
    onMounted(async () => {
      await checkSystemStatus();
    });

    const checkSystemStatus = async () => {
      try {
        // 检测管理员权限
        hasAdmin.value = await window.electronIPC.invoke('docker:hasAdmin');

        // 检测Chocolatey
        hasChoco.value = await window.electronIPC.invoke('docker:hasChoco');

        // 检测WSL
        const wslCheck = await window.electronIPC.invoke('docker:checkWSL');
        checkWsl.value = wslCheck.installed;
      } catch (error) {
        console.error('Failed to check system status:', error);
      }
    };

    // 自动安装
    const handleAutoInstall = async () => {
      try {
        installing.value = true;
        installProgress.value = {
          percent: 0,
          status: '',
          message: '正在准备安装...',
        };

        await window.electronIPC.invoke('docker:autoInstall', (progress) => {
          installProgress.value = {
            percent: progress.percent || 0,
            status: progress.stage === 'done' ? 'success' : '',
            message: progress.message,
          };
        });

        ElMessage.success('Docker Desktop安装成功！');

        setTimeout(() => {
          emit('installed');
        }, 2000);
      } catch (error) {
        ElMessage.error(`安装失败: ${error.message}`);
        installProgress.value.status = 'exception';
      } finally {
        installing.value = false;
      }
    };

    // 手动安装
    const handleManualInstall = () => {
      window.electronIPC.invoke('docker:openDownload');
      ElMessage.info('请在浏览器中下载并安装Docker Desktop');
    };

    // Chocolatey安装
    const handleChocoInstall = async () => {
      try {
        installing.value = true;
        installProgress.value = {
          percent: 50,
          status: '',
          message: '正在通过Chocolatey安装...',
        };

        await window.electronIPC.invoke('docker:chocoInstall');

        ElMessage.success('安装成功！');
        setTimeout(() => {
          emit('installed');
        }, 2000);
      } catch (error) {
        ElMessage.error(`安装失败: ${error.message}`);
      } finally {
        installing.value = false;
      }
    };

    // 再次检测
    const handleCheckAgain = async () => {
      try {
        const result = await window.electronIPC.invoke('docker:check');

        if (result.installed && result.running) {
          ElMessage.success('Docker已安装并运行！');
          emit('installed');
        } else if (result.installed) {
          ElMessage.warning('Docker已安装但未运行，请先启动Docker Desktop');
        } else {
          ElMessage.warning('未检测到Docker安装');
        }
      } catch (error) {
        ElMessage.error('检测失败: ' + error.message);
      }
    };

    // 跳过安装
    const handleSkip = () => {
      ElMessageBox.confirm(
        '跳过Docker安装将无法使用Spider服务，确定要跳过吗？',
        '确认跳过',
        {
          confirmButtonText: '确定',
          cancelButtonText: '取消',
          type: 'warning',
        }
      ).then(() => {
        emit('skip');
      }).catch(() => {
        // 用户取消
      });
    };

    // 显示详细指南
    const showDetailedGuide = () => {
      window.electronIPC.invoke('docker:openGuide');
    };

    // 显示WSL指南
    const showWSLGuide = () => {
      window.electronIPC.invoke('docker:openWSLGuide');
    };

    // 打开Chocolatey页面
    const openChocolateyPage = () => {
      window.electronIPC.invoke('docker:openChocolatey');
    };

    return {
      selectedMethod,
      hasAdmin,
      hasChoco,
      checkWsl,
      installing,
      installProgress,
      handleAutoInstall,
      handleManualInstall,
      handleChocoInstall,
      handleCheckAgain,
      handleSkip,
      showDetailedGuide,
      showWSLGuide,
      openChocolateyPage,
    };
  },
};
</script>

<style scoped>
.docker-install-dialog {
  border-radius: 8px;
}

.install-container {
  max-height: 70vh;
  overflow-y: auto;
}

.warning-alert {
  margin-bottom: 20px;
}

.warning-title {
  font-weight: bold;
  font-size: 14px;
}

.warning-content {
  margin-top: 8px;
  line-height: 1.6;
}

.section-title {
  font-size: 15px;
  margin: 20px 0 12px;
  color: #303133;
}

.install-options {
  margin: 20px 0;
}

.method-group {
  width: 100%;
}

.method-card {
  margin-bottom: 12px;
  cursor: pointer;
  transition: all 0.3s;
  border: 2px solid transparent;
}

.method-card.active {
  border-color: #409eff;
}

.method-card:hover {
  border-color: #409eff;
}

.method-radio {
  width: 100%;
}

.method-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.method-title {
  font-weight: bold;
  font-size: 14px;
}

.method-content {
  margin-top: 12px;
  padding-left: 24px;
}

.method-desc {
  color: #606266;
  margin-bottom: 12px;
  font-size: 13px;
}

.permission-hint {
  margin-top: 8px;
}

.requirements {
  background: #f5f7fa;
  padding: 16px;
  border-radius: 6px;
  margin: 20px 0;
}

.requirements-list {
  margin: 0;
  padding-left: 0;
  list-style: none;
}

.requirements-list li {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
  font-size: 13px;
}

.check-icon {
  margin-right: 8px;
}

.check-icon.success {
  color: #67c23a;
}

.check-icon.warning {
  color: #e6a23c;
}

.guide-links {
  margin-top: 12px;
  display: flex;
  gap: 16px;
}

.install-progress {
  margin: 20px 0 12px;
}

.install-message {
  text-align: center;
  color: #606266;
  font-size: 13px;
}

.dialog-footer {
  text-align: right;
}
</style>