# 参与贡献 / 开发规范

本仓库为万州职教中心实训室管理系统的源码与文档。以下约定用于保持多后端一致性、权限安全与可回归质量。

## 一、开发环境

- 微信开发者工具（导入本目录，需配置 AppID）
- Node.js ≥ 16（云函数与本地测试脚本运行环境）
- 本地环境变量：`cp cloudfunctions/docsProxy/env.local.example.js cloudfunctions/docsProxy/env.local.js` 后填真实值（`env.local.js` 已被 gitignore，**禁止提交**）

## 二、核心铁律

1. **三后端同构（67 键契约）**：`clouddb.js`（云数据库）、`tencentdocs.js`（腾讯文档）、`utils/mock.js`（前端离线回退）必须导出完全一致的 67 个业务函数。新增/修改任一业务函数须三处同步，由 `tools/test-backend-parity.js` 守护。
2. **权限在云端推导**：所有写操作与敏感读操作以云函数推导的真实身份（`openid → 工号` 或 robot 通道个人密钥反查）为准，前端传入的 `role`/`user` 一律不信任（防越权/IDOR）。
3. **测试先行、零回归**：改动后必须跑 `node tools/regress-all.js`（16 套件全绿）方可提交。高风险重构宁可跳过不强推。
4. **不自动提交**：本仓库约定不自动 `commit`/`push`，由维护者确认后手动提交。

## 三、机器人通道（WorkBuddy）规范

- 个人密钥：教师通过小程序「我的 → 个人机器人密钥」生成，云函数按密钥哈希反查工号，以本人身份执行；**管理员 `ROBOT_KEY` 仅作应急超级通道，绝不外发**。
- 写操作二次确认（L1）：经 robot 通道的写动作先返回操作摘要 + 确认令牌，不真正执行；确认后携令牌二次调用才写入，令牌绑定「动作 + 参数 + 身份」，篡改即失效。
- 连接器白名单：`mcp/docs-proxy-server.js` 的 `READ_ACTIONS` / `WRITE_ACTIONS` 为 fail-closed 白名单，开放新能力须显式加入并补回归测试。

## 四、提交信息

- 遵循 `type: 简述` 风格（如 `feat:` / `fix:` / `chore:` / `docs:`）。
- 涉及多模块时，在正文用 `-` 分条列举变更点。

## 五、安全须知（公开仓库）

- 禁止向仓库提交任何明文密钥：`env.local.js`、个人开发者工具配置 `project.private.config.json`、上传私钥 `private.*.key` 均已被 `.gitignore` 排除。
- 新增含密钥的文件须主动加入 `.gitignore`。
- 微信小程序 AppID 属公开标识，保留在 `project.config.json` 不影响安全。
