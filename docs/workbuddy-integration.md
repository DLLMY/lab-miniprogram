# 实训室管理系统 × WorkBuddy 自然语言操作（集成指南）

> 目标：每位老师都能**用自己的 WorkBuddy**，用自然语言查询与处理「万州职教中心·实训室管理系统」的数据，
> 例如「查一下 A 柜有哪些物料」「列出我名下待处理报修」「帮我提交一个实训室报修」。
> 每位老师以**自己的教师身份**接入，权限与其微信端完全一致。

---

## 一、架构

```
老师说："查一下电阻类物料"
   ↓ WorkBuddy 自然语言解析 → 选定工具 lab_query(action=listMaterials, params={keyword:"电阻"})
   ↓ 本地 MCP 连接器 (mcp/docs-proxy-server.js)
   ↓ POST JSON {action, params, robotKey=该老师的个人密钥} 到 CloudBase HTTP 触发地址
docsProxy 云函数（robot 模式）
   → 把 robotKey 哈希后，按 users.robotKeyHash 反查该老师工号 → 以该老师本人身份执行（gStaff 闸门）
   ↓ 走现有 clouddb 适配器（已切到云库）
CloudBase 集合读取 → 返回 {code:0, data}
   ↓ 回显给 WorkBuddy
老师看到格式化后的物料清单
```

- **写操作（L1 二次确认门）**：经 robot 通道的写动作（报修/审批/出入库…）首次调用只返回「操作摘要 + 确认码」，**不真正执行**；
  老师确认后调用 `lab_confirm` 携确认码二次调用才写入，防误改。
- 业务逻辑（审批写流水、逾期计算、借还、冲销…）**全部留在云端 `clouddb/tencentdocs` 适配器**，自然语言层只负责「选对 action + 填对参数」。
- 连接器**不持有任何业务密钥**，只持有一个 `robotKey`（该老师的个人机器人密钥）。

---

## 二、身份模型（两种 robotKey）

| 类型 | 来源 | 身份 | 用途 |
|---|---|---|---|
| **教师个人密钥** | 小程序「我的 → 个人机器人密钥」生成 | 该教师本人（按工号反查） | 教师自连接 WorkBuddy（主用） |
| **全局超级钥匙** | 云函数环境变量 `ROBOT_KEY` 的值 | `ROBOT_ACTOR_ID`（默认 T001/super） | 仅管理员应急，不发教师 |

- 教师个人密钥：服务端存 **SHA-256 加盐哈希**，明文仅生成时展示一次；可随时在「我的」页**重置 / 吊销**。
- 任何人拿到的 robotKey 若不匹配 `ROBOT_KEY` 也匹配不到任何 `robotKeyHash`，通道 fail-closed 拒绝。

---

## 三、上线步骤

### A. 管理员一次性部署（只需做一次）

1. **云函数控制台设环境变量**（权威来源，盖过 `env.local.js`）：
   - `DATA_BACKEND` = `cloud`
   - `ROBOT_KEY` = 管理员自定义的随机串（如 `rbt_8f3a...`），仅作**应急超级通道**，不要发给教师
   - `ROBOT_ACTOR_ID` = `T001`
   - 保存后**重新上传并部署 `docsProxy`**（环境变量冷启动才重读）。
2. **建 CloudBase HTTP 触发**：`docsProxy` → 触发管理 → 新建 HTTP 触发，路径 `/labproxy`，得到形如 `https://xxx.apigw.tencentcs.com/release/labproxy` 的地址。
3. **管理员自己的 WorkBuddy 配置 mcp.json**（见下「教师自连接 4 步」，密钥用全局超级钥匙或自己的个人密钥均可）。

> ⚠️ 部署前必须：① 重新上传干净版 `docsProxy`（旧版含明文 token）；② 重置腾讯文档 ACCESS_TOKEN（曾随代码暴露）。详见文末第七节。

### B. 教师自连接（每位老师自己完成，4 步）

> 前提：管理员已完成 A 步（云函数已部署、HTTP 触发已建）。每位老师独立操作，互不影响。

1. **小程序生成个人密钥**：打开实训室小程序 →「我的」→「个人机器人密钥」→ 点「生成我的密钥」。
   系统生成一把**只属于你工号**的密钥，明文**仅显示这一次**，请立即复制保存。
2. **本机装 WorkBuddy + Node**（≥16，建议 18+）。
3. **配置连接器**：在本机 WorkBuddy 的 `mcp.json` 加入：
   ```json
   {
     "mcpServers": {
       "lab-docs-proxy": {
         "command": "node",
         "args": ["D:/万州职教中心/lab-miniprogram/mcp/docs-proxy-server.js"],
         "env": {
           "DOCS_PROXY_HTTP_URL": "https://xxx.apigw.tencentcs.com/release/labproxy",
           "DOCS_PROXY_ROBOT_KEY": "<第 1 步生成的【个人密钥】>"
         }
       }
     }
   }
   ```
4. **信任启用**：WorkBuddy 左侧连接器 → 找到 `lab-docs-proxy` → 点「信任」启用。重启对话/重连 MCP 后即可用自然语言操作。

> 全校共用同一个 `DOCS_PROXY_HTTP_URL`（管理员给）；`DOCS_PROXY_ROBOT_KEY` 每位老师填**自己的**个人密钥。

---

## 四、能力范围与验证

**只读（直接执行）**：`lab_query` 支持 `getItem / listMaterials / listTools / pending / usage / listLabs / listRepairs / listInspections / alerts`；另有 `lab_diag`（运行态）、`lab_overview`（按实训室汇总）、`lab_context`（读会话记忆）、`lab_forget`（清会话记忆）。
- `alerts`（预警聚合）：一次返回 `lowStock`（低于预警线物料）、`overdueInspections`（逾期巡检）、`pendingApprovals`（待审批领用）三项，供每日推送使用，避免逐表查询。

**写操作（L1 确认门）**：`lab_write` 支持 `requisition / toolRequisition / cancelReq / io / borrow / returnTool / approve / addMaterial / stocktake / addRepair / updateRepair / addInspection / updateInspection`。
- 首次调用返回：`⚠ 需确认：<操作摘要> [确认码 Cxxx] 请回复「确认执行」或调用 lab_confirm 完成。`
- 老师确认后，WorkBuddy 调用 `lab_confirm`（可带确认码指定某条）才真正写入。
- 管理员专属动作（`addLab/updateLab/deleteLab/adminUpsertUser/adminDeleteUser/reverseIO/migrate`）**不开放**给通用连接器，仍走微信端或 `ROBOT_KEY` 超级应急通道。

**验证**：
1. 问「显示系统运行态」→ `lab_diag` 回 `backend=cloud`、物料条数。
2. 问「列出所有物料」→ `lab_query(listMaterials)` 回清单。
3. 问「帮我提交 L001 实训室示波器故障报修」→ `lab_write(addRepair)` 回确认码 → 说「确认执行」→ `lab_confirm` 回写入结果。
4. 返回 `code=401/403`：确认个人密钥正确且对应教师账号存在、状态为启用。

---

## 四-B、L2 主动服务：每日预警推送（已上线自动化）

通过 WorkBuddy 自动化（连接器 `lab-docs-proxy` 需在本机已配置并信任启用）实现「不等人来问、主动推送」：

- **自动化名称**：`实训室每日预警推送`（recurring，`FREQ=DAILY;BYHOUR=8;BYMINUTE=20`）。
- **执行逻辑**：每天 08:20 自动调用 `lab_query(action=alerts)` → 拉取低库存 / 逾期巡检 / 待审批 → 生成中文每日预警简报（分点 + 数量 + 建议）；三项皆空则回「今日无预警 ✅」。
- **只读不写**：自动化 prompt 硬性约束「绝不调用 lab_write / lab_confirm」，只汇总提醒。
- **身份选择**：
  - **全校视角的每日简报**：`mcp.json` 的 `DOCS_PROXY_ROBOT_KEY` 用管理员**全局超级钥匙**（`ROBOT_KEY` 环境变量值），可读取全部实训室数据。
  - **教师个人视角**：用该教师**个人密钥**，仅看自己权限范围内的预警。
- 若连接器未配置/调用失败，自动化会明确提示检查 `DOCS_PROXY_HTTP_URL` / `DOCS_PROXY_ROBOT_KEY`。

> 该自动化已创建（workspace 作用域，cwds=`D:/万州职教中心`）。首次生效需确保本机 `mcp.json` 已填好真实 `HTTP_URL` 与个人/管理员密钥。

## 四-C、远期路线（L3 / L4）

| 阶段 | 能力 | 关键改动 | 状态 |
|---|---|---|---|
| **L3 主动服务扩展** | 推送从「全量预警」细分为「按实训室 / 按负责人」订阅；逾期前 N 天提醒；审批超时升级提醒 | 后端 `alerts` 增加 `labId` / `owner` 维度过滤；自动化按订阅路由 | 规划中 |
| **L4 语音输入** | 教师用语音说「查一下 A 柜电阻够不够」→ 自动转写并走同一 `lab_query`/`lab_write` 链路 | 复用 WorkBuddy 语音输入 + 现有连接器，无需改后端 | ✅ 已可用（WorkBuddy 自带语音，无需改代码） |
| **L4 多轮记忆编排** | 跨轮次记住「我正在处理 L001 那张报修」「上次查的是电阻类」，无需重复上下文 | 连接器侧维护会话上下文（`lab_context`/`lab_forget`），仅缓存锚点实体 id/名称，绝不缓存密钥/明文 | ✅ 已实现 |

> 多轮记忆的安全原则：记忆仅缓存「最近操作的单据号 / 过滤条件 / 实训室 ID」等**非敏感上下文**，绝不缓存密钥或个人明文；调用 `lab_forget` 可随时清空，进程重启即清空。

---

## 五、安全边界

- **个人密钥哈希存储**：服务端只存 `SHA-256(pepper + 密钥)`，DB 泄露也无法反推明文；明文仅生成时展示一次。
- **可独立吊销**：教师在「我的」页吊销后，任何 WorkBuddy 连接立即失效，需重新生成。
- **fail-closed**：`ROBOT_KEY` 未配置 → 外部 HTTP 调用只能走公开接口；robotKey 匹配不到任何 `robotKeyHash` → 拒绝。
- **权限同微信端**：个人密钥反查出的教师身份跑 `prodHandler`，走 `gStaff` 闸门、`data.actor=工号`，动不了别人的、也动不了管理员功能。
- **绝不共享超级钥匙**：`ROBOT_KEY`（全局超级钥匙）只留给管理员应急，绝不分发教师；教师一律用个人密钥。
- **密钥管理仅限微信登录态**：`genRobotKey/revokeRobotKey` 通过 robot 通道被显式禁止，防密钥被远程改写。
- **写操作二次确认**：所有经 robot 通道的写动作需 `lab_confirm` 携令牌二次调用；令牌绑定 动作+参数+身份，篡改即失效。

---

## 六、已完成的代码改动（仓库内）

| 文件 | 改动 |
|---|---|
| `clouddb.js` / `tencentdocs.js` | `users` 增加 `robotKeyHash` 字段；新增 `findUserByRobotKey(hash)`（按哈希反查教师）、`setRobotKey(id, hash)`（写入/清空）；导出纳入 67→69 键契约 |
| `index.js` | robot 通道由「全局工号」升级为「哈希反查教师身份」；新增 `genRobotKey / revokeRobotKey / robotKeyStatus` 动作（仅微信登录态可调用）；新增 L1 写操作确认门（令牌绑定动作+参数+身份）；`ROBOT_KEY` 保留为管理员应急超级通道；新增只读 `alerts` 动作（低库存+逾期巡检+待审批聚合，供每日推送）；修复 `usage` 趋势月份桶在月末日（如 31 号）因 `setUTCMonth` 跨 30 天月溢出导致**重复计月、趋势翻倍**的 bug（已对齐 `tencentdocs` 的 `setUTCDate(1)` 写法） |
| `utils/mock.js` | 离线模式对三个密钥动作返回友好提示（离线不支持密钥管理）；新增 `alerts` 离线同构实现 |
| `pages/mine/*` | 「我的」页新增「个人机器人密钥」卡片：生成/重置/吊销 + 明文仅显一次 + 复制 |
| `mcp/docs-proxy-server.js` | 新增 `lab_write`（写白名单 + L1 确认）、`lab_confirm`（携令牌二次执行）；`READ_ACTIONS` 增加 `alerts` / `lab_context` / `lab_forget`；`WRITE_ACTIONS` 增加 `addMaterial` / `stocktake`；Phase 4 多轮会话记忆编排（锚点实体缓存，隐私红线） |
| `tools/test-robot-write.js` | 新增：驱动真实连接器走完 L1 写确认全流程（13 个写动作首调仅确认、确认后写入；读操作直达；非白名单被拒；令牌篡改 403），30 断言 |
| `~/.workbuddy/mcp.json` | MCP 服务注册（占位环境变量，待填 HTTP_URL + 个人密钥） |

---

## 七、凭证安全整改（2026-10-30，已落地）

`env.local.js` 曾含腾讯文档明文 `ACCESS_TOKEN` / `OPEN_ID`，会随「上传并部署」进入云端函数代码，构成泄露面。

**已修复（仓库内）**：`env.local.js` 清空全部敏感值，仅留非敏感配置；`check-pack-ignore.js` 复跑 → 部署包内无明文凭证；`regress-all` 16/16；`test-backend-parity` 69 键齐备。

**必须手动执行（控制台侧）**：
1. 重新上传并部署干净版 `docsProxy`（旧版仍含旧 token）。
2. 腾讯文档开放平台「重置」ACCESS_TOKEN 使其作废（当前生产走云库 `DATA_BACKEND=cloud`，不受影响）。
3. 若需腾讯文档回退，新 `TENCENT_DOCS_*` 四项只放控制台环境变量，不写回 `env.local.js`。

---

## 八、相关文档

- **教师自连接图文操作卡**：`docs/教师自连接操作卡.md` —— 普通教师 4 步自己连 WorkBuddy（生成个人密钥 → 装 Node → 配 mcp.json → 信任启用），含 mcp.json 模板、示例对话、FAQ。
- **对话设计白皮书**：`docs/workbuddy-conversation-design.md` —— L0–L4 能力分层、四条铁律、多轮编排远期路线。
