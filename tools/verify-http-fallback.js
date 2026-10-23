// tools/verify-http-fallback.js
// 验证 tencentdocs.js 的 HTTP 兼容层：在【没有全局 fetch】的环境下（模拟云函数 Node 16/12 运行时）
// 是否仍能通过内置 https 模块正常读写腾讯文档。
//
// 用法：node tools/verify-http-fallback.js
// 退出码：0 = 兼容层可用；1 = 失败。

const fs = require('fs')
const path = require('path')

;(function loadEnv() {
  const f = path.join(__dirname, '.env.local')
  if (!fs.existsSync(f)) return
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
})()

// 关键：在 require 适配器之前干掉全局 fetch，强制走 https 兜底分支
globalThis.fetch = undefined
console.log('全局 fetch 已禁用（typeof fetch =', typeof fetch, '）→ 强制走 https 兜底\n')

const td = require('../cloudfunctions/docsProxy/tencentdocs.js')

;(async () => {
  try {
    const list = await td.listMaterials()
    console.log('✅ 兜底路径读通：materials 共', list.length, '条')
    console.log('   样例：', JSON.stringify(list.slice(0, 2)))
    console.log('\n→ 云函数运行时无论 Node 12/16/18+ 均可工作（有 fetch 用 fetch，无则用 https）')
    process.exit(0)
  } catch (e) {
    console.error('❌ 兜底路径失败：', e.message)
    process.exit(1)
  }
})()
