// tools/reset-stock.js —— 把 M001 库存重置为 320（清理测试残留）。
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
;(async () => {
  const recs = await td.getRecords('materials', r => r.fields['耗材ID'] === 'M001')
  await td.updateRecord('materials', recs[0].recordId, { '当前库存': 320 })
  const m = (await td.listMaterials()).find(x => x.id === 'M001')
  console.log('M001 库存已重置为', m.stock)
})().catch(e => { console.error('reset fail', e.message); process.exit(1) })
