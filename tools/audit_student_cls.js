'use strict'
// ============================================================================
// audit_student_cls.js —— 只读核查「学生端班级显示」与「学生工作台入口」
// ----------------------------------------------------------------------------
// 检查项：
//   1) 线上 users 中 student 角色账号的 cls 实际值；
//   2) 线上 requisitions（领用申请）流水里的 cls 实际值；
//   3) 与权威班级全称（学期主数据 classes）逐字比对，标出不一致；
//   4) 统计缩略名（形如 24电气1班）与全称（2024级电气1班）的分布。
// 全程只读，不写任何数据。
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TERM_DIR = path.join(__dirname, 'data', 'terms')

function pickTerm() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--term')
  const name = (i >= 0 && argv[i + 1]) ? argv[i + 1] : ''
  if (name) return path.join(TERM_DIR, name + '.json')
  const files = fs.readdirSync(TERM_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort()
  return files.length ? path.join(TERM_DIR, files[files.length - 1]) : ''
}
const TERM = pickTerm()

function loadCreds() {
  let c = {}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workbuddy', 'mcp.json'), 'utf8'))
    c = (((cfg.mcpServers || {})['lab-docs-proxy'] || {}).env || {})
  } catch (_) { /* allow env fallback */ }
  const e = process.env
  return {
    TCB_SECRET_ID: (e.TCB_SECRET_ID || c.TCB_SECRET_ID || '').trim(),
    TCB_SECRET_KEY: (e.TCB_SECRET_KEY || c.TCB_SECRET_KEY || '').trim(),
    TCB_ENV: (e.TCB_ENV || c.TCB_ENV || '').trim()
  }
}

function loadSdkInit() {
  const cands = ['@cloudbase/node-sdk', path.join(ROOT, 'mcp', 'node_modules', '@cloudbase/node-sdk')]
  for (const c of cands) {
    try {
      const m = require(c)
      const init = (typeof m === 'function') ? m : m.init
      if (typeof init === 'function') return init
    } catch (_) { /* next */ }
  }
  return null
}

function txt(v) {
  if (v == null) return ''
  if (Array.isArray(v)) {
    return v.map(x => (x && typeof x === 'object' ? (x.text || '') : String(x))).join('')
  }
  if (typeof v === 'object') return String(v.text || '')
  return String(v)
}

// 从 records 中按候选字段名取班级值（兼容英文 cls / 中文「归属班级」）
function readCls(fields) {
  const keys = Object.keys(fields || {})
  const hit = keys.find(k => k === 'cls' || k === '归属班级')
  if (!hit) return ''
  return txt(fields[hit]).trim()
}

async function main() {
  const doc = JSON.parse(fs.readFileSync(TERM, 'utf8'))
  const classes = doc.classes || []
  const classSet = new Set(classes.map(c => (typeof c === 'string' ? c : c.name)))
  console.log('=== 权威班级全称（学期主数据）共 %d 个 ===', classSet.size)
  classes.slice(0, 5).forEach(c => console.log('   ', typeof c === 'string' ? c : c.name))

  const creds = loadCreds()
  const init = loadSdkInit()
  if (!init || !creds.TCB_SECRET_ID) {
    console.log('❌ 缺少 SDK 或凭证，无法连云')
    return
  }
  const app = init({ secretId: creds.TCB_SECRET_ID, secretKey: creds.TCB_SECRET_KEY, env: creds.TCB_ENV })
  const db = app.database()

  const COL = {
    users: ['id', 'name', 'role', 'cls', 'status'],
    requisitions: ['id', 'itemName', 'qty', 'user', 'cls', 'status', 'createdAt']
  }

  console.log('\n=== 1) 线上 users 中 student 角色的 cls ===')
  const uRes = await db.collection('users').limit(500).get()
  const users = uRes.data || []
  const students = users.filter(u => (u.role || '') === 'student' || (u.role || '') === '学生')
  const clsCount = new Map()
  students.forEach(u => {
    const c = txt(u.cls).trim()
    clsCount.set(c, (clsCount.get(c) || 0) + 1)
  })
  console.log('  student 账号总数：%d', students.length)
  for (const [c, n] of Array.from(clsCount.entries()).sort((a, b) => b[1] - a[1])) {
    const ok = classSet.has(c)
    console.log('  %-24s x%-3d %s', c || '(空)', n, ok ? '✅全称' : (c ? '❌非权威名' : '⚠空'))
  }
  const bad = students.filter(u => {
    const c = txt(u.cls).trim()
    return c && !classSet.has(c)
  })
  if (bad.length) {
    console.log('  --- 非权威班级名的 student 账号明细 ---')
    bad.slice(0, 30).forEach(u => console.log('    %s %s cls=%s', u.id, u.name, txt(u.cls).trim()))
  }

  console.log('\n=== 2) 线上 requisitions（领用申请）流水 cls ===')
  let reqs = []
  try {
    const r = await db.collection('requisitions').limit(500).get()
    reqs = r.data || []
  } catch (e) {
    console.log('  读取失败：', e.message || e)
  }
  console.log('  申请流水总数：%d', reqs.length)
  const rCls = new Map()
  reqs.forEach(r => {
    const c = readCls(r)
    rCls.set(c, (rCls.get(c) || 0) + 1)
  })
  for (const [c, n] of Array.from(rCls.entries()).sort((a, b) => b[1] - a[1])) {
    const ok = classSet.has(c)
    console.log('  %-24s x%-3d %s', c || '(空/公共)', n, ok ? '✅全称' : (c ? '❌非权威名' : '⚠空'))
  }
  if (reqs.length) {
    console.log('  --- 最近 10 条申请 ---')
    reqs.slice(0, 10).forEach(r => {
      console.log('    %s | %s | 申请人 %s | cls=%s | %s',
        r.id, txt(r.itemName || r.name).slice(0, 14), txt(r.user || r.applicant).slice(0, 10),
        readCls(r) || '(空)', txt(r.status))
    })
  }
}

main().catch(e => { console.error('执行失败：', e.stack || e); process.exit(1) })
