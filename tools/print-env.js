// tools/print-env.js
// 把 tools/.env.local 里的腾讯文档凭证，转成「云函数 docsProxy 环境变量」可直接照抄的 5 组键值。
//
// 用法：
//   node tools/print-env.js          # 打印完整值（在你本机终端里复制粘贴用）
//   node tools/print-env.js --mask   # 打码显示（截图/共享屏幕时用）
//
// 说明：这些值的来源
//   TENCENT_DOCS_FILE_ID      → 腾讯文档《实训室管理系统数据底座》的 API file_id（不是浏览器网址里那段）
//   TENCENT_DOCS_CLIENT_ID    → 腾讯文档开放平台控制台「开发者信息」的 client_id
//   TENCENT_DOCS_ACCESS_TOKEN → 同上「开发者信息」的 access_token（30 天有效，JWT 里带 exp）
//   TENCENT_DOCS_OPEN_ID      → 同上「开发者信息」的 open_id
//   USE_MOCK                  → 本项目自己的开关，固定写 false 即走真实腾讯文档（与平台无关）

const fs = require('fs')
const path = require('path')

const MASK = process.argv.includes('--mask')

;(function loadEnv() {
  const f = path.join(__dirname, '.env.local')
  if (!fs.existsSync(f)) {
    console.error('❌ 找不到 tools/.env.local，请先按 .env.local.example 填好 4 项凭证。')
    process.exit(1)
  }
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
})()

function mask(v) {
  if (!v) return '(空)'
  if (v.length <= 10) return v.slice(0, 3) + '****' + v.slice(-3) + `  （长度 ${v.length}）`
  return v.slice(0, 6) + '****' + v.slice(-6) + `  （长度 ${v.length}）`
}

// 解析 JWT 的 exp（access_token 是 JWT，末段 base64 里有 exp 秒级时间戳）
function jwtExp(token) {
  try {
    const parts = String(token).split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
    return payload.exp ? payload.exp * 1000 : null
  } catch (e) {
    return null
  }
}

const E = process.env
const pairs = [
  ['TENCENT_DOCS_FILE_ID', E.TENCENT_DOCS_FILE_ID, '《数据底座》API file_id（固定值）'],
  ['TENCENT_DOCS_CLIENT_ID', E.TENCENT_DOCS_CLIENT_ID, '开放平台控制台「开发者信息」'],
  ['TENCENT_DOCS_ACCESS_TOKEN', E.TENCENT_DOCS_ACCESS_TOKEN, '同上，30 天有效'],
  ['TENCENT_DOCS_OPEN_ID', E.TENCENT_DOCS_OPEN_ID, '同上'],
  ['USE_MOCK', 'false', '本项目开关，false = 走真实腾讯文档；true = 演示模式；不设 = 自动'],
  ['DATA_BACKEND', 'tencent', '真实后端选择：tencent(腾讯文档) | cloud(微信云数据库)'],
  ['FALLBACK', 'on', '自动回退总开关：off = 关闭(调试)；on = 主后端异常时自动切下一个后端']
]

console.log('=== 云函数 docsProxy · 环境变量（共 5 组，逐条「新增」粘贴）===\n')
let miss = 0
for (const [k, v, note] of pairs) {
  if (!v) { miss++; console.log(`⚠️ ${k} = (缺失！)`); continue }
  console.log(`${k}\n  值：${MASK ? mask(v) : v}\n  来源：${note}\n`)
}

const exp = jwtExp(E.TENCENT_DOCS_ACCESS_TOKEN || '')
if (exp) {
  const d = new Date(exp)
  const days = Math.floor((exp - Date.now()) / 86400000)
  const pad = (n) => String(n).padStart(2, '0')
  const s = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  if (exp < Date.now()) {
    console.log(`🔴 access_token 已于 ${s} 过期 → 去开放平台「开发者信息」点「重置」，拿新 token 更新后重新部署云函数。`)
  } else {
    console.log(`🟢 access_token 有效期至 ${s}（还剩 ${days} 天）→ 到期前重置并更新环境变量。`)
  }
} else {
  console.log('ℹ️ 未能从 access_token 解析出到期时间（可能不是 JWT 格式），按 30 天估算即可。')
}

if (miss) {
  console.log(`\n❌ 有 ${miss} 项缺失，补齐后再用。`)
  process.exit(1)
}
console.log('\n（当前为打码模式；要复制完整值请运行：node tools/print-env.js）')
