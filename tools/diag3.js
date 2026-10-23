// tools/diag3.js —— 看 requisitions addRecords 返回结构（是否含 申请ID 自动编号）
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
;(async () => {
  const url = `https://docs.qq.com/openapi/smartbook/v2/files/${FULL_ID}/sheets/tJOBvr`
  const values = {
    '申请人ID': 'S002', '物品ID': 'M001', '物品类型': '领用', '数量': 1,
    '用途说明': '', '状态': '待审批', '申请时间': String(Date.now()), '审批人': ''
  }
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ addRecords: { records: [{ values }] } }) })
  const j = await r.json()
  console.log('ret=', j.ret, 'msg=', j.msg)
  console.log('创建返回 records[0] =', JSON.stringify(j.data.addRecords.records[0], null, 2))
})()
