// tools/debug-conn.js
// 诊断 200063：打印完整响应体 + trace_id + token 自检 + 列出子表。
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
const CLIENT_ID = process.env.TENCENT_DOCS_CLIENT_ID
const ACCESS_TOKEN = process.env.TENCENT_DOCS_ACCESS_TOKEN
const OPEN_ID = process.env.TENCENT_DOCS_OPEN_ID

const headers = {
  'Content-Type': 'application/json',
  'Access-Token': ACCESS_TOKEN,
  'Client-Id': CLIENT_ID,
  'Open-Id': OPEN_ID
}

async function dump(title, fn) {
  console.log('\n==== ' + title + ' ====')
  try {
    const { status, body, trace } = await fn()
    console.log('HTTP', status, '| trace', trace)
    console.log(JSON.stringify(body, null, 2))
  } catch (e) {
    console.log('EXCEPTION:', e.message)
  }
}

;(async () => {
  await dump('① token 自检 drive/v2/util/resource-use', async () => {
    const r = await fetch('https://docs.qq.com/openapi/drive/v2/util/resource-use', { headers })
    return { status: r.status, trace: r.headers.get('X-Trace-Id'), body: await r.json() }
  })

  const FULL_ID = '300000000$' + FILE_ID
  const sheetId = 't2KB8x'
  await dump(`② smartbook getRecords (FULL file=${FULL_ID}, sheet=${sheetId})`, async () => {
    const url = `https://docs.qq.com/openapi/smartbook/v2/files/${FULL_ID}/sheets/${sheetId}`
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ getRecords: { offset: 0, limit: 1 } }) })
    return { status: r.status, trace: r.headers.get('X-Trace-Id'), body: await r.json() }
  })

  await dump(`③ smartbook GET 列出子表 (FULL file=${FULL_ID})`, async () => {
    const url = `https://docs.qq.com/openapi/smartbook/v2/files/${FULL_ID}/sheets`
    const r = await fetch(url, { method: 'GET', headers })
    return { status: r.status, trace: r.headers.get('X-Trace-Id'), body: await r.json() }
  })

  await dump(`④ drive 文件元数据 (file=${FILE_ID})`, async () => {
    const url = `https://docs.qq.com/openapi/drive/v2/files/${FILE_ID}/metadata`
    const r = await fetch(url, { headers })
    return { status: r.status, trace: r.headers.get('X-Trace-Id'), body: await r.json() }
  })
})()
