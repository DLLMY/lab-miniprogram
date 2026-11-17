'use strict'
// ============================================================================
// import_teachers.js —— 把某学期的「教师账号 + 班级管理员账号」导入线上 users 表
// ----------------------------------------------------------------------------
// 数据源：tools/data/terms/<学期>.json（由 tools/build_term_data.py 生成）
//
// 设计要点（对应 docs/数据域隔离设计.md「每学期教师带班更新」）：
//   * 两组账号：teachers（teacher + managedClasses 带班）、classAdmins（student + cls 本班）；
//   * 幂等：按工号 adminUpsertUser，已存在则更新姓名/角色/归属，绝不重新编号；
//   * 只写这两组账号，不触碰 super/admin 及账号表之外的其他数据，也不删除任何账号；
//   * 离任教师（上期有、本期无）只提示，由管理员手动停用；
//   * 写入前自动备份线上 users 快照到 tools/backup_users_<时间戳>.json（已 gitignore）；
//   * 走云函数「应急超级通道」robotKey，adminUpsertUser 需要两段式二次确认，
//     脚本自动完成握手，无需手工处理。
//
// 用法（仓库根目录）：
//   node tools/import_teachers.js --term 2026-2027-1            # 预览（默认，只读）
//   node tools/import_teachers.js --term 2026-2027-1 --apply    # 真正写入
//   --group all|teachers|classAdmins   默认 all（一次导入两组）
//
// 凭证：优先读环境变量；缺省时自动读 ~/.workbuddy/mcp.json 的
//       lab-docs-proxy 连接器配置（TCB 三件套 + DOCS_PROXY_ROBOT_KEY）。
//       不在脚本里硬编码任何密钥。
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const https = require('https')
const { URL } = require('url')

const argv = process.argv.slice(2)
function arg(name, def) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def
}
const APPLY = argv.indexOf('--apply') >= 0
const GROUP = arg('group', 'all').trim().toLowerCase()
const TERM_DIR = path.join(__dirname, 'data', 'terms')

function pickTerm() {
  const t = arg('term', '')
  if (t) return t
  if (!fs.existsSync(TERM_DIR)) return ''
  const files = fs.readdirSync(TERM_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort()
  return files.length ? files[files.length - 1].replace(/\.json$/, '') : ''
}

function loadCreds() {
  const e = {
    HTTP_URL: (process.env.DOCS_PROXY_HTTP_URL || '').trim(),
    ROBOT_KEY: (process.env.DOCS_PROXY_ROBOT_KEY || '').trim(),
    TCB_SECRET_ID: (process.env.TCB_SECRET_ID || '').trim(),
    TCB_SECRET_KEY: (process.env.TCB_SECRET_KEY || '').trim(),
    TCB_ENV: (process.env.TCB_ENV || '').trim(),
    TRANSPORT: (process.env.LAB_MCP_TRANSPORT || '').trim().toLowerCase()
  }
  if (!e.ROBOT_KEY || !(e.HTTP_URL || (e.TCB_SECRET_ID && e.TCB_SECRET_KEY && e.TCB_ENV))) {
    try {
      const cfg = require(path.join(os.homedir(), '.workbuddy', 'mcp.json'))
      const c = (((cfg.mcpServers || {})['lab-docs-proxy'] || {}).env || {})
      if (!e.HTTP_URL) e.HTTP_URL = (c.DOCS_PROXY_HTTP_URL || '').trim()
      if (!e.ROBOT_KEY) e.ROBOT_KEY = (c.DOCS_PROXY_ROBOT_KEY || '').trim()
      if (!e.TCB_SECRET_ID) e.TCB_SECRET_ID = (c.TCB_SECRET_ID || '').trim()
      if (!e.TCB_SECRET_KEY) e.TCB_SECRET_KEY = (c.TCB_SECRET_KEY || '').trim()
      if (!e.TCB_ENV) e.TCB_ENV = (c.TCB_ENV || '').trim()
    } catch (_) { /* 无连接器配置时保持为空，后面统一报错 */ }
  }
  return e
}

function loadSdkInit() {
  const cands = [
    '@cloudbase/node-sdk',
    path.join(__dirname, '..', 'mcp', 'node_modules', '@cloudbase/node-sdk')
  ]
  for (const c of cands) {
    try {
      const m = require(c)
      const init = (typeof m === 'function') ? m : m.init
      if (typeof init === 'function') return init
    } catch (_) { /* 换下一个候选路径 */ }
  }
  return null
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { return reject(new Error('HTTP_URL 非法')) }
    const data = JSON.stringify(body)
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = ''
      res.on('data', c => { buf += c })
      res.on('end', () => {
        try { resolve(JSON.parse(buf)) } catch (e) { reject(new Error('云函数响应非 JSON: ' + buf.slice(0, 200))) }
      })
    })
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('请求云函数超时(30s)')))
    req.write(data); req.end()
  })
}

async function invokeProxy(payload, creds, sdkInit) {
  if (creds.TRANSPORT === 'sdk' || (!creds.TRANSPORT && creds.TCB_SECRET_ID && creds.TCB_SECRET_KEY && creds.TCB_ENV)) {
    if (!sdkInit) return { error: '未找到 @cloudbase/node-sdk（应在 mcp/ 目录安装）' }
    const app = sdkInit({ secretId: creds.TCB_SECRET_ID, secretKey: creds.TCB_SECRET_KEY, env: creds.TCB_ENV })
    const res = await app.callFunction({ name: 'docsProxy', data: payload })
    if (res && Object.prototype.hasOwnProperty.call(res, 'result')) {
      return (res.result && typeof res.result === 'object') ? res.result : { code: 0, data: res.result }
    }
    return { error: 'TCB 调用失败: ' + JSON.stringify(res).slice(0, 200) }
  }
  if (creds.TRANSPORT === 'http' || (!creds.TRANSPORT && creds.HTTP_URL)) {
    if (!creds.HTTP_URL) return { error: '未配置 DOCS_PROXY_HTTP_URL' }
    return await postJson(creds.HTTP_URL, payload)
  }
  return { error: '未配置传输方式：需 DOCS_PROXY_HTTP_URL 或 TCB_SECRET_ID/TCB_SECRET_KEY/TCB_ENV' }
}

function ts() { return new Date().toISOString().replace(/[:.]/g, '-') }

// —— 云函数旧版兼容：直接读写云数据库 users 集合 ————————————————————
// 背景：数据域隔离（方案 C）落地后需重新「上传并部署 docsProxy」才生效。
// 若线上仍是旧版云函数，adminUpsertUser 会忽略 managedClasses，且 snapshot
// 也不回显该字段。此时用同一套凭证直连数据库补写，让数据先就位；
// 隔离规则的真正生效仍以部署新版云函数为前提（脚本会明确提示）。
function makeDb(creds, sdkInit) {
  if (!sdkInit || !creds.TCB_SECRET_ID || !creds.TCB_SECRET_KEY || !creds.TCB_ENV) return null
  try {
    const app = sdkInit({ secretId: creds.TCB_SECRET_ID, secretKey: creds.TCB_SECRET_KEY, env: creds.TCB_ENV })
    return app.database ? app.database() : null
  } catch (_) { return null }
}

async function readRawUsers(db) {
  if (!db) return null
  const res = await db.collection('users').limit(1000).get()
  return res.data || []
}

async function fillManagedDirect(db, list) {
  const raw = await readRawUsers(db)
  const byId = {}
  for (const r of raw) byId[String(r.id || '').toUpperCase()] = r
  // 注意：@cloudbase/node-sdk 2.x 的 doc().update() 直接接收字段对象，
  // 不是云函数内 wx-server-sdk 的 { data: {...} } 包装，写错会生成嵌套 data 字段。
  const remove = (db.command && typeof db.command.remove === 'function') ? db.command.remove() : null
  let n = 0
  for (const t of list) {
    const rec = byId[t.id.toUpperCase()]
    if (!rec || !rec._id) continue
    const upd = { managedClasses: (t.managedClasses || []).join(',') }
    if (remove && rec.data && typeof rec.data === 'object') upd.data = remove // 清理历史误写的嵌套字段
    await db.collection('users').doc(rec._id).update(upd)
    n++
  }
  return n
}

async function main() {
  const term = pickTerm()
  if (!term) { console.error('❌ 未找到学期主数据，请先运行 build_term_data.py'); process.exit(2) }
  const file = path.join(TERM_DIR, term + '.json')
  if (!fs.existsSync(file)) { console.error('❌ 找不到：' + file); process.exit(2) }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  const teachers = (doc.teachers || []).filter(t => t.id && t.name)
  const admins = (doc.classAdmins || []).filter(t => t.id && t.name)
  const groups = { teachers, classadmins: admins }
  if (GROUP !== 'all' && !groups[GROUP]) {
    console.error('❌ --group 只支持 all / teachers / classAdmins'); process.exit(2)
  }
  const list = GROUP === 'all' ? teachers.concat(admins)
    : (GROUP === 'teachers' ? teachers : admins)
  if (!list.length) { console.error('❌ 学期主数据里没有可导入的账号'); process.exit(2) }

  console.log('学期：' + term + '   模式：' + (APPLY ? 'APPLY（真实写入）' : 'DRY-RUN（只读预览）'))
  console.log('分组：' + GROUP + '   教师 ' + teachers.length + ' / 班级管理员 ' + admins.length +
    '   本次写入 ' + list.length + '   班级数 ' + (doc.classes || []).length)
  if (doc.excluded && doc.excluded.length) console.log('刻意排除（已有账号）：' + doc.excluded.join('、'))
  if (doc.retired && doc.retired.length) console.log('⚠️ 上期有本期无（需手动停用，脚本不删）：' + doc.retired.join('、'))
  console.log('\n=== 待写入账号 ===')
  for (const t of list) {
    const mc = (t.managedClasses || []).join(',')
    console.log('  %s | %s | %s | %s', t.id, t.name, t.role,
      mc ? ('带班 ' + mc) : ('归属班级 ' + (t.cls || '-')))
  }
  if (!APPLY) {
    console.log('\n以上为预览，未写入任何数据。确认无误后加 --apply 执行。')
    return
  }

  const creds = loadCreds()
  if (!creds.ROBOT_KEY) { console.error('❌ 缺少 DOCS_PROXY_ROBOT_KEY（全局超级钥匙）'); process.exit(2) }
  const sdkInit = loadSdkInit()
  const db = makeDb(creds, sdkInit)

  // 1) 写入前备份线上 users（失败即中止，绝不裸写）
  //    优先直连数据库取原始记录（含 _id 与全部字段），回退到云函数 snapshot。
  const before = await invokeProxy({ action: 'snapshot', robotKey: creds.ROBOT_KEY }, creds, sdkInit)
  if (before.error || before.code !== 0) {
    console.error('❌ 读取线上快照失败，已中止：' + (before.error || JSON.stringify(before).slice(0, 200)))
    process.exit(1)
  }
  // 探测线上云函数版本：新版 adminListUsers 会回显 managedClasses
  const snapUsers = (before.data && before.data.users) || []
  const cloudSupportsScope = snapUsers.some(r => Object.prototype.hasOwnProperty.call(r.fields || r, 'managedClasses'))
  let users = null
  if (db) { try { users = await readRawUsers(db) } catch (_) { users = null } }
  if (!users) users = (before.data && before.data.users) || []
  const backupPath = path.join(__dirname, 'backup_users_' + ts() + '.json')
  fs.writeFileSync(backupPath, JSON.stringify(users, null, 2), 'utf8')
  console.log('\n✅ 已备份线上 users（' + users.length + ' 行，原始记录）→ ' + backupPath)

  // 2) 逐条写入（两段式确认）
  //    幂等关键：编辑已存在的工号必须带 rid，否则服务端 409「工号已存在」重号守卫。
  const existingRid = {}
  for (const r of (before.data && before.data.users) || []) {
    const f = r.fields || r
    existingRid[String(f.id || '').toUpperCase()] = f.rid || r.recordId || ''
  }
  const result = { created: [], updated: [], failed: [] }
  for (const t of list) {
    const payload = {
      action: 'adminUpsertUser',
      robotKey: creds.ROBOT_KEY,
      id: t.id,
      name: t.name,
      role: t.role || 'teacher',
      cls: t.cls || '',
      status: t.status || '启用',
      rid: existingRid[t.id.toUpperCase()] || '',
      managedClasses: (t.managedClasses || []).join(',')
    }
    try {
      const first = await invokeProxy(payload, creds, sdkInit)
      let final = first
      if (first && first.code === 0 && first.confirm === true) {
        final = await invokeProxy(Object.assign({}, payload, { __confirm: first.token }), creds, sdkInit)
      }
      if (final && final.code === 0) {
        const d = final.data || {}
        ;(d.updated ? result.updated : result.created).push(t.id)
      } else {
        result.failed.push(t.id + ': ' + ((final && final.data && final.data.msg) || (final && final.msg) || JSON.stringify(final).slice(0, 120)))
      }
    } catch (e) {
      result.failed.push(t.id + ': ' + e.message)
    }
  }
  console.log('\n=== 写入结果 ===')
  console.log('  新建 ' + result.created.length + ' / 更新 ' + result.updated.length + ' / 失败 ' + result.failed.length)
  if (result.failed.length) result.failed.forEach(x => console.log('  ❌ ' + x))

  // 3) 只读对账（优先直连数据库原始记录；旧版云函数 snapshot 不回显 managedClasses）
  let rows = null
  if (db) { try { rows = await readRawUsers(db) } catch (_) { rows = null } }
  let viaDb = !!rows
  if (!rows) {
    const after = await invokeProxy({ action: 'snapshot', robotKey: creds.ROBOT_KEY }, creds, sdkInit)
    rows = (after.data && after.data.users) || []
  }
  const ROLE_ZH = { student: '学生', teacher: '教师', admin: '管理员', super: '超级管理员' }
  function compare(rows) {
    const map = {}
    for (const r of rows) { const f = r.fields || r; map[String(f.id || '').toUpperCase()] = f }
    const bad = []
    for (const t of list) {
      const f = map[t.id.toUpperCase()]
      if (!f) { bad.push({ t, why: '记录缺失' }); continue }
      // 原始记录里角色存中文「教师/学生」，snapshot 里是英文，两者都算正确
      const wantRole = t.role || 'teacher'
      const role = String(f.role || '')
      const roleOk = role === wantRole || role === ROLE_ZH[wantRole]
      const wantMc = (t.managedClasses || []).join(',')
      const gotMc = String(f.managedClasses || '')
      const wantCls = String(t.cls || '')
      const gotCls = String(f.cls || '')
      if (f.name !== t.name || !roleOk || gotMc !== wantMc || gotCls !== wantCls) {
        bad.push({ t, why: 'name=' + f.name + ' role=' + role + ' cls=' + (gotCls || '<空>') +
          ' managed=' + (gotMc || '<空>') })
      }
    }
    return bad
  }
  let bad = compare(rows)

  // 4) 旧版云函数兼容：带班字段未生效时，直连数据库幂等补写后重新对账
  if (bad.length && db) {
    console.log('\n⚠️ 检测到带班字段未生效（线上 docsProxy 仍为旧版，未部署数据域隔离）。')
    console.log('   改用数据库直连补写 managedClasses …')
    const n = await fillManagedDirect(db, list)
    console.log('   已补写 ' + n + ' 条')
    rows = await readRawUsers(db)
    viaDb = true
    bad = compare(rows)
    if (!bad.length) {
      console.log('   ℹ️ 数据已就位；但隔离规则要等「上传并部署 docsProxy」新版云函数后才真正生效。')
    }
  }

  console.log('\n=== 对账（' + (viaDb ? '数据库原始记录' : '云函数 snapshot') + '）===')
  if (bad.length) bad.forEach(x => console.log('  ❌ ' + x.t.id + ' ' + x.why))
  console.log('  ' + (list.length - bad.length) + '/' + list.length + ' 条一致；线上 users 共 ' + rows.length + ' 行')
  if (!cloudSupportsScope) {
    console.log('\n⚠️ 线上 docsProxy 仍是旧版（快照不含 managedClasses）。')
    console.log('   带班数据已直连数据库就位，但行级隔离要等「上传并部署 docsProxy」新版云函数后才生效。')
  }
  if (result.failed.length || bad.length) process.exitCode = 1
}

main().catch(e => { console.error('💥 异常：', e.stack || e.message); process.exit(1) })
