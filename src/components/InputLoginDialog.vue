<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="visible" class="input-mask" @click.self="handleClose">
        <div class="input-dialog">
          <div class="input-header">
            <span class="input-title">{{ title }}</span>
            <button class="input-close" @click="handleClose">
              <el-icon :size="18"><Close /></el-icon>
            </button>
          </div>
          <div class="input-body">
            <p class="input-desc">{{ description }}</p>
            <el-input
              v-model="inputValue"
              :type="multiline ? 'textarea' : 'text'"
              :rows="multiline ? 4 : undefined"
              :placeholder="placeholder"
              :show-password="!multiline && mask"
              clearable
              class="input-field"
              @keyup.enter="!multiline && handleSave()"
            />
            <div v-if="hint" class="input-hint">{{ hint }}</div>
            <div v-if="error" class="input-error">{{ error }}</div>
          </div>
          <div class="input-footer">
            <el-button @click="handleClose">取消</el-button>
            <el-button type="primary" :loading="saving" @click="handleSave">
              保存
            </el-button>
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
import { PanLogin, type PanType } from '../core/PanLogin';

const props = defineProps<{
  visible: boolean;
  panType: PanType | '';
  vodId?: string;
  vodName?: string;
  /** Initial value (e.g., masked current cookie for editing) */
  initialValue?: string;
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'success', info: { panType: PanType }): void;
}>();

const inputValue = ref('');
const error = ref('');
const saving = ref(false);

const title = ref('');
const description = ref('');
const placeholder = ref('');
const hint = ref('');
const multiline = ref(false);
const mask = ref(false);

function buildDialogMeta() {
  const panType = props.panType;
  const vodId = (props.vodId || '').toLowerCase();
  // Defaults
  title.value = props.vodName || '请输入凭证';
  description.value = '请输入完整的 cookie 字符串，保存后将存储到 JAR 中。';
  placeholder.value = '请输入 cookie...';
  hint.value = '';
  multiline.value = true;
  mask.value = false;

  // Customize based on panType / vodId
  if (panType === '115safe' || vodId.includes('safecode')) {
    title.value = props.vodName || '115安全码设置';
    description.value = '请输入 115 网盘的安全码（5 位数字）。';
    placeholder.value = '例如：12345';
    hint.value = '安全码在 115 网盘 APP 设置中查看。';
    multiline.value = false;
    mask.value = true;
    return;
  }
  if (vodId.includes('tianyilogin') || vodId.includes('pan123login') || vodId.includes('leijingcookie')) {
    description.value = '请输入账号:密码 或完整 cookie 字符串。';
    placeholder.value = '账号:密码 或 cookie';
    hint.value = '示例格式：13800138000:password 或 cookie 字符串';
    multiline.value = true;
    return;
  }
  if (panType === 'guangya') {
    description.value = '请输入光鸭网盘的 token（在光鸭 APP 中获取）。';
    placeholder.value = '请输入 token...';
    multiline.value = true;
    return;
  }
  if (panType === 'bili') {
    description.value = '请输入 B 站 cookie 字符串（包含 SESSDATA、bili_jct 等字段）。';
    placeholder.value = 'SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx';
    multiline.value = true;
    return;
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      buildDialogMeta();
      inputValue.value = props.initialValue || '';
      error.value = '';
    }
  },
  { immediate: true },
);

function handleClose() {
  emit('update:visible', false);
}

async function handleSave() {
  if (!props.panType) {
    error.value = '未指定网盘类型';
    return;
  }
  if (!inputValue.value.trim()) {
    error.value = '请输入凭证内容';
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    await PanLogin.saveLoginInput(props.panType as PanType, inputValue.value.trim());
    ElMessage.success('保存成功');
    emit('success', { panType: props.panType as PanType });
    emit('update:visible', false);
  } catch (e: any) {
    error.value = `保存失败：${e.message || e}`;
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.input-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  backdrop-filter: blur(4px);
}
.input-dialog {
  background: var(--color-bg-elevated, #1f2937);
  border-radius: 14px;
  width: 90%;
  max-width: 520px;
  padding: 0;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  animation: dialogIn 0.2s ease-out;
}
@keyframes dialogIn {
  from { transform: translateY(-10px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
.input-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
}
.input-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary, #fff);
}
.input-close {
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
.input-close:hover {
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--color-text-primary, #fff);
}
.input-body {
  padding: 18px 20px;
}
.input-desc {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--color-text-secondary, #9ca3af);
  line-height: 1.6;
}
.input-field :deep(.el-textarea__inner),
.input-field :deep(.el-input__inner) {
  background: var(--color-bg-base, #111827);
  border-color: var(--color-border, rgba(255, 255, 255, 0.1));
  color: var(--color-text-primary, #fff);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.input-hint {
  margin-top: 10px;
  font-size: 12px;
  color: var(--color-text-tertiary, #6b7280);
  line-height: 1.5;
}
.input-error {
  margin-top: 8px;
  font-size: 12px;
  color: #f56c6c;
}
.input-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
}
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>
