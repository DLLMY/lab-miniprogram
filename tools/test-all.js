// tools/test-all.js —— 只读验证 8 张表的 COL 映射是否全部正确。
const fs = require('fs')
const path = require('path')
;(function loadEnv() {
  const f = path.join(__dirname, '.env.local')
  if (!fs.existsSync(f)) return
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const k = m[1], v = m[2].replace(/^["']|["']$/g, '')
    if (process.env[k] === undefined) process.env[k] = v
  }
})()
const td = require('../cloudfunctions/docsProxy/tencentdocs.js')

const checks = [
  ['users', () => td.getRecords('users').then(r => r.map(x => x.fields))],
  ['materials', () => td.listMaterials()],
  ['tools', () => td.getRecords('tools').then(r => r.map(x => x.fields))],
  ['requisitions', () => td.getRecords('requisitions').then(r => r.map(x => x.fields))],
  ['borrow', () => td.getRecords('borrow').then(r => r.map(x => x.fields))],
  ['stock_io', () => td.getRecords('stock_io').then(r => r.map(x => x.fields))],
  ['access', () => td.getRecords('access').then(r => r.map(x => x.fields))],
  ['logs', () => td.getRecords('logs').then(r => r.map(x => x.fields))]
]
;(async () => {
  let ok = 0
  for (const [name, fn] of checks) {
    try {
      const rows = await fn()
      const first = rows[0] || {}
      const keys = Object.keys(first)
      // 检查是否有 undefined（说明某列名对不上）
      const undef = keys.filter(k => first[k] === undefined)
      console.log(`[${name}] ✅ ${rows.length} 条 | 首行字段数=${keys.length}${undef.length ? ' ⚠️ undefined列:' + undef.join(',') : ''}`)
      ok++
    } catch (e) {
      console.log(`[${name}] ❌ ${e.message}`)
    }
  }
  console.log(`\n可读表 ${ok}/8`)
})()
