# UI Redesign Plan v2 - Modern & Interactive

## Summary

对 TVBox-PC 全部页面进行现代化视觉重设计，修复交互问题，统一暗色设计系统。

## Current State Analysis

### 严重问题
1. **Live.vue**: 大量硬编码颜色(`bg-gray-50`, `bg-white`, `text-gray-700`, `bg-blue-500`等)，完全脱离 CSS 变量设计系统，在暗色主题下视觉严重不一致
2. **VideoPlayer.vue**: `.ctrl-btn` CSS 类未定义（控制按钮无样式），slider 硬编码 `#409eff` 蓝色而非主色 `#E8913A`
3. **App.vue**: hover 效果用内联 `@mouseenter/@mouseleave` 操作 DOM style，脆弱不优雅；顶栏内容过于稀疏

### 中等问题
4. **Search.vue**: 使用 `!important` 覆盖 Element Plus 默认样式 + 深度选择器修补输入框暗色，说明全局主题覆盖不足
5. **Detail.vue**: 布局基础但缺乏视觉层次和现代感，集数按钮使用 `!mx-0` hack
6. **Home.vue**: 分类/筛选按钮使用原生 `<button>`，风格与 Element Plus 不统一

### 低等问题
7. **Drive.vue**: 文件行 hover 使用内联 DOM 操作
8. 侧边栏折叠时无 tooltip 提示
9. 各页面缺少微交互动画（卡片 hover 缩放已有，但其他交互缺少反馈）

---

## Proposed Changes

### Phase 1: 修复关键样式缺陷

**文件: `src/components/VideoPlayer.vue`**
- 在 `<style scoped>` 中添加 `.ctrl-btn` 样式定义
- 将 slider 的 `#409eff` 替换为 `var(--color-primary)` / `var(--el-color-primary)`

**文件: `src/views/Live.vue`**
- 将所有硬编码 Tailwind 颜色类替换为 CSS 变量内联样式：
  - `bg-gray-50` → `style="background: var(--color-bg-surface)"`
  - `bg-white` → `style="background: var(--color-bg-elevated)"`
  - `text-gray-700` → `style="color: var(--color-text-primary)"`
  - `bg-blue-500 text-white` → 选中态用 CSS 变量 `var(--color-primary-soft)` + `var(--color-primary)`
  - `bg-blue-50 text-blue-600` → 同上
  - `bg-gray-800` / `bg-gray-900` → `var(--color-bg-elevated)` / `var(--color-bg-overlay)`
  - `text-green-400` → `var(--color-success)`
  - `text-gray-400` / `text-gray-500` → `var(--color-text-secondary)` / `var(--color-text-tertiary)`
  - `border-gray-700` → `var(--color-border)`
  - `bg-blue-900/50` → `var(--color-primary-soft)`
  - `hover:bg-gray-100` / `hover:bg-gray-50` / `hover:bg-gray-700` → CSS hover class

### Phase 2: App.vue 侧边栏 + 顶栏现代化

**文件: `src/App.vue`**
- 移除内联 `@mouseenter/@mouseleave` hover 操作，改用 scoped CSS `:hover` 伪类
- 顶栏增加：当前时间显示、搜索快捷入口（点击跳转 /search）
- 侧边栏折叠时给导航项添加 `el-tooltip` 提示
- 侧边栏底部增加版本号显示

### Phase 3: Home.vue 视觉提升

**文件: `src/views/Home.vue`**
- 分类标签添加更精致的选中态（底部指示条 + 背景微变）
- 视频卡片增强：hover 时显示评分/年份浮层、渐变遮罩优化
- 分页器使用 `small` + `background` 属性适配暗色
- 空状态增加引导动画

### Phase 4: Detail.vue 沉浸式布局

**文件: `src/views/Detail.vue`**
- 信息区改为更现代的横向布局：海报 + 信息并排，背景使用模糊海报作氛围
- 选集区优化：集数按钮更紧凑，当前播放集高亮更明显（橙色底色而非仅 type="primary"）
- 播放器区域增加圆角阴影
- 简介区域增加"展开/收起"提示文字
- 添加加载骨架屏动画

### Phase 5: Search.vue 交互优化

**文件: `src/views/Search.vue`**
- 移除 `!important` 覆盖，改用 Element Plus 全局变量覆盖（在 style.css 中补充 `--el-input-*` 变量）
- 搜索历史标签使用更紧凑的设计
- 源选择器改为可折叠的 chip 组
- 搜索结果卡片增加快速预览功能

### Phase 6: style.css 全局补完

**文件: `src/style.css`**
- 补充 Element Plus 输入框暗色变量覆盖（`--el-input-bg-color`, `--el-input-border-color` 等），避免各页面单独用深度选择器修补
- 补充 Element Plus Tabs / Tag / Dialog / Dropdown 暗色变量
- 添加全局 hover 动画 mixin（通过 CSS class `.hover-lift` 等）
- 添加全局 focus ring 样式

---

## Implementation Order

1. **Phase 6** (style.css) → 先补全局变量，后续页面可直接使用
2. **Phase 1** (VideoPlayer + Live) → 修复最严重的样式缺陷
3. **Phase 2** (App.vue) → 主框架现代化
4. **Phase 3** (Home.vue) → 首页视觉提升
5. **Phase 4** (Detail.vue) → 详情页沉浸式
6. **Phase 5** (Search.vue) → 搜索交互优化

## Verification Steps

1. 每个阶段完成后运行 `pnpm build` 确认 0 错误
2. 启动 `pnpm dev` 逐页检查视觉效果：
   - 所有页面暗色主题一致
   - 无硬编码颜色残留
   - hover/focus 交互正常
   - 视频播放器控件样式正确
3. 检查侧边栏折叠/展开动画流畅
4. 检查直播页面三栏布局在暗色下视觉统一

## Assumptions & Decisions

- 保持琥珀橙 `#E8913A` 作为主色调不变
- 不引入新依赖，仅使用 Element Plus + Tailwind CSS v4 + CSS 变量
- 不改变路由结构或组件拆分方式
- 优先修复视觉一致性，其次增加微交互动画
