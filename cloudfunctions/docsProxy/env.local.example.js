// 复制本文件为 env.local.js（与本文件同目录），填入真实腾讯文档凭证后，
// 即可在本机命令行运行 tools/add-users.js / 各类诊断脚本直连真实智能表格。
//
// 凭证来源：腾讯文档开放平台 → 首页 → 开发者信息（四项）。
// env.local.js 含密钥，请勿提交/外传（建议在 .gitignore 中忽略）。
// 它仅「补」process.env 中缺失的键，不会覆盖云函数控制台已配置的值。
module.exports = {
  TENCENT_DOCS_FILE_ID: 'DDJvsIIuHZKh',
  TENCENT_DOCS_CLIENT_ID: 'd1762befa5524a16a7d102ff8e166df6',
  TENCENT_DOCS_ACCESS_TOKEN: '', // 30 天有效；在开放平台「重置」后更新此处
  TENCENT_DOCS_OPEN_ID: ''
}
