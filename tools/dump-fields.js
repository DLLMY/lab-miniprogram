// tools/dump-fields.js
// 拉取 8 张子表的真实列名，用于核对 tencentdocs.js 的 COL 是否逐字匹配。
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
const TABLE = {
  users: 'tyR05n', materials: 't2KB8x', tools: 'ti1nff', requisitions: 'tJOBvr',
  borrow: 'tX2nVn', stock_io: 'tAgqo0', access: 'tCvzwQ', logs: 'tzomXO'
}

async function getFields(sheetId) {
  const url = `https://docs.qq.com/openapi/smartbook/v2/files/${FULL_ID}/sheets/${sheetId}`
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ getFields: { offset: 0, limit: 100 } }) })
  const j = await r.json()
  if (j.ret !== 0) throw new Error(`getFields ${sheetId} ret=${j.ret}`)
  return (j.data.getFields.fields || []).map(f => f.fieldTitle || f.fieldName)
}

;(async () => {
  for (const [key, sid] of Object.entries(TABLE)) {
    const titles = await getFields(sid)
    console.log(`\n[${key}] sheet=${sid}`)
    console.log('  列名:', JSON.stringify(titles, null, 0))
  }
})().catch(e => { console.error('❌', e.message); process.exit(1) })
