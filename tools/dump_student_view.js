'use strict'
// ============================================================================
// dump_student_view.js —— 只读：dump 线上 students/requisitions/borrow/access 全字段
// 目的：定位学生端「申请」显示的班级到底存的是什么值
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')

function loadCreds() {
  let c = {}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workbuddy', 'mcp.json'), 'utf8'))
    c = (((cfg.mcpServers || {})['lab-docs-proxy'] || {}).env || {})
  } catch (_) { /* env */ }
  const e = process.env
  return {
    TCB_SECRET_ID: (e.TCB_SECRET_ID || c.TCB_SECRET_ID || '').trim(),
    TCB_SECRET_KEY: (e.TCB_SECRET_KEY || c.TCB_SECRET_KEY || '').trim(),
    TCB_ENV: (e.TCB_ENV || c.TCB_ENV || '').trim()
  }
}

function loadSdkInit() {
  for (const c of ['@cloudbase/node-sdk', path.join(ROOT, 'mcp', 'node_modules', '@cloudbase', 'node-sdk')]) {
    try {
      const m = require(c)
      const init = (typeof m === 'function') ? m : m.init
      if (typeof init === 'function') return init
    } catch (_) { /* next */ }
  }
  return null
}

async function main() {
  const creds = loadCreds()
  const init = loadSdkInit()
  if (!init || !creds.TCB_SECRET_ID) { console.log('❌ 缺凭证'); return }
  const app = init({ secretId: creds.TCB_SECRET_ID, secretKey: creds.TCB_SECRET_KEY, env: creds.TCB_ENV })
  const db = app.database()

  for (const coll of ['requisitions', 'borrow', 'access', 'stock_io']) {
    console.log('\n========== %s ==========', coll)
    let rows = []
    try {
      const r = await db.collection(coll).limit(50).get()
      rows = r.data || []
    } catch (e) {
      console.log('  读取失败：', e.message || e)
      continue
    }
    console.log('  共 %d 行', rows.length)
    rows.slice(0, 12).forEach((row, i) => {
      const out = {}
      Object.keys(row).forEach(k => {
        if (k === '_id') return
        let v = row[k]
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          v = Object.keys(v).map(kk => kk + '=' + JSON.stringify(v[kk])).join(' ')
        }
        out[k] = v
      })
      console.log('  [%d] %s', i, JSON.stringify(out, null, 0).slice(0, 600))
    })
  }
}

main().catch(e => { console.error(e.stack || e); process.exit(1) })
