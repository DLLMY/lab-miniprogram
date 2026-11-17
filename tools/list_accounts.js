'use strict'
// ============================================================================
// list_accounts.js —— 只读：列出线上全部账号（便于测试时挑选身份）
// 输出：按角色分组，标注可测试用途；不写任何数据。
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

const ROLE_CN = { super: '超级管理员', admin: '管理员', teacher: '教师', student: '学生' }

function roleOf(u) {
  const r = ('' + (u.role || '')).trim()
  if (ROLE_CN[r]) return r
  const cn = { '超级管理员': 'super', '管理员': 'admin', '教师': 'teacher', '学生': 'student' }[r]
  return cn || r || '未知'
}

async function main() {
  const creds = loadCreds()
  const init = loadSdkInit()
  if (!init || !creds.TCB_SECRET_ID) { console.log('❌ 缺 SDK 或凭证'); process.exit(1) }
  const app = init({ secretId: creds.TCB_SECRET_ID, secretKey: creds.TCB_SECRET_KEY, env: creds.TCB_ENV })
  const db = app.database()

  const res = await db.collection('users').limit(500).get()
  const rows = res.data || []
  console.log('线上 users 共 %d 行\n', rows.length)

  const groups = { super: [], admin: [], teacher: [], student: [], other: [] }
  rows.forEach(u => groups[roleOf(u)].push(u))

  const order = ['super', 'admin', 'teacher', 'student', 'other']
  order.forEach(k => {
    const list = groups[k]
    if (!list.length) return
    console.log('===== %s（%d 个）=====', ROLE_CN[k] || '其他', list.length)
    list.sort((a, b) => ('' + (a.id || '')).localeCompare('' + (b.id || '')))
    list.forEach(u => {
      const cls = ('' + (u.cls || '')).trim()
      const mc = ('' + (u.managedClasses || '')).trim()
      const st = ('' + (u.status || '启用')).trim()
      const bound = u.openid ? '已绑微信' : '未绑'
      const bits = []
      if (cls) bits.push('班级=' + cls)
      if (mc) bits.push('带班=' + mc)
      if (st !== '启用') bits.push('状态=' + st)
      bits.push(bound)
      console.log('  ' + String(u.id).padEnd(11) + String(u.name).padEnd(16) + bits.join('  '))
    })
    console.log('')
  })

  // 汇总
  console.log('===== 汇总 =====')
  order.forEach(k => { if (groups[k].length) console.log('  %s：%d', ROLE_CN[k] || '其他', groups[k].length) })
}

main().catch(e => { console.error(e.stack || e); process.exit(1) })
