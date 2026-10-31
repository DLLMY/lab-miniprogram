# 万州职教中心 · 实训室管理系统

微信小程序 + 云函数后端，面向中职学校实训室日常耗材、设备、报修、巡检的数字化管理；并集成 **WorkBuddy**，支持教师用自然语言查询与受控操作。

> 本仓库为**公开仓库**，仅包含源码与文档，**不含任何明文密钥**（`env.local.js`、个人开发者工具配置等均已 gitignore）。

---

## 一、功能概览

| 模块 | 能力 |
|------|------|
| 物料管理 | 物料台账、库存预警线、出入库、盘点（期初/期末建账）、冲销 |
| 工具管理 | 工具台账、借出/归还登记 |
| 领用审批 | 物料/工具领用申请 → 审批流 → 出入库联动 |
| 报修管理 | 教师提交报修、处理流转（绑定实训室） |
| 巡检管理 | 按实训室分配巡检任务、教师执行反馈（逾期标记） |
| 实训室归属 | 以实训室为核心实体：位置维护、负责人管理、报修/巡检统一归属 |
| 统计报表 | 出入库趋势、Top 物料、低库存/逾期巡检/待审批预警 |
| WorkBuddy 集成 | 教师个人机器人密钥、自然语言只读查询、L1 写操作二次确认、每日预警推送 |

---

## 二、技术架构

```
微信小程序 (miniprogram/)
        │  HTTPS / 微信登录
        ▼
云函数 docsProxy (cloudfunctions/docsProxy/，CloudBase)
        │  统一 action 分发 (prodHandler / mockHandler)
        │  服务端身份推导 (openid → 工号；robot 通道 → 个人密钥反查)
        ▼
数据后端（可切换，67 键契约一致）
   ├── 腾讯文档 (tencentdocs.js)   —— 轻量起步，免数据库
   └── 云数据库   (clouddb.js)      —— 生产推荐，DATA_BACKEND=cloud
前端离线回退 (utils/mock.js)        —— 演示/断网兜底
```

- **双后端同构**：`clouddb.js` / `tencentdocs.js` / `utils/mock.js` 导出完全相同的 67 个业务函数，任一新增/修改须三处同步，由 `tools/test-backend-parity.js` 守护。
- **权限在云端**：所有写操作与敏感读以云函数推导的真实身份为准，前端不再信任客户端传入的 role/user（防越权/IDOR）。

---

## 三、目录结构

```
lab-miniprogram/
├── miniprogram/            # 小程序前端（页面、组件、工具）
│   └── pages/              # index(概览) / materials / tools / repair / inspection / labs / mine(我的) …
├── cloudfunctions/docsProxy/   # 云函数后端
│   ├── index.js           # 分发器、身份与权限闸门、L1 确认门、密钥动作
│   ├── backend-switch.js  # 数据源切换 & robot 通道配置
│   ├── clouddb.js         # 云数据库适配器
│   ├── tencentdocs.js     # 腾讯文档适配器
│   └── env.local.example.js   # 环境变量占位模板（复制为 env.local.js 填真实值）
├── mcp/                   # WorkBuddy 连接器（lab-docs-proxy，stdio MCP）
│   └── docs-proxy-server.js
├── tools/                 # 回归测试与契约守护脚本
├── docs/                  # 设计/集成/操作文档
│   ├── workbuddy-integration.md      # WorkBuddy 集成与部署指南
│   ├── 教师自连接操作卡.md            # 教师 4 步自连 WorkBuddy
│   └── workbuddy-conversation-design.md  # 对话能力分层白皮书
├── project.config.json    # 小程序项目配置（含 AppID）
└── .gitignore
```

---

## 四、本地开发

```bash
# 1. 用微信开发者工具打开本目录（需已配置 AppID）
# 2. 安装云函数依赖（若使用腾讯文档/云库 npm 包）
cd cloudfunctions/docsProxy && npm install && cd ../..
# 3. 配置环境变量：复制模板并填入真实值（不入库）
cp cloudfunctions/docsProxy/env.local.example.js cloudfunctions/docsProxy/env.local.js
# 4. 上传并部署云函数 docsProxy，设置云函数环境变量：
#    DATA_BACKEND=cloud
#    ROBOT_KEY=<管理员自定义串>
#    ROBOT_ACTOR_ID=T001
# 5. 为 docsProxy 创建 CloudBase HTTP 触发，获得公网地址
```

> ⚠️ `env.local.js` 与 `project.private.config.json` 已被 `.gitignore` 排除，请勿手动加入版本库。

---

## 五、WorkBuddy 集成（自然语言操作）

- **教师自连接**：每位教师在小程序「我的 → 个人机器人密钥」生成独立密钥，填进本机 WorkBuddy 的 `mcp.json`（全校共用同一 HTTP 触发地址，密钥各填各的）。详见 `docs/教师自连接操作卡.md`。
- **权限模型**：教师以本人身份操作，权限与微信端完全一致；写操作经 L1 二次确认门（先回确认码 → 确认后才写入）。
- **每日预警推送**：已配置 WorkBuddy 自动化（每日 08:20），调用 `alerts` 生成低库存/逾期巡检/待审批简报，只汇总不写。
- 部署与配置细节见 `docs/workbuddy-integration.md`。

---

## 六、测试与回归

```bash
node tools/regress-all.js          # 全量回归套件（16 套件）
node tools/test-backend-parity.js  # 三套后端 67 键契约一致性
node tools/test-route-parity.js    # 路由对齐
node tools/test-robot-write.js     # L1 写操作端到端确认流程
```

---

## 七、安全说明（公开仓库须知）

- 仓库**不含**明文密钥；`env.local.js`、个人开发者工具配置、上传私钥均已忽略。
- 微信小程序 AppID 属公开标识，保留在 `project.config.json` 中不影响安全。
- 若日后新增含密钥的文件，请主动加入 `.gitignore`，避免误提交到公开仓库。

---

## 八、相关文档

- `docs/workbuddy-integration.md` —— 集成与部署指南
- `docs/教师自连接操作卡.md` —— 教师自连图文步骤
- `docs/workbuddy-conversation-design.md` —— 对话能力分层（L0–L4）白皮书
