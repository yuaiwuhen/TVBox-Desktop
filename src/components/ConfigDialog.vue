<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="visible" class="cfg-mask" @click.self="handleClose">
        <div class="cfg-dialog">
          <div class="cfg-header">
            <span class="cfg-title">{{ title }}</span>
            <button class="cfg-close" @click="handleClose">
              <el-icon :size="18"><Close /></el-icon>
            </button>
          </div>
          <div class="cfg-body">
            <p class="cfg-desc">{{ description }}</p>

            <!-- Emby server fields -->
            <template v-if="configType === 'emby'">
              <div class="cfg-field">
                <label>服务器名称</label>
                <el-input v-model="form.name" placeholder="例如：我的 Emby" />
              </div>
              <div class="cfg-field">
                <label>服务器地址</label>
                <el-input v-model="form.url" placeholder="http://192.168.1.100:8096" />
              </div>
              <div class="cfg-field">
                <label>用户名</label>
                <el-input v-model="form.username" placeholder="Emby 用户名" />
              </div>
              <div class="cfg-field">
                <label>密码（可选）</label>
                <el-input v-model="form.password" type="password" show-password placeholder="留空则不使用密码" />
              </div>
            </template>

            <!-- Multi-thread settings -->
            <template v-else-if="configType === 'multithread'">
              <div class="cfg-field">
                <label>多线程状态</label>
                <el-switch v-model="form.enabled" active-text="启用" inactive-text="关闭" />
              </div>
              <div class="cfg-field">
                <label>线程数</label>
                <el-input-number v-model="form.size" :min="1" :max="32" />
              </div>
              <div class="cfg-field">
                <label>DNS</label>
                <el-input v-model="form.dns" placeholder="例如：223.5.5.5 或留空" />
              </div>
            </template>

            <!-- Generic config (boolean toggle) -->
            <template v-else-if="configType === 'toggle'">
              <div class="cfg-field">
                <label>状态</label>
                <el-switch v-model="form.value" active-text="启用" inactive-text="关闭" />
              </div>
            </template>

            <!-- Generic config (text input) -->
            <template v-else-if="configType === 'text'">
              <div class="cfg-field">
                <label>{{ fieldName || '值' }}</label>
                <el-input v-model="form.text" :type="multiline ? 'textarea' : 'text'" :rows="multiline ? 4 : undefined" />
              </div>
            </template>

            <!-- Info-only -->
            <template v-else-if="configType === 'info'">
              <div class="cfg-info-box">
                <p v-for="(line, i) in infoLines" :key="i">{{ line }}</p>
              </div>
            </template>

            <div v-if="error" class="cfg-error">{{ error }}</div>
          </div>
          <div class="cfg-footer">
            <el-button @click="handleClose">关闭</el-button>
            <el-button
              v-if="configType !== 'info'"
              type="primary"
              :loading="saving"
              @click="handleSave"
            >保存</el-button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { Close } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';

function getIPC(): any {
  if ((window as any).electronIPC) return (window as any).electronIPC;
  try {
    const { ipcRenderer } = require('electron');
    return {
      invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
    };
  } catch {
    return null;
  }
}

async function setPref(key: string, value: string): Promise<void> {
  const ipc = getIPC();
  if (!ipc) throw new Error('IPC not available');
  await ipc.invoke('spider-set-pref', { key, value });
}

type ConfigType = 'emby' | 'multithread' | 'toggle' | 'text' | 'info';

const props = defineProps<{
  visible: boolean;
  vodId?: string;
  vodName?: string;
  vodRemarks?: string;
  spiderApi?: string;
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'saved'): void;
}>();

const error = ref('');
const saving = ref(false);

const form = ref<any>({
  name: '', url: '', username: '', password: '',
  enabled: false, size: 4, dns: '',
  value: false, text: '',
});

const configType = ref<ConfigType>('info');
const title = ref('');
const description = ref('');
const fieldName = ref('');
const multiline = ref(false);
const infoLines = ref<string[]>([]);

const prefKey = computed(() => {
  const id = (props.vodId || '').toLowerCase();
  // Map vod_id → SharedPreferences key used by WexConfigGuard
  if (id === 'wexgozhuangtai' || id === 'wexgosize' || id === 'wexgodns') {
    return {
      zhuangtai: 'Wex_wexgo_zhuangtai',
      size: 'Wex_wexgo_size',
      dns: 'Wex_wexgo_dns',
    };
  }
  if (id === 'danmubtn') return { value: 'Wex_danmu_auto' };
  if (id === 'pankaiguan') return { value: 'Wex_pan_zhuanma' };
  if (id === 'panpaixu') return { value: 'Wex_paixu' };
  if (id === 'hongmeng') return { value: 'Wex_hongmeng' };
  if (id === 'alistdiy') return { text: 'Wex_alist_diy' };
  if (id === 'webdavdiy') return { text: 'Wex_webdav_diy' };
  if (id === 'diyvod') return { text: 'Wex_diyvod' };
  return null;
});

// Descriptions for aowu (csp_AAConfigAmns) config items.
// These items don't have PC-side JAR HTTP endpoints, so we show an info
// dialog with the current status (from remarks) and a note to use mobile.
const AOWU_ITEM_INFO: Record<string, { desc: string; lines?: string[] }> = {
  bili: { desc: '哔哩（B 站）相关配置，包括 Cookie、清晰度等。' },
  kugou: { desc: '酷狗音乐配置，用于音乐源解析。' },
  guanying: { desc: '观影配置，包括播放器、解码器等设置。' },
  panlian: { desc: '网盘链路配置，用于网盘转码和解析。' },
  shequ123: { desc: '123 社区入口（需登录账号后访问）。' },
  shequgy: { desc: '光鸭·臻影社入口（需登录账号后访问）。' },
  diyurl: { desc: '自定义解析接口 URL 配置。' },
  backup: { desc: '备份当前配置数据到本地或云端。' },
  restore: { desc: '从备份文件恢复配置数据。' },
  login: {
    desc: '网盘登录管理页，统一管理各网盘账号授权。',
    lines: ['在此页面可查看/登录/退出各网盘账号。', 'PC 端请使用左侧配置列表中各网盘的单独登录入口。'],
  },
  switch: { desc: '网盘转码开关，控制是否启用网盘转码功能。' },
  lineswitch: { desc: '线路开关，控制各播放线路的启用状态。' },
  lineorder: { desc: '线路排序，调整播放线路的优先级顺序。' },
  thread: { desc: '线程数设置，控制并发下载/解析线程数。' },
  go: { desc: '弹幕服务（go 服务）运行状态。' },
  danmu: { desc: '弹幕配置，包括弹幕显示、过滤等设置。' },
  danmucolors: { desc: '弹幕颜色配置。' },
  platform: { desc: '弹幕来源平台配置。' },
};

// Descriptions for feimao (csp_Config) go设置 items (numeric vod_ids).
const FEIMAO_GO_INFO: Record<string, { desc: string; lines?: string[] }> = {
  '1': { desc: 'go 服务（弹幕/解析）当前运行状态。' },
  '2': { desc: '手动启动 go 服务。' },
  '4': {
    desc: '夸克 Cookie 级别与复制操作。',
    lines: ['查看当前夸克 Cookie 级别，或复制 Cookie 到剪贴板。'],
  },
};

function buildDialogMeta() {
  const id = (props.vodId || '').toLowerCase();
  const name = props.vodName || '';
  const remarks = props.vodRemarks || '';
  const api = (props.spiderApi || '').toLowerCase();
  title.value = name;
  description.value = remarks || '请配置以下选项';
  configType.value = 'info';
  infoLines.value = [];
  form.value = {
    name: '', url: '', username: '', password: '',
    enabled: false, size: 4, dns: '',
    value: false, text: '',
  };

  if (id === 'editemby' || id === 'choseemby' || id === 'delemby' || id === 'clearemby' || id.includes('emby')) {
    configType.value = 'emby';
    description.value = '配置 Emby 服务器连接信息。保存后将通过 JAR 写入 SharedPreferences。';
    if (id === 'delemby' || id === 'clearemby') {
      description.value = '此操作将清除已保存的 Emby 服务器配置。';
    }
    return;
  }
  if (id === 'wexgozhuangtai' || id === 'wexgosize' || id === 'wexgodns') {
    configType.value = 'multithread';
    description.value = '多线程下载相关设置。修改后立即生效。';
    // Parse current values from remarks
    if (id === 'wexgosize' && remarks) {
      const n = parseInt(remarks, 10);
      if (!isNaN(n)) form.value.size = n;
    }
    if (id === 'wexgodns' && remarks && remarks !== '点击设置') {
      form.value.dns = remarks;
    }
    if (id === 'wexgozhuangtai') {
      form.value.enabled = remarks.includes('已启动');
    }
    return;
  }
  // 综合 settings — toggle-type
  if (['danmubtn', 'pankaiguan', 'panpaixu', 'hongmeng'].includes(id)) {
    configType.value = 'toggle';
    description.value = `切换 ${name} 状态。`;
    form.value.value = remarks.includes('已开启') || remarks.includes('已启用');
    return;
  }
  // 综合 settings — text-type
  if (['alistdiy', 'webdavdiy', 'diyvod'].includes(id)) {
    configType.value = 'text';
    fieldName.value = name;
    multiline.value = true;
    description.value = `请输入 ${name} 配置内容（JSON 格式）。`;
    return;
  }
  if (id === 'beifenjiekou' || id === 'huifujiekou') {
    configType.value = 'info';
    infoLines.value = [
      `${name}：${remarks}`,
      '',
      '此功能用于备份/恢复 TVBox 配置数据。',
      'PC 端暂不支持此操作，请通过手机端配置中心执行。',
    ];
    return;
  }
  if (id === 'webconfig') {
    configType.value = 'info';
    infoLines.value = [
      '配置中心 Web 地址：',
      '在手机端浏览器或投影仪中打开以下地址进行配置：',
      '',
      'http://<本机IP>:9978/proxy?do=wexconfig',
      '',
      '提示：此地址需要与本机在同一局域网内访问。',
    ];
    return;
  }
  // aowu (csp_AAConfigAmns) — spider-specific config items
  if (api.includes('aaconfigamns') && AOWU_ITEM_INFO[id]) {
    const info = AOWU_ITEM_INFO[id];
    configType.value = 'info';
    description.value = info.desc;
    infoLines.value = [
      remarks ? `当前状态：${remarks}` : '',
      '',
      ...(info.lines || []),
      'PC 端暂不支持此操作，请通过手机端配置中心设置。',
    ].filter((l) => l !== null && l !== undefined);
    return;
  }
  // feimao (csp_Config) go设置 — numeric vod_ids
  if (api.includes('csp_config') && /^\d+$/.test(id) && FEIMAO_GO_INFO[id]) {
    const info = FEIMAO_GO_INFO[id];
    configType.value = 'info';
    description.value = info.desc;
    infoLines.value = [
      remarks ? `当前状态：${remarks}` : '',
      '',
      ...(info.lines || []),
      'PC 端暂不支持此操作，请通过手机端配置中心设置。',
    ].filter((l) => l !== null && l !== undefined);
    return;
  }
  // Default info
  configType.value = 'info';
  infoLines.value = [
    `${name}：${remarks || '无附加说明'}`,
    '',
    '该配置项 PC 端暂不支持，请通过手机端配置中心设置。',
  ];
}

watch(() => props.visible, (v) => {
  if (v) {
    error.value = '';
    buildDialogMeta();
  }
}, { immediate: true });

function handleClose() {
  emit('update:visible', false);
}

async function handleSave() {
  const id = (props.vodId || '').toLowerCase();
  saving.value = true;
  error.value = '';
  try {
    // For Emby, we'd need to call a specific JAR method to add/select/delete
    // servers. Since the JAR HTTP API doesn't expose Emby management, we
    // show a message that this needs to be done via mobile config center.
    if (configType.value === 'emby') {
      ElMessage.info('Emby 服务器管理请通过手机端配置中心完成。PC 端暂不支持此操作。');
      emit('update:visible', false);
      return;
    }
    if (configType.value === 'multithread') {
      const keys = prefKey.value as any;
      if (id === 'wexgozhuangtai') {
        await setPref(keys.zhuangtai, form.value.enabled ? '1' : '0');
      } else if (id === 'wexgosize') {
        await setPref(keys.size, String(form.value.size));
      } else if (id === 'wexgodns') {
        await setPref(keys.dns, form.value.dns);
      }
      ElMessage.success('设置已保存');
      emit('saved');
      emit('update:visible', false);
      return;
    }
    if (configType.value === 'toggle') {
      const keys = prefKey.value as any;
      if (keys.value) {
        await setPref(keys.value, form.value.value ? '1' : '0');
        ElMessage.success('设置已保存');
        emit('saved');
        emit('update:visible', false);
      }
      return;
    }
    if (configType.value === 'text') {
      const keys = prefKey.value as any;
      if (keys.text) {
        await setPref(keys.text, form.value.text);
        ElMessage.success('设置已保存');
        emit('saved');
        emit('update:visible', false);
      }
      return;
    }
    // Default — just close
    emit('update:visible', false);
  } catch (e: any) {
    error.value = `保存失败：${e.message || e}`;
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.cfg-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  backdrop-filter: blur(4px);
}
.cfg-dialog {
  background: var(--color-bg-elevated, #1f2937);
  border-radius: 14px;
  width: 90%;
  max-width: 540px;
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  animation: dialogIn 0.2s ease-out;
}
@keyframes dialogIn {
  from { transform: translateY(-10px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
.cfg-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
  position: sticky;
  top: 0;
  background: var(--color-bg-elevated, #1f2937);
  z-index: 1;
}
.cfg-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary, #fff);
}
.cfg-close {
  background: transparent;
  border: none;
  color: var(--color-text-secondary, #9ca3af);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cfg-close:hover {
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--color-text-primary, #fff);
}
.cfg-body {
  padding: 18px 20px;
}
.cfg-desc {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--color-text-secondary, #9ca3af);
  line-height: 1.6;
}
.cfg-field {
  margin-bottom: 14px;
}
.cfg-field label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary, #d1d5db);
}
.cfg-field :deep(.el-input__inner),
.cfg-field :deep(.el-textarea__inner) {
  background: var(--color-bg-base, #111827);
  border-color: var(--color-border, rgba(255, 255, 255, 0.1));
  color: var(--color-text-primary, #fff);
}
.cfg-info-box {
  background: var(--color-bg-base, #111827);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  padding: 14px 16px;
  font-size: 13px;
  color: var(--color-text-secondary, #d1d5db);
  line-height: 1.7;
  white-space: pre-wrap;
}
.cfg-info-box p {
  margin: 0;
}
.cfg-error {
  margin-top: 10px;
  font-size: 12px;
  color: #f56c6c;
}
.cfg-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
  position: sticky;
  bottom: 0;
  background: var(--color-bg-elevated, #1f2937);
}
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>
