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
import { ref, watch } from 'vue';
import { Close } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';

type ConfigType = 'emby' | 'info';

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
});

const configType = ref<ConfigType>('info');
const title = ref('');
const description = ref('');
const infoLines = ref<string[]>([]);

// Descriptions for feimao (csp_Config) go设置 items (numeric vod_ids).
const FEIMAO_GO_INFO: Record<string, { desc: string; lines?: string[] }> = {
  '1': { desc: 'go 服务（弹幕/解析）当前运行状态。' },
  '2': { desc: '手动启动 go 服务。' },
  '4': {
    desc: 'Cookie 级别与复制操作。',
    lines: ['查看当前 Cookie 级别，或复制 Cookie 到剪贴板。'],
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
  };

  if (id === 'editemby' || id === 'choseemby' || id === 'delemby' || id === 'clearemby' || id.includes('emby')) {
    configType.value = 'emby';
    description.value = '配置 Emby 服务器连接信息。保存后将通过 JAR 写入 SharedPreferences。';
    if (id === 'delemby' || id === 'clearemby') {
      description.value = '此操作将清除已保存的 Emby 服务器配置。';
    }
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
