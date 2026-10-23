// tools/diag4.js —— 验证文本列正确写入格式（需带 type:'text' 才能存住）
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
const SID = 'tAgqo0' // stock_io
async function addAndRead(label, values) {
  const url = `https://docs.qq.com/openapi/smartbook/v2/files/${FULL_ID}/sheets/${SID}`
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ addRecords: { records: [{ values }] } }) })
  const j = await r.json()
  if (j.ret !== 0) { console.log(`[${label}] addRecords ret=${j.ret} ${j.msg}`); return }
  const rid = j.data.addRecords.records[0].recordID
  // 读回：翻页找该 recordID（避免 limit 1 不含最新）
  let rec = null
  for (let off = 0; off < 200 && !rec; off += 100) {
    const r2 = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ getRecords: { offset: off, limit: 100 } }) })
    const j2 = await r2.json()
    rec = (j2.data.getRecords.records || []).find(x => x.recordID === rid)
    if (!j2.data.getRecords.hasMore) break
  }
  console.log(`[${label}] 写入后读出 物品ID=`, JSON.stringify(rec ? rec.values['物品ID'] : null))
  // 清理
  const r3 = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ deleteRecords: { records: [{ recordID: rid }] } }) })
  console.log(`   (已删除测试行 ret=${r3.status})`)
}
;(async () => {
  await addAndRead('A: 纯字符串', { '物品ID': 'M001', '数量': 1, '操作人': '诊断', '备注': 'x', '方向': '入库' })
  await addAndRead('B: [{text}]', { '物品ID': [{ text: 'M001' }], '数量': 1, '操作人': [{ text: '诊断' }], '备注': [{ text: 'x' }], '方向': [{ text: '入库' }] })
  await addAndRead('C: [{type:text,text}]', { '物品ID': [{ type: 'text', text: 'M001' }], '数量': 1, '操作人': [{ type: 'text', text: '诊断' }], '备注': [{ type: 'text', text: 'x' }], '方向': [{ type: 'text', text: '入库' }] })
})()
