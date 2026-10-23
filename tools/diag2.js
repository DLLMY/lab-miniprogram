// tools/diag2.js —— 读 stock_io 原始值 + 测试纯字符串/数组两种写法定位 22015。
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
async function rawGet(sheetId, limit = 1) {
  const url = `https://docs.qq.com/openapi/smartbook/v2/files/${FULL_ID}/sheets/${sheetId}`
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ getRecords: { offset: 0, limit } }) })
  const j = await r.json()
  return j.data.getRecords.records.map(x => x.values)
}
async function tryAdd(label, values) {
  const url = `https://docs.qq.com/openapi/smartbook/v2/files/${FULL_ID}/sheets/tAgqo0`
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ addRecords: { records: [{ values }] } }) })
  const j = await r.json()
  console.log(`[${j.ret === 0 ? 'OK ' : 'ERR'}] ${label} → ret=${j.ret} ${j.msg || ''}`)
  return j.ret === 0 ? j.data.addRecords.records[0] : null
}
;(async () => {
  console.log('--- stock_io 原始 values 样例 ---')
  const raw = await rawGet('tAgqo0')
  console.log(JSON.stringify(raw[0], null, 0))

  console.log('\n--- 测试不同写法 ---')
  await tryAdd('物品ID=纯字符串', { '物品ID': 'M001', '数量': 1, '操作人': '诊断', '备注': 'x', '方向': '入库' })
  await tryAdd('物品ID=数组', { '物品ID': [{ text: 'M001' }], '数量': 1, '操作人': [{ text: '诊断' }], '备注': [{ text: 'x' }], '方向': [{ text: '入库' }] })
  await tryAdd('方向=纯字符串 入库', { '物品ID': 'M001', '数量': 1, '操作人': '诊断', '备注': 'x', '方向': '入库' })
})()
