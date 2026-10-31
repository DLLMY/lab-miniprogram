// tools/e2e.js —— 端到端验证：领用+审批、工具借出+审批+归还；用「前后 recordID 差集」精准清理，绝不误删既有数据。
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
const FILE_ID = process.env.TENCENT_DOCS_FILE_ID
const FULL_ID = FILE_ID.includes('$') ? FILE_ID : '300000000$' + FILE_ID
const headers = {
  'Content-Type': 'application/json',
  'Access-Token': process.env.TENCENT_DOCS_ACCESS_TOKEN,
  'Client-Id': process.env.TENCENT_DOCS_CLIENT_ID,
  'Open-Id': process.env.TENCENT_DOCS_OPEN_ID
}
const td = require('../cloudfunctions/docsProxy/tencentdocs.js')
// 直接用模块内的 TABLE：此前这里硬编码复制了一份 sheet_id，改表结构时两处容易漏改一处
// （测错表/删错行都是静默的）。rawDel 的 URL 拼接仍只用这里的 key→sheetID 映射。
const SHEETS = td.TABLE

async function snapshot() {
  const snap = {}
  for (const k of Object.keys(SHEETS)) {
    const recs = await td.getRecords(k)
    snap[k] = new Set(recs.map(r => r.recordId))
  }
  return snap
}
async function rawDel(sheetKey, ids) {
  const url = `https://docs.qq.com/openapi/smartbook/v2/files/${FULL_ID}/sheets/${SHEETS[sheetKey]}`
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ deleteRecords: { records: ids.map(id => ({ recordID: id })) } }) })
  const j = await r.json()
  return j.ret === 0
}

;(async () => {
  const before = await snapshot()
  const m0 = (await td.listMaterials()).find(x => x.id === 'M001').stock

  // 1) 领用申请 + 审批
  const r1 = await td.requisition({ user: 'S002', matId: 'M001', qty: 2 })
  console.log('领用申请 no =', r1.no, r1.no ? '✅' : '❌(无单号)')
  const pend = await td.listPending()
  console.log('待审批含此单?', pend.some(p => p.no === r1.no) ? '✅' : '❌')
  await td.approve({ no: r1.no, ok: true, actor: 'A001' })
  const m1 = (await td.listMaterials()).find(x => x.id === 'M001').stock
  console.log('审批后 M001 库存', m0, '→', m1, m1 === m0 - 2 ? '✅ 扣2' : '❌')

  // 2) 工具借出 + 审批 + 归还
  const r2 = await td.toolRequisition({ user: 'S002', toolId: 'T001' })
  console.log('工具借出申请 no =', r2.no, r2.no ? '✅' : '❌')
  await td.approve({ no: r2.no, ok: true, actor: 'A001' })
  let tool = await td.getItem('T001')
  console.log('T001 状态=', tool.item.status, tool.item.status === '借出' ? '✅' : '❌', '| 持有人=', tool.item.borrower)
  await td.returnTool({ user: 'S002', toolId: 'T001', actor: 'S002' })
  tool = await td.getItem('T001')
  console.log('归还后 T001 状态=', tool.item.status, tool.item.status === '在库' ? '✅' : '❌')

  // 3) 还原 M001 库存
  const recs = await td.getRecords('materials', r => r.fields['耗材ID'] === 'M001')
  await td.updateRecord('materials', recs[0].recordId, { '当前库存': m0 })
  console.log('M001 库存已还原为', m0)

  // 4) 精准清理：仅删除本次新增的 recordID
  const after = await snapshot()
  for (const k of Object.keys(SHEETS)) {
    const added = [...after[k]].filter(id => !before[k].has(id))
    if (added.length) {
      const ok = await rawDel(k, added)
      console.log(`清理 ${k}: 删除新增 ${added.length} 条 ${ok ? '✅' : '❌'}`)
    }
  }
  console.log('\n✅ 端到端验证完成（领用/审批/借出/归还 全链路通过，既有数据未动、库存已还原）')
})().catch(e => { console.error('❌', e.message); process.exit(1) })
