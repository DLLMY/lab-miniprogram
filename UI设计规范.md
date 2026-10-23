# UI 设计规范 v2 · 实训室管理系统

> 风格定位：**深空科技顶区 + 雾面浅色内容区 + 玻璃拟态 + 蓝青双主色**
> 目标：简洁大方、现代化、科技感强；用最少装饰承载最高信息密度。

---

## 一、色彩体系

### 主色（双主色：科技蓝 + 灵感青）

| 用途 | 色值 | 说明 |
|---|---|---|
| 品牌主色 | `#2B6CFF` | 按钮、链接、强调数字、选中态 |
| 品牌深 | `#1D4FD8` | 主色渐变收尾 |
| 高光青 | `#22D3EE` | 渐变起点、图标高光、科技感点缀 |
| 青深 | `#0EA5E0` | 青色渐变收尾 |
| 青文字 | `#0891B2` | 青色文字/标签（保证对比度） |

### 语义色

| 用途 | 底色 | 文字色 |
|---|---|---|
| 成功 | `rgba(16,185,129,.12)` | `#059669` |
| 警告 | `rgba(245,158,11,.13)` | `#D97706` |
| 危险 | `rgba(239,68,68,.12)` | `#DC2626` |
| 信息 | `rgba(43,108,255,.12)` | `#2B6CFF` |
| 中性 | `#F1F5F9` | `#64748B` |

### 中性色

| 用途 | 色值 |
|---|---|
| 页面底 | `#F2F5FA` |
| 卡片面 | `#FFFFFF` |
| 主文字 | `#0D1526` |
| 次文字 | `#6B7C96` |
| 辅助文字 | `#94A3B8` / `#8A99AF` |
| 描边 | `rgba(15,35,80,.05)` |
| 分隔线 | `#F0F3F8` |

### 深空区（Hero / 登录页 / 导航栏）

- 渐变：`linear-gradient(135deg, #0A1020 0%, #142A55 52%, #0C1930 100%)`
- 导航栏背景：`#0A1020`
- 青色光晕：`radial-gradient(circle, rgba(34,211,238,.34) 0%, transparent 68%)`
- 蓝色光晕：`radial-gradient(circle, rgba(43,108,255,.30) 0%, transparent 70%)`
- 网格纹理：双向 1rpx 线性渐变，间距 56rpx，透明度 .05

---

## 二、圆角与阴影

| 元素 | 圆角 |
|---|---|
| 大卡 / 容器 | 28rpx |
| Hero 底角 | 40rpx |
| 玻璃卡（登录） | 36rpx |
| 列表项 / 输入框 | 22~26rpx |
| 胶囊 / 芯片 | 999rpx |
| 图标底板 | 22~24rpx |
| 头像 | 26~34rpx |

阴影：
- 卡片 `0 10rpx 34rpx rgba(15,35,80,.055)`
- 列表项 `0 6rpx 20rpx rgba(15,35,80,.04)`
- 主按钮 `0 12rpx 28rpx rgba(43,108,255,.30)`

---

## 三、字号阶梯（rpx）

| 层级 | 字号 | 字重 |
|---|---|---|
| Hero 主标题 | 46 | 700 |
| 页面主标题 | 38~40 | 700 |
| 区块标题 | 32 | 700 |
| 卡片标题 | 30 | 600 |
| 列表主文案 | 29 | 600 |
| 正文 | 28 | 400 |
| 次要 | 25 | 400 |
| 辅助 / 标签 | 22~23 | 400~600 |
| 统计数字 | 44 | 700 |

---

## 四、间距系统

- 页面左右留白：28rpx
- 卡片内边距：32rpx（紧凑 24rpx 28rpx）
- 卡片间距：24rpx
- 区块标题下边距：24rpx
- 列表项间距：16rpx
- 元素内间距：8 / 16 / 24 / 36rpx

---

## 五、组件清单（全局类，app.wxss）

### 布局
`.page` `.page-has-bar`（有吸底条）`.row` `.row-between` `.grow` `.mt-s/m/l` `.grid` `.grid-i` `.grid-c` `.tiles` `.tile`

### 容器
`.hero` `.hero-grid` `.hero-inner` `.hero-t` `.hero-s` `.hero-tag` `.glass` `.card` `.card-tight` `.card-accent`

### 标题
`.sec` `.sec-bar` `.sec-t` `.sec-x` `.title` `.sub` `.muted` `.tip` `.empty` `.empty-ic`

### 数据
`.kv` `.kv-k` `.kv-v` `.tile-n` `.tile-l` `.bar` `.bar-in`

### 控件
`.btn` `.btn-primary` `.btn-cyan` `.btn-ghost` `.btn-dark` `.btn-danger` `.btn-sm` `.btn-block` `.btn-row` `.btn-cell` `.row .btn-s`
`.inp` `.picker-inp` `.field` `.field-l` `.seg` `.seg-i` `.chip` `.chips` `.search` `.search-go`

### 状态
`.pill`（ok/warn/red/blue/cyan/grey）`.role-tag`（teacher/student/admin）`.list-item` `.tap` `.list-ic` `.list-nm` `.list-sub` `.list-arrow` `.avatar` `.avatar-sm`

### 拦截
`.guard` `.guard-ic` `.guard-t` `.guard-s`

---

## 六、图标规范

- 全部为 **线条风格 PNG**，24×24 归一化网格绘制，96×96 输出（tabBar 81×81）
- 5 种配色变体：`w`(白) `d`(深藏青) `b`(品牌蓝) `c`(青) `s`(灰)
- 存放于 `images/`，命名 `ic-{名称}-{变体}.png`
- 重新生成：`python tools/gen-icons.py`

---

## 七、页面结构约定

| 页面 | 结构 |
|---|---|
| 登录 | 全屏深空底 + 居中 Logo + 玻璃绑定卡 + 两列快捷账号 |
| 工作台 | 深空 Hero（问候/角色/扫码CTA）→ 统计瓦片 → 搜索 → 功能宫格 → 示例 |
| 我的 | 深空档案头（头像/工号/角色/数据源）→ 账号 → 教师宫格 → 申请列表 → 自检 |
| 物品详情 | 深空头（大图标/名称/ID）→ 统计瓦片 → 档案 KV → 库存水位条 → 吸底操作条 |
| 领用审批 | 深空头（大号待处理数）→ 审批卡 + 通过/拒绝双按钮 |
| 出入库 | 深空头 → 分段控件（入库/出库）→ 选择器 + 步进器 → 库存预览 → 提交 |
| 库存一览 | 深空头（三项计数）→ 分段（耗材/工具）→ 搜索 → 列表 + 水位条 |
| 使用概况 | 深空头（大号累计操作）→ 统计瓦片 → 教师明细 → 排行榜 + 进度条 |

---

## 八、避坑清单（本次踩过的坑）

1. **宫格单列**：`.grid` 不要加负 margin；`.grid-i` 必须 `min-width:0` + `flex:0 0 50%`；`.grid-c` 加 `width:100%`
2. **标题竖排**：flex 容器内的 `.title` 需 `flex-shrink:0` + `white-space:nowrap`
3. **组件选择器不可靠**：`> image` / `> view` 换成专用 class（`.wk-scan-ic` / `.la-card` / `.btn-cell`）
4. **WXML 不支持字符串下标**：`item.name[0]` 需在 JS 预计算 `initial`
5. **WXML 避免数值/比较运算**：预计算到 JS（如 `pct` / `low` / `lowStock`）
6. **吸底条遮挡内容**：页面改用 `.page-has-bar`（底部留 160rpx）
7. **长文本撑破卡片**：`.list-nm` / `.list-sub` / `.tile-n` 加 `overflow:hidden` + `text-overflow:ellipsis`

---

## 九、预览工具

```bash
node tools/render-preview.js     # 生成 preview/index.html
```

直接解析真实 WXML + 真实 WXSS + 真实 PNG 图标渲染，不是手工复刻。
源码改动后重跑即可同步更新预览。

> 注：预览器把小程序标签映射为 HTML（view→div / text→span / image→img），
> 组件样式在小程序中由框架渲染，预览为等效近似；布局与配色与线上一致。
