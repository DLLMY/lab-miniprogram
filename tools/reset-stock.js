// tools/reset-stock.js —— 把 M001 库存重置为 320（清理测试残留）。
//
// ⚠️ 会直接改真实 materials 表。默认只预览当前值，加 --yes 才写入：
//    node tools/reset-stock.js          # 预览：显示 M001 当前库存与将要改成的值
//    node tools/reset-stock.js --yes    # 确认写入
const fs = require('fs')
const path = require('path')
const YES = process.argv.includes('--yes')
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
  const TARGET = 320
  // 列名一律走 td.COL（与生产代码同一来源），不手抄中文列名
  const recs = await td.getRecords('materials', r => r.fields[td.COL.materials.id] === 'M001')
  if (!recs[0]) { console.error('❌ 找不到 M001'); process.exit(1) }
  const cur = (await td.listMaterials()).find(x => x.id === 'M001')
  console.log('M001 当前库存 =', cur ? cur.stock : '(读取失败)', '，目标值 =', TARGET)
  if (!YES) {
    console.log('（预览模式，未写入）确认执行：node tools/reset-stock.js --yes')
    return
  }
  await td.updateRecord('materials', recs[0].recordId, { [td.COL.materials.stock]: TARGET })
  const m = (await td.listMaterials()).find(x => x.id === 'M001')
  console.log('M001 库存已重置为', m.stock, m.stock === TARGET ? '✅' : '❌ 未生效，请检查')
})().catch(e => { console.error('reset fail', e.message); process.exit(1) })
