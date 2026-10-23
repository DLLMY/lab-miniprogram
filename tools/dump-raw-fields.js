// tools/dump-raw-fields.js —— 打印指定表的原始字段定义（类型 + 选项），定位 22015。
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
const sheets = { stock_io: 'tAgqo0', logs: 'tzomXO', materials: 't2KB8x', requisitions: 'tJOBvr', borrow: 'tX2nVn', tools: 'ti1nff' }
async function getFieldsRaw(sheetId) {
  const url = `https://docs.qq.com/openapi/smartbook/v2/files/${FULL_ID}/sheets/${sheetId}`
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ getFields: { offset: 0, limit: 100 } }) })
  const j = await r.json()
  return j.data.getFields.fields || []
}
;(async () => {
  for (const [key, sid] of Object.entries(sheets)) {
    const fs2 = await getFieldsRaw(sid)
    console.log(`\n==== ${key} (${sid}) ====`)
    for (const f of fs2) {
      let extra = ''
      if (f.options || f.propertySelect || f.selectOptions) {
        const opts = f.options || (f.propertySelect && f.propertySelect.options) || f.selectOptions || []
        extra = ' 选项=' + JSON.stringify(opts)
      }
      console.log(`  ${f.fieldTitle}  type=${f.fieldType}` + extra)
    }
  }
})().catch(e => { console.error('❌', e.message); process.exit(1) })
