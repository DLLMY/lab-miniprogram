// 复制本文件为 env.local.js（与本文件同目录），填入真实腾讯文档凭证后，
// 即可在本机命令行运行 tools/add-users.js / 各类诊断脚本直连真实智能表格。
//
// 凭证来源：腾讯文档开放平台 → 首页 → 开发者信息（四项）。
// env.local.js 含密钥，请勿提交/外传（建议在 .gitignore 中忽略）。
// 它仅「补」process.env 中缺失的键，不会覆盖云函数控制台已配置的值。
module.exports = {
  TENCENT_DOCS_FILE_ID: '', // 腾讯文档开放平台 → 开发者信息（空值=不启用腾讯文档后端）
  TENCENT_DOCS_CLIENT_ID: '',
  TENCENT_DOCS_ACCESS_TOKEN: '', // 30 天有效；在开放平台「重置」后以控制台环境变量注入为准
  TENCENT_DOCS_OPEN_ID: '',
  // —— 冗余开关（见 backend-switch.js / docs/数据层冗余开关设计.md）——
  // USE_MOCK: 'true' 强制演示模式(mock)；'false' 强制真实后端且关闭自动回退；不设=自动模式
  // DATA_BACKEND: 'tencent'(默认,腾讯文档) | 'cloud'(微信云数据库) —— 真实后端选择
  // FALLBACK: 'off' 关闭自动回退(调试)，其余/不设=主后端异常时自动切下一个后端，避免崩溃
  USE_MOCK: '',
  DATA_BACKEND: 'tencent',
  FALLBACK: 'on',

  // —— 可信机器通道（WorkBuddy / 外部 HTTP 自然语言操作，见 docs/workbuddy-integration.md）——
  // 仅在「外部 HTTP 调用(openid 为空) 且 请求体 robotKey 命中本值」时启用，以 ROBOT_ACTOR_ID 身份执行。
  // 微信端调用走 openid，互不影响；本值留空则通道关闭（fail-closed，外部调用只能走公开接口）。
  // 注意：云函数控制台的「环境变量」会覆盖此处；正式上线请直接改控制台环境变量。
  ROBOT_KEY: '',
  ROBOT_ACTOR_ID: 'T001' // 默认超级管理员，首批仅开放只读查询
}
