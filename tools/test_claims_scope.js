'use strict'
// ============================================================================
// test_claims_scope.js —— 验证 listClaims 的行级隔离（老师只看本班+公共）
// 用真实的线上数据 + 真实教师账号跑裁决，断言越权可见数为 0。
// ============================================================================

const os = require('os')
const fs = require('fs')
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
  if (!init || !creds.TCB_SECRET_ID) { console.log('❌ 缺 SDK 或凭证'); process.exit(1) }
  const app = init({ secretId: creds.TCB_SECRET_ID, secretKey: creds.TCB_SECRET_KEY, env: creds.TCB_ENV })
  const db = app.database()

  const cd = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'clouddb.js'))
  const ds = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'data-scope.js'))
  cd.__setDbForTest(db)

  const uRes = await db.collection('users').limit(500).get()
  const ROLE_EN = { '超级管理员': 'super', '管理员': 'admin', '教师': 'teacher', '学生': 'student' }
  const users = (uRes.data || []).map(u => ({
    id: '' + (u.id || ''), name: u.name || '',
    role: ROLE_EN[u.role] || u.role || '',
    cls: ('' + (u.cls || '')).trim(), managedClasses: ('' + (u.managedClasses || '')).trim()
  }))
  const teachers = users.filter(u => u.role === 'teacher')
  console.log('角色分布：%s', JSON.stringify(users.reduce((m, u) => { m[u.role] = (m[u.role] || 0) + 1; return m }, {})))

  // 拿到全量（admin 视角）
  const all = await cd.listClaims({ limit: 200 })
  console.log('全量记录数：%d', all.total)
  const allClasses = Array.from(new Set(all.rows.map(r => r.cls).filter(Boolean)))
  console.log('涉及班级：%s\n', allClasses.join('、') || '(无)')

  let violations = 0
  let checked = 0
  for (const t of teachers) {
    const scope = ds.scopeOf({ id: t.id, name: t.name, role: 'teacher', cls: t.cls, managedClasses: t.managedClasses })
    const seen = await ds.runWithScope(scope, () => cd.listClaims({ limit: 200 }))
    const rows = (seen && seen.rows) || []
    checked++
    // 越权：看到不属于自己带的班、且不是公共资源（空 cls）的记录
    const illegal = rows.filter(r => r.cls && scope.classes.indexOf(r.cls) < 0)
    const publicSeen = rows.filter(r => !r.cls).length
    if (illegal.length) {
      violations += illegal.length
      console.log('  ❌ %s %s 越权看到 %d 条：%s', t.id, t.name, illegal.length,
        Array.from(new Set(illegal.map(r => r.cls))).join('、'))
    } else {
      console.log('  ✅ %s %s 可见 %d 条（本班 %d + 公共 %d）',
        t.id, t.name, rows.length, rows.length - publicSeen, publicSeen)
    }
  }

  // 管理员/超管应看全量
  for (const role of ['admin', 'super']) {
    const u = users.find(x => x.role === role)
    if (!u) continue
    const scope = ds.scopeOf({ id: u.id, name: u.name, role, cls: u.cls, managedClasses: u.managedClasses })
    const seen = await ds.runWithScope(scope, () => cd.listClaims({ limit: 200 }))
    const n = (seen && seen.rows || []).length
    console.log('  %s %s 可见 %d 条（应为全量 %d）%s',
      role === 'admin' ? '✅' : '✅', u.name, n, all.total, n === all.total ? '' : '⚠ 不一致')
  }

  console.log('\n检查教师数 %d，越权条数 %d', checked, violations)
  if (violations) { console.log('❌ 存在越权可见'); process.exitCode = 1 }
  else console.log('✅ 全部教师均无越权可见')
}

main().catch(e => { console.error(e.stack || e); process.exit(1) })
