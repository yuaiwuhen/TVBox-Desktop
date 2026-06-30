# TVBox-PC 现代 UI 重设计方案

## Context

当前 TVBox-PC 的 UI 存在严重问题：Tailwind CSS 实际未安装导致所有工具类不生效、style.css 是 Vite 脚手架残留（`#app { width: 1126px }` 覆盖了 Tailwind 的 `w-full`）、没有统一的色彩系统、详情页不是独立路由导致浏览器后退不可用、播放器控件使用 emoji 字符跨平台渲染不一致。需要全面重设计为现代化的暗色主题视频应用。

---

## Phase 1: 基础设施（设计系统 + 清理）

### 1.1 安装 Tailwind CSS v4
- `pnpm add -D tailwindcss @tailwindcss/vite`
- `vite.config.ts` 添加 Tailwind Vite 插件
- `src/style.css` 顶部添加 `@import "tailwindcss"`

### 1.2 重写 style.css
- 删除所有 Vite scaffold 残留样式
- 定义 CSS 设计令牌：主色琥珀橙 `#E8913A`、深色表面 `#0F1117/#161923/#1E2130`、文字层级、边框、圆角、阴影、过渡时间
- `#app { width: 100%; height: 100vh; overflow: hidden; }`

### 1.3 Element Plus 暗色主题
- `main.ts` 导入 `element-plus/theme-chalk/dark/css-vars.css`
- CSS 变量覆盖 Element Plus 主色为 `#E8913A`，背景/文字/边框色适配暗色系

### 1.4 清理
- 删除 `src/components/HelloWorld.vue`、`src/assets/vite.svg`、`src/assets/hero.png`、`src/assets/vue.svg`

---

## Phase 2: App 布局 + 路由重构

### 2.1 App.vue 布局
- Sidebar: `var(--color-bg-surface)` 背景，展开 200px/折叠 64px，过渡动画 `400ms cubic-bezier(0.4,0,0.2,1)`
- 活跃菜单项: 左侧 3px 橙色竖线 + `var(--color-primary-soft)` 背景
- Topbar: 56px 高，左侧源选择器，右侧壁纸/窗口控制
- Content: `var(--color-bg-base)` 背景

### 2.2 路由重构 - 详情页独立路由
- 新增路由 `/detail/:sourceKey/:vodId`
- 从 Home.vue 抽取详情+播放器逻辑到 `src/views/Detail.vue`
- Home.vue 卡片点击 → `router.push({ name: 'detail', params })`
- History/Favorites 点击 → 同上（不再 `router.push('/')`）
- `keep-alive` 排除 Detail 组件

---

## Phase 3: 各页面重设计

### 3.1 Home.vue
- 删除内部 topbar（源选择器移到 App.vue）
- 分类标签: `el-radio-group` → 横向可滚动胶囊标签
- 视频卡片: 深色背景、封面 `aspect-[3/4]` 底部渐变遮罩、hover `-translate-y-1` + `scale(1.05)`
- 图片加载失败兜底: 灰色占位 + Film 图标
- 网格: `grid-cols-2 sm:3 md:4 lg:5 xl:7`

### 3.2 Search.vue
- ResultGroup 从 `defineComponent + h()` 改为独立 SFC `SearchResultGroup.vue`
- 深色输入框、历史/热搜标签暗色底

### 3.3 Live.vue
- 三栏改为弹性响应式: `w-48 lg:w-56` + `w-52 lg:w-64` + flex-1
- 统一深色: 侧边栏/频道列表/信息栏使用设计令牌色
- 当前频道高亮: `var(--color-primary-soft)` 背景

### 3.4 History.vue
- 改为网格布局（与 Favorites 统一），封面底部叠加 2px 进度条
- 保留列表视图可选切换

### 3.5 Favorites.vue
- 删除按钮 hover 才显示
- 统一卡片样式

### 3.6 Drive.vue
- 深色侧边栏 + 文件列表
- 面包屑用 `el-breadcrumb`

### 3.7 Settings.vue
- 全高滚动，去掉白卡片容器
- 深色表单

---

## Phase 4: VideoPlayer 控制栏

### 4.1 替换 emoji → Element Plus 图标
- "弹" → `ChatDotRound`，"⚙" → `Setting`，"字" → `Document`
- "⏪/⏩" → `DArrowLeft/DArrowRight`，"⏸/▶" → `VideoPause/VideoPlay`
- "🔇" → `Mute/Microphone`，"⛶" → `FullScreen`，"🔒" → `Lock`

### 4.2 控制栏重组
- 顶栏: [标题] ... [弹幕][字幕][画中画][锁屏][全屏]
- 底栏: [时间] ===进度条=== [总时长] [⏮⏪▶⏩⏭] [倍速][音量] [更多]
- 次要功能（比例、片头尾跳过）收纳到 "更多" dropdown

### 4.3 视觉升级
- 背景: `bg-gradient-to-b from-black/70 to-black/90`
- 按钮: 透明底 + 白色图标，hover `bg-white/10`
- 进度条: 2px 细线，hover 4px，已播部分 `var(--color-primary)`

---

## Phase 5: 动画 + 微交互

- 页面切换: `opacity + translateX` 200ms
- 卡片 hover: `-translate-y-4px` + shadow，封面 `scale(1.05)` over 500ms
- Sidebar 折叠: 宽度 400ms，文字 opacity 200ms 提前消失
- 详情页进入: `opacity 0→1` + `translateY(20px→0)` 300ms

---

## Phase 6: VodCover 通用组件

- 创建 `src/components/VodCover.vue`
- 处理图片加载失败: 灰色占位 + Film 图标 + 标题
- `loading="lazy"` 懒加载
- 在 Home/Search/History/Favorites 中统一使用

---

## 不改动的部分
- `src/core/` 所有核心逻辑文件
- `src/store/app.ts` 的状态逻辑（仅修改导航方式）
- `electron/` 主进程配置
- 核心运行时依赖版本

## 关键文件
- `src/style.css` — 全局样式重写
- `src/App.vue` — 布局重构
- `src/router.ts` — 路由新增
- `src/views/Detail.vue` — 新建详情页
- `src/views/Home.vue` — 瘦身 + 暗色适配
- `src/components/VideoPlayer.vue` — 控制栏现代化
- `src/components/SearchResultGroup.vue` — 新建搜索结果组件
- `src/components/VodCover.vue` — 新建通用封面组件

## 验证方式
1. `pnpm build` 0 错误
2. `pnpm dev` 启动后各页面渲染正确、交互正常
3. 详情路由可直接通过 URL 访问
4. 浏览器后退按钮正常工作
5. 播放器所有控件使用图标而非 emoji
6. 暗色主题全局一致
