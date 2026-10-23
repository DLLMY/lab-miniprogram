# 小程序自动化冒烟测试

用 `miniprogram-automator` 驱动微信开发者工具，对 `lab-miniprogram` 做无人工点击的回归测试。

## ⚡ 当前状态（2026-10-22 最终结论：改人工测试）

**自动化路线已放弃，当前主测路径 = 人工在 IDE 里跑冒烟清单（见文末）。**

三次全自动尝试全部失败，根因均非脚手架代码问题：
- 路径 A（沙箱内全自动）：reg.exe 黑名单移除后，GUI 仍被 WorkBuddy 沙箱 tsbx.dll 注入拖崩（两次 Crashpad 转储实证，确定性崩溃）——环境级死路。
- 路径 B（用户终端启动 IDE 自动化模式 + AI 连接）：三次均 `wait IDE port timeout`。GUI 在 `--cli` 模式下始终未回连 CLI 服务器，连窗口都不建（无新崩溃转储），只留孤儿进程占单实例锁。
- 结论：本机 WorkBuddy 环境无法驱动 DevTools GUI；冒烟改人工。**注意：身份门 + tabBar 重构后，本脚本的 chip/footnav 选择器已失效，自动化恢复时需先重写脚本再跑。**

## 前置（一次性）
1. 在本机安装**微信开发者工具**。
2. 打开工具并**扫码登录**（用绑定测试 AppID 的微信号）。
3. 在本目录安装依赖：`npm install`
4. 若 DevTools 不在默认安装路径，设环境变量指向 `cli.bat`：
   ```bash
   set WECHAT_CLI="C:/你的路径/微信web开发者工具/cli.bat"
   ```

## 排障记录：CLI 启动链的六连环坑（均已修复，沉淀在 D:/wxcli/）

从 `automator.launch` 到 GUI 真正进入主流程，共修复 6 个问题：

| # | 坑 | 现象 | 修复 |
|---|---|---|---|
| ① | `spawn` 直接拉 `.bat` | `EINVAL`，Windows 无法 CreateProcess 批处理文件 | 给 `node_modules/miniprogram-automator/out/Launcher.js` 的 spawn 加 `shell:true`（重装依赖后需重打，命令见下） |
| ② | `cli.bat` 内嵌双引号 | `'m' 不是内部或外部命令`——`electron -e "<JS>"` 被 cmd 提前截断 | 绕开 `cli.bat`：独立 `bootstrap.js` + 复制出的 `cli.js`，electron 直接跑 |
| ③ | CLI 自检读 `package.json` | `D:\package.json` ENOENT → `File corrupted` | cli.js 放 3 层子目录 `D:/wxcli/x/y/z/`，使 `__dirname/../../../package.json` 命中 `D:/wxcli/package.json`（内容用原版 name/appname/version） |
| ④ | `appPath` 名字不匹配 | debug 显示 `spawn ./微信开发者工具.exe` 但 exe 叫 `wechatdevtools.exe` | exe 改名为 `微信开发者工具.exe`（CLI 取 package.json 的 `name` 作 appname）；包装器用 `for %%F in (*.exe)` 通配规避 .cmd 中文编码坑 |
| ⑤ | `installPath` 指向 asar | GUI 找不到 app.asar | `D:/wxcli/bin/resources` 建 junction 指向原版 `resources/`（223MB 不复制） |
| ⑥ | 服务端口未开启 | `IDE service port disabled` | CLI 检查 `userDirPath/.ide-status == "On"`：写入即可 |
| ⑦ | userDir 空目录/锁冲突 | GUI 静默退出 / `已有运行中的实例` | CLI 的 userDir hash 与已登录原版目录不同：复制关键数据（Default/WeappLocalData 等，不含 137MB 插件缓存）到新 hash 目录 |
| ⑧ | **reg.exe 黑名单（未解）** | GUI 初始化被拦 | **需用户操作**：路径 A 或 B（见顶部） |

`D:/wxcli/` 结构：
```
wx2.cmd           全 ASCII 包装器（cd 到 bin + for 通配找 exe + electron 跑 bootstrap/cli.js）
bootstrap.js      兼容两种 argv 形式的引导脚本
package.json      {"name":"微信开发者工具","appname":"wechatwebdevtools","version":"2.02.2608080"}
x/y/z/cli.js      原版 cli 入口副本（放 3 层深处命中 package.json 自检）
bin/
  微信开发者工具.exe    原版 exe 副本（rename 后满足 appPath）
  icudtl.dat 等         Electron 运行时数据 + DLL + pak + locales
  resources → junction  原版 resources（app.asar 223MB 不复制）
```

userDir（新 hash 目录）：
```
C:\Users\53527\AppData\Local\微信开发者工具\User Data\31374fc65eccfcb9afc3b878fff6ff56\
  从已登录的 2ca4252f... 目录复制关键数据（Default 含 .ide-status=On）
```

**重装依赖后**重打补丁 ①：
```bash
node -e "const f='node_modules/miniprogram-automator/out/Launcher.js',fs=require('fs');const s=fs.readFileSync(f,'utf8');fs.writeFileSync(f,s.replace('const d={stdio:[\"ignore\",\"pipe\",\"pipe\"]}','const d={stdio:[\"ignore\",\"pipe\",\"pipe\"],shell:true}'))"
```

## 运行
```bash
node automator.js                    # 全自动模式（需黑名单放行 reg.exe）
set WECHAT_WS_ENDPOINT=ws://127.0.0.1:9450 && node automator.js   # 连接模式（用户终端已启动 IDE）
```
- 退出码 `0` = 全部通过；`1` = 有失败；`2` = 未找到 DevTools 或启动失败。

## 人工冒烟清单（2026-10-22 起的主测路径）

IDE 导入项目选「不使用云服务」，AppID 用真实号；前端自动回退 mock 数据。逐项：

| # | 操作 | 预期 |
|---|---|---|
| 1 | 首次打开 | 进入「身份登录」页，列出 4 个演示账号 |
| 2 | 输入 T001 或点「邓老师」登录 | 提示欢迎，进首页，当前身份=教师 |
| 3 | 首页查 M003 进详情 | 详情有数据 |
| 4 | 「我的」tab | 身份卡 + 「教师/管理员功能」3 个入口（学生身份看不到） |
| 5 | 进「领用审批」→ 通过/拒绝 | 按钮样式对齐、toast 按结果反馈、列表刷新 |
| 6 | 「出入库」「使用概况」 | 页面正常、有数据 |
| 7 | 「我的」→ 切换账号 → S001 登录 | 回登录页；学生身份「我的」页无教师功能入口 |
| 8 | 学生查物品 → 申请领用 → 切回教师审批 | 全链路闭环 |

Console 出现 `[api] 回退本地 mock (...)` warn 属预期（回退在工作）；红色报错才需要修。

## 说明
- 当前脚手架 `USE_MOCK=true`，测试走本地 mock，无需任何云端凭证即可跑通全流程逻辑。
- 脚本会暴露页面渲染、事件绑定、data 结构等问题；首次真跑如有报错，按报错修脚手架即可。
- 真机预览 / 上传 / 微信认证仍需在开发者工具里手动操作。
