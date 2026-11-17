'use strict'
// ============================================================================
// audit_online_scope.js —— 只读核查线上「任课教师 → 班级」归属是否落地
// ----------------------------------------------------------------------------
// 检查项：
//   1) 线上 users 中 18 位教师的 managedClasses 是否 == 学期主数据；
//   2) 班级名是否严格等于权威 classes 全称（多一个空格都会让隔离失效）；
//   3) 40 个班级管理员的 cls 是否合法，且每班是否至少有一位任课教师；
//   4) 反查「班级 → 任课教师」，输出审批链路覆盖情况；
//   5) 探测线上 docsProxy 是否为新版（是否回显 managedClasses）。
// 全程只读，不写任何数据。用法：node tools/audit_online_scope.js
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
  const files = fs.readdirSync(TERM_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_')).sort()
  return files.length ? path.join(TERM_DIR, files[files.length - 1]) : ''
}
const TERM = pickTerm()

function loadCreds() {
  let c = {}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workbuddy', 'mcp.json'), 'utf8'))
    c = (((cfg.mcpServers || {})['lab-docs-proxy'] || {}).env || {})
  } catch (_) { /* 允许用环境变量 */ }
  const e = process.env
  return {
    ROBOT_KEY: (e.DOCS_PROXY_ROBOT_KEY || c.DOCS_PROXY_ROBOT_KEY || '').trim(),
    TCB_SECRET_ID: (e.TCB_SECRET_ID || c.TCB_SECRET_ID || '').trim(),
    TCB_SECRET_KEY: (e.TCB_SECRET_KEY || c.TCB_SECRET_KEY || '').trim(),
    TCB_ENV: (e.TCB_ENV || c.TCB_ENV || '').trim()
  }
}

function loadSdkInit() {
  const cands = [
    '@cloudbase/node-sdk',
    path.join(ROOT, 'mcp', 'node_modules', '@cloudbase/node-sdk')
  ]
  for (const c of cands) {
    try {
      const m = require(c)
      const init = (typeof m === 'function') ? m : m.init
      if (typeof init === 'function') return init
    } catch (_) { /* next */ }
  }
  return null
}

function parseClasses(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean)
  return String(v || '').split(/[,，、;；|]/).map(x => x.trim()).filter(Boolean)
}

function eqSet(a, b) {
  const x = Array.from(new Set(a)).sort().join('|')
  const y = Array.from(new Set(b)).sort().join('|')
  return x === y
}

async function probeCloudFn(app, robotKey) {
  if (!robotKey) return '未配置 ROBOT_KEY，跳过'
  try {
    const r = await app.callFunction({ name: 'docsProxy', data: { action: 'snapshot', robotKey } })
    const out = (r && r.result) || {}
    const users = (out.data && out.data.users) || []
    if (!users.length) return 'snapshot 无 users，无法判定'
    const has = users.some(u => Object.prototype.hasOwnProperty.call(u.fields || u, 'managedClasses'))
    return has ? '新版（回显 managedClasses，隔离可生效）'
      : '旧版（不回显 managedClasses，行级隔离尚未生效）'
  } catch (e) {
    return '调用失败：' + (e.message || e)
  }
}

async function probeDiag(app, robotKey) {
  if (!robotKey) return '未配置 ROBOT_KEY，跳过'
  try {
    const r = await app.callFunction({ name: 'docsProxy', data: { action: 'diag', robotKey } })
    const i = (r && r.result && r.result.data) || {}
    if (!i.backend) return 'diag 无有效返回（可能未登录或云端报错）'
    return 'backend=' + i.backend + ' / dataBackend=' + i.dataBackend +
      ' / useMock=' + i.useMock + ' / autoFallback=' + i.autoFallback +
      ' / chain=' + JSON.stringify(i.chain || []) + ' / ping=' + i.ping +
      ' / 物料=' + i.materialCount
  } catch (e) { return '调用失败：' + (e.message || e) }
}

async function main() {
  if (!TERM || !fs.existsSync(TERM)) { console.error('❌ 找不到学期主数据：' + TERM); process.exit(2) }
  const doc = JSON.parse(fs.readFileSync(TERM, 'utf8'))
  const creds = loadCreds()
  const sdkInit = loadSdkInit()
  if (!sdkInit || !creds.TCB_SECRET_ID || !creds.TCB_SECRET_KEY || !creds.TCB_ENV) {
    console.error('❌ 缺少云环境凭证或 SDK'); process.exit(2)
  }
  const app = sdkInit({ secretId: creds.TCB_SECRET_ID, secretKey: creds.TCB_SECRET_KEY, env: creds.TCB_ENV })
  const db = app.database()
  const res = await db.collection('users').limit(1000).get()
  const rows = res.data || []
  console.log('=== 学期 %s / 线上 users 共 %d 行 ===', path.basename(TERM, '.json'), rows.length)

  const online = {}
  const roleCount = {}
  for (const r of rows) {
    online[String(r.id || '').toUpperCase()] = r
    const role = String(r.role || '(空)')
    roleCount[role] = (roleCount[role] || 0) + 1
  }
  console.log('角色分布：' + Object.keys(roleCount).map(k => k + '=' + roleCount[k]).join('  '))

  const classes = doc.classes || []
  const classSet = new Set(classes)
  let bad = 0

  console.log('\n=== 1) 教师 managedClasses 对账（线上 vs 学期主数据） ===')
  const onlineByClass = {}
  classes.forEach(c => { onlineByClass[c] = [] })
  const illegal = new Set()
  for (const t of doc.teachers) {
    const r = online[String(t.id).toUpperCase()]
    if (!r) { console.log('  !! %s %s 记录缺失', t.id, t.name); bad++; continue }
    const got = parseClasses(r.managedClasses)
    const want = t.managedClasses || []
    const ok = eqSet(got, want)
    const illegalHere = got.filter(c => !classSet.has(c))
    illegalHere.forEach(c => illegal.add(c))
    got.filter(c => classSet.has(c)).forEach(c => onlineByClass[c].push(t.name + '(' + t.id + ')'))
    if (!ok || illegalHere.length) bad++
    const head = '  ' + (ok && !illegalHere.length ? 'OK' : '!!') + ' ' +
      t.id + ' ' + t.name + ' [' + (r.role || '') + '] ' +
      want.length + '班 → ' + (got.join('、') || '<空>')
    console.log(head + (ok ? '' : '\n      期望: ' + want.join('、')) +
      (illegalHere.length ? '\n      ⚠非法班级名: ' + illegalHere.join('、') : ''))
  }
  console.log('  差异教师：%d / %d', bad, doc.teachers.length)

  console.log('\n=== 2) 班级管理员 cls 对账 ===')
  let adminBad = 0
  const adminByClass = {}
  for (const a of doc.classAdmins) {
    const r = online[String(a.id).toUpperCase()]
    if (!r) { console.log('  !! %s 记录缺失', a.id); adminBad++; continue }
    const got = String(r.cls || '').trim()
    const ok = got === a.cls && classSet.has(got)
    if (!ok) { adminBad++; console.log('  !! %s %s cls=%s（期望 %s）', a.id, a.name, got || '<空>', a.cls) }
    if (!adminByClass[got]) adminByClass[got] = 0
    adminByClass[got]++
  }
  console.log('  差异班级管理员：%d / %d', adminBad, doc.classAdmins.length)

  console.log('\n=== 3) 班级 → 任课教师（审批链路覆盖） ===')
  let uncovered = 0
  for (const c of classes) {
    const ts = onlineByClass[c] || []
    const admins = adminByClass[c] || 0
    if (!ts.length) uncovered++
    console.log('  ' + c + ' | 任课教师 ' + ts.length + '：' +
      (ts.length ? ts.join('、') : '⚠无') + ' | 班级管理员 ' + admins +
      (admins === 2 ? '' : ' ⚠应为2'))
  }
  console.log('  无任课教师的班级：%d', uncovered)
  console.log('  非法班级名：%s', illegal.size ? Array.from(illegal).join('、') : '无')

  console.log('\n=== 3b) 全部学生账号 cls 是否使用权威班级全称 ===')
  const studBad = []
  for (const r of rows) {
    if (String(r.role || '') !== '学生' && String(r.role || '') !== 'student') continue
    const c = String(r.cls || '').trim()
    if (!classSet.has(c)) studBad.push(r.id + ' ' + r.name + ' cls=' + (c || '<空>'))
  }
  console.log('  学生账号 cls 不匹配权威清单：' +
    (studBad.length ? '\n    ' + studBad.join('\n    ') : '无'))

  console.log('\n=== 4) 线上 docsProxy 版本探测 ===')
  console.log('  ' + await probeCloudFn(app, creds.ROBOT_KEY))
  console.log('  运行态：' + await probeDiag(app, creds.ROBOT_KEY))

  console.log('\n=== 5) 用线上真实带班值模拟新版隔离引擎的裁决 ===')
  const ds = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'data-scope.js'))
  let simBad = 0
  for (const t of doc.teachers) {
    const r = online[String(t.id).toUpperCase()]
    const me = { id: t.id, role: 'teacher', cls: '', managedClasses: r ? r.managedClasses : '' }
    const scope = ds.scopeOf(me)
    const visible = classes.filter(c => ds.rowVisible(scope, 'requisitions', { cls: c, user: 'X' }))
    const want = t.managedClasses || []
    if (!eqSet(visible, want)) {
      simBad++
      console.log('  !! ' + t.id + ' ' + t.name + ' 可见 ' + visible.length + ' 班：' + visible.join('、'))
    }
  }
  const sampleScope = ds.scopeOf({
    id: 'WT001', role: 'teacher', cls: '',
    managedClasses: online['WT001'] ? online['WT001'].managedClasses : ''
  })
  const pub = ds.rowVisible(sampleScope, 'requisitions', { user: 'X' })
  const st = ds.scopeOf({ id: '2024DQ101', role: 'student', cls: '2024级电气1班' })
  const own = ds.rowVisible(st, 'requisitions', { cls: '2024级电气1班', user: '2024DQ101' })
  const others = ds.rowVisible(st, 'requisitions', { cls: '2024级电气1班', user: '2024DQ102' })
  const full = ds.scopeOf({ id: 'T001', role: 'super', cls: '', managedClasses: '' })
  const fullVisible = ds.rowVisible(full, 'requisitions', { cls: '2025级数控班', user: 'X' })
  console.log('  模拟结果：' + (doc.teachers.length - simBad) + '/' + doc.teachers.length +
    ' 位教师「可见班级 == 带班班级」，越权可见 ' + simBad)
  console.log('  教师看空 cls 公共资源：' + pub + '；super 看任意班级：' + fullVisible)
  console.log('  班级管理员看本人申请：' + own + '；看同班另一管理员申请：' + others)
  console.log('  （以上为本地新版引擎的模拟结论，线上是否生效取决于是否部署 docsProxy）')
}

main().catch(e => { console.error('💥', e.stack || e.message); process.exit(1) })
