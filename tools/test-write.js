// tools/test-write.js —— 可逆写入测试：M001 库存 +1 再 -1，验证写路径。
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
  const mats = await td.listMaterials()
  const m = mats.find(x => x.id === 'M001')
  if (!m) { console.log('❌ 找不到 M001'); process.exit(1) }
  const before = m.stock
  console.log('M001 当前库存 =', before)

  await td.io({ matId: 'M001', type: 'in', qty: 1, actor: '连通测试' })
  const afterIn = (await td.listMaterials()).find(x => x.id === 'M001').stock
  console.log('入库 +1 后 =', afterIn, afterIn === before + 1 ? '✅' : '❌')

  await td.io({ matId: 'M001', type: 'out', qty: 1, actor: '连通测试' })
  const afterOut = (await td.listMaterials()).find(x => x.id === 'M001').stock
  console.log('出库 -1 后 =', afterOut, afterOut === before ? '✅ 已还原' : '❌ 未还原')

  if (afterOut === before) console.log('\n✅ 写路径通过：updateRecord + addRecord(单选/数字) 均正常，库存已还原。')
  else console.log('\n⚠️ 库存未还原，请检查。')
  console.log('（stock_io / logs 各多了 2 条 actor=连通测试 的测试流水，可在腾讯文档中删除）')
})().catch(e => { console.error('❌ 写入失败：', e.message); process.exit(1) })
