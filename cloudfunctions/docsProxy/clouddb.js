// clouddb.js —— 微信云数据库（CloudBase DB）适配器
// ============================================================
// 本文件与 tencentdocs.js 暴露**完全相同**的 module.exports 契约（见文件末尾导出清单），
// 只是把底层存储从「腾讯文档智能表格 + HTTP/token」换成「CloudBase 云数据库」。
//
// 设计要点（与 tencentdocs.js 保持行为一致的约束）：
//   • 业务函数整段复用，仅改底层 6 个存储函数（getRecords/addRecord/updateRecord/
//     deleteRecordByIds/invalidateCache/cacheStats）+ 常量表（英文 key 映射）。
//   • COL 用英文恒等映射（COL.materials.stock='stock'），云库字段即英文 key；
//     业务函数通过 f[COL.x.y] 访问，等价于 f['英文key']。
//   • TR/ROLES 保持中文↔英文映射：云库**存储的是与腾讯文档同构的中文枚举值**
//     （待审批/借出中/入库…），业务函数读出后 TR.reqRev 转英文下发前端。
//     → 数据模型与腾讯文档完全同构，迁移（migrate）只需把中文列名重命名为英文 key、
//       值原样搬，零转换、可回滚。
//   • now() 返回 epoch 毫秒（与腾讯文档「日期列落库时间戳」语义一致），便于排序/报表。
//   • 腾讯文档「自动编号列」在云库无对应机制 → requisition/toolRequisition 改为本地 genNo 生成单号。
//
// 云库客户端：幂等 require('wx-server-sdk')；本地测试/环境缺失时降级为 __db=null，
// 通过 __setDbForTest 注入内存伪库以便单测（见 tools/test-clouddb-adapter.js）。

// —— 云数据库客户端初始化（失败不崩，交由 __db 判空与运行时告警）——
let __db = null
try {
  // 与 index.js 共用同一 wx-server-sdk 单例；cloud.init 幂等。
  const cloud = require('wx-server-sdk')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
  __db = cloud.database()
} catch (e) {
  console.warn('[clouddb] wx-server-sdk 初始化失败（本地测试或环境缺失）：', (e && e.message) || e)
}

// 测试/本地注入伪云库（实现 collection().get/add/doc().update/remove 的最小接口）
function __setDbForTest(db) { __db = db }

// 表名：云库集合名与业务键同名（users/materials/...）。业务函数传 'materials' 等字符串，
// 本适配器直接作为 collection 名使用。
const TABLE = {
  users: 'users',
  materials: 'materials',
  tools: 'tools',
  requisitions: 'requisitions',
  borrow: 'borrow',
  stock_io: 'stock_io',
  access: 'access',
  logs: 'logs',
  labs: 'labs',
  repairs: 'repairs',
  inspections: 'inspections'
}

// 云库字段用英文 key（与前端 / mock.js 完全一致）。
// 这是「恒等映射」：COL.materials.stock === 'stock'，业务函数 f[COL.materials.stock] === f['stock']。
const COL = {
  users: { id: 'id', name: 'name', role: 'role', cls: 'cls', status: 'status', openid: 'openid', robotKeyHash: 'robotKeyHash' },
  materials: { id: 'id', name: 'name', spec: 'spec', cat: 'cat', loc: 'loc', stock: 'stock', unit: 'unit', safe: 'safe', status: 'status', expire: 'expire' },
  tools: { id: 'id', name: 'name', spec: 'spec', loc: 'loc', status: 'status', holder: 'holder' },
  requisitions: { id: 'id', user: 'user', item: 'item', type: 'type', qty: 'qty', reason: 'reason', status: 'status', time: 'time', approver: 'approver', reject: 'reject' },
  borrow: { id: 'id', user: 'user', tool: 'tool', out: 'out', plan: 'plan', in: 'in', status: 'status' },
  stock_io: { id: 'id', item: 'item', dir: 'dir', qty: 'qty', op: 'op', time: 'time', note: 'note', src: 'src' },
  access: { id: 'id', user: 'user', point: 'point', time: 'time', result: 'result' },
  logs: { id: 'id', time: 'time', actor: 'actor', op: 'op', target: 'target', result: 'result' },
  // 实训室归属管理体系（位置维护 / 负责人 / 报修 / 巡检）。字段全英文 key（与前端、mock.js 一致）。
  labs: {
    id: 'id', name: 'name', campus: 'campus', building: 'building', floor: 'floor', roomNo: 'roomNo',
    address: 'address', lng: 'lng', lat: 'lat',
    managerId: 'managerId', managerName: 'managerName',
    status: 'status', note: 'note', createdAt: 'createdAt', updatedAt: 'updatedAt'
  },
  repairs: {
    id: 'id', labId: 'labId', labName: 'labName', title: 'title', category: 'category', desc: 'desc',
    reporterId: 'reporterId', reporterName: 'reporterName',
    status: 'status', priority: 'priority', handlerId: 'handlerId', handlerName: 'handlerName',
    resolvedNote: 'resolvedNote', createdAt: 'createdAt', updatedAt: 'updatedAt'
  },
  inspections: {
    id: 'id', labId: 'labId', labName: 'labName', title: 'title', planDate: 'planDate',
    executorId: 'executorId', executorName: 'executorName',
    status: 'status', result: 'result', createdAt: 'createdAt', doneAt: 'doneAt'
  }
}

// 角色契约：super > admin > teacher > student（与前端 identity.normalizeRole 共用）
const ROLES = ['student', 'teacher', 'admin', 'super']
const SUPER = 'super'
const ADMIN = 'admin'

// 中英状态翻译：云库存中文（与腾讯文档同构），前端用英文。双向映射。
const TR = {
  reqFwd: { pending: '待审批', approved: '已通过', rejected: '已拒绝', canceled: '已撤销' },
  reqRev: {
    '待审批': 'pending', '待审核': 'pending', '审批中': 'pending',
    '已通过': 'approved', '通过': 'approved', '同意': 'approved', '已同意': 'approved',
    '已拒绝': 'rejected', '拒绝': 'rejected', '不同意': 'rejected', '已驳回': 'rejected',
    '已撤销': 'canceled', '撤销': 'canceled', '已撤回': 'canceled',
    pending: 'pending', approved: 'approved', rejected: 'rejected', canceled: 'canceled'
  },
  borrowFwd: { out: '借出中', returned: '已归还' },
  borrowRev: { '借出中': '借出', '已归还': '已还', out: '借出', returned: '已还' },
  ioFwd: { in: '入库', out: '出库' },
  ioRev: { '入库': 'in', '出库': 'out', in: 'in', out: 'out' },
  role: { '学生': 'student', '教师': 'teacher', '管理员': 'admin', '超级管理员': 'super', 'student': 'student', 'teacher': 'teacher', 'admin': 'admin', 'super': 'super' },
  roleFwd: { student: '学生', teacher: '教师', admin: '管理员', super: '超级管理员', student: '学生', teacher: '教师', admin: '管理员', super: '超级管理员' }
}

// 云库无需腾讯文档那套 BASE/CLIENT_ID/TOKEN 配置。
const CFG = {}

// ============================================================
// 0. 时间/编号/格式化（与 tencentdocs 同语义）
// ============================================================
const DEFAULT_LOAN_DAYS = 7
function planDue(days) {
  const d = Math.min(90, Math.max(1, parseInt(days, 10) || DEFAULT_LOAN_DAYS))
  return Date.now() + d * 86400000
}
function nowParts() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }
}
// 云库模式下 now() 返回 epoch 毫秒（字符串时间列统一存数字，便于排序/报表/趋势图）。
function now() { return Date.now() }
function genNo(p) {
  const t = nowParts(); const q = n => ('' + n).padStart(2, '0')
  return `${p}${t.y}${q(t.mo)}${q(t.d)}${q(t.h)}${q(t.mi)}${Math.floor(Math.random() * 90 + 10)}`
}

// 日期字段：云库存 epoch 毫秒；读回时格式化为北京时间 YYYY-MM-DD HH:mm。
function fmtTs(v) {
  if (v === '' || v == null) return ''
  const s = '' + v
  if (/^\d{10,}$/.test(s)) {
    const d = new Date(Number(s) + 8 * 3600 * 1000)
    if (isNaN(d.getTime())) return s
    const p = n => ('' + n).padStart(2, '0')
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  }
  return s
}

// ============================================================
// 1. 存储层：缓存 / 锁 / 幂等 / 原子 CRUD（云库实现）
// ============================================================
const _cache = new Map()
let _writeSeq = 0

function invalidateCache(sheetKey) {
  _writeSeq++
  if (sheetKey) _cache.delete(sheetKey)
  else _cache.clear()
}
function cacheStats() {
  return { hit: 0, miss: 0, cachedTables: Array.from(_cache.keys()), ttl: 0 }
}

// 写串行化：所有写操作经同一 Promise 链互斥执行，避免并发读-算-写互相覆盖
let _writeChain = Promise.resolve()
function withWriteLock(fn) {
  const run = _writeChain.then(fn, fn)
  _writeChain = run.then(() => {}, () => {})
  return run
}

// 写操作幂等窗口：同一操作人在窗口期内对同一目标的同参数写入只执行第一笔。
const IDEM_WINDOW_MS = 5000
const _recentWrites = new Map()
function withWriteIdem(key, fn) {
  const t = Date.now()
  const hit = _recentWrites.get(key)
  if (hit && t - hit.t < IDEM_WINDOW_MS) return hit.p
  if (_recentWrites.size > 500) {
    for (const [k, v] of _recentWrites) if (t - v.t >= IDEM_WINDOW_MS) _recentWrites.delete(k)
  }
  const entry = { t, p: null }
  entry.p = (async () => {
    const r = await fn()
    if (r && r.code) _recentWrites.delete(key)
    return r
  })().catch(e => { _recentWrites.delete(key); throw e })
  _recentWrites.set(key, entry)
  entry.p.catch(() => {})
  return entry.p
}

// 列名→字段映射：云库无列概念，这里返回「该表所有英文列都存在」的恒等 map，
// 供 ensureOpenIdColumn / findUserByOpenId 的列存在性检查通过（openid 始终是普通字段）。
function getFieldMap(sheetKey) {
  const col = COL[sheetKey] || {}
  const map = {}
  for (const k of Object.keys(col)) map[col[k]] = { id: k, type: 1 }
  return map
}
function clearFieldMapCache() { /* 云库无字段缓存，no-op */ }
// 预热字段映射：云库不需要，no-op
async function warmFieldMaps() {}

// 值转换：云库直接存原始值（字符串/数字），恒等透传。
async function buildValues(sheetKey, fieldsMap) { return fieldsMap }

// 腾讯文档专属 API 桩（保持导出契约；云库模式下不真正调用）
async function getToken() { return '' }
async function authorizeWithCode() { throw new Error('云库模式不支持腾讯文档授权') }
async function callSmart() { return {} }
async function callApi() { return {} }

// 查：云库全量取 → 返回 {recordId, fields} 形状（与腾讯文档适配器一致）
async function getRecords(sheetKey, filterFn, opts) {
  const o = opts || {}
  if (!__db) throw new Error('云数据库未初始化（请确认云函数已部署到 CloudBase 且环境正常）')
  const res = await __db.collection(sheetKey).get()
  const all = (res.data || []).map(d => {
    const { _id, _openid, ...fields } = d
    return { recordId: _id, fields }
  })
  if (o.recordIDs && o.recordIDs.length) return all.filter(r => o.recordIDs.indexOf(r.recordId) >= 0)
  return filterFn ? all.filter(filterFn) : all
}

async function addRecord(sheetKey, fieldsMap) {
  if (!__db) throw new Error('云数据库未初始化')
  const values = await buildValues(sheetKey, fieldsMap)
  const res = await __db.collection(sheetKey).add({ data: values })
  invalidateCache(sheetKey)
  return { recordId: res._id, fields: values }
}

async function updateRecord(sheetKey, recordId, fieldsMap) {
  if (!__db) throw new Error('云数据库未初始化')
  const values = await buildValues(sheetKey, fieldsMap)
  await __db.collection(sheetKey).doc(recordId).update({ data: values })
  invalidateCache(sheetKey)
  return { recordId, fields: values }
}

async function deleteRecordByIds(sheetKey, ids) {
  if (!__db) throw new Error('云数据库未初始化')
  const list = (ids || []).filter(Boolean)
  if (!list.length) return 0
  for (const id of list) {
    try { await __db.collection(sheetKey).doc(id).remove() } catch (e) { /* 单条失败不阻断其余 */ }
  }
  invalidateCache(sheetKey)
  return list.length
}

// 运行态自检：回显云库连接状态（供云端 diag 接口）
function runtimeInfo() {
  return {
    node: process.version,
    backend: 'cloud',
    dbReady: !!__db,
    hasFetch: typeof fetch === 'function',
    note: __db ? '腾讯云 CloudBase 数据库已连接' : '云数据库未初始化（本地测试或环境变量缺失）'
  }
}

// ============================================================
// 2. 读归一化（云库英文 key 字段 → 前端英文契约）
// ============================================================
function normMaterial(f) {
  const expTs = Number(f[COL.materials.expire]) || 0
  const ms = expTs ? (expTs - Date.now()) : null
  const DAYS = 86400000
  return {
    id: f[COL.materials.id], name: f[COL.materials.name], spec: f[COL.materials.spec] || '',
    cat: f[COL.materials.cat] || '', loc: f[COL.materials.loc] || '',
    stock: Number(f[COL.materials.stock]) || 0, unit: f[COL.materials.unit] || '',
    safe: Number(f[COL.materials.safe]) || 0, status: f[COL.materials.status] || '',
    expire: expTs ? fmtTs(f[COL.materials.expire]) : '',
    expired: !!(expTs && ms < 0),
    expiring: !!(expTs && ms >= 0 && ms <= 30 * DAYS)
  }
}
function normTool(f) {
  const sn = f['sn'] || f[COL.tools.spec] || ''
  return {
    id: f[COL.tools.id], name: f[COL.tools.name], spec: f[COL.tools.spec] || f['sn'] || '',
    sn, loc: f[COL.tools.loc] || '', status: f[COL.tools.status] || '',
    borrower: f[COL.tools.holder] || '', outTime: ''
  }
}
function normReq(f) {
  const type = f[COL.requisitions.type]
  const kind = ('' + (type || '')) === '借出' ? 'tool' : 'material'
  return {
    no: f[COL.requisitions.id], user: f[COL.requisitions.user],
    matId: f[COL.requisitions.item], toolId: f[COL.requisitions.item], kind,
    qty: Number(f[COL.requisitions.qty]) || 0,
    reason: f[COL.requisitions.reason] || '', reject: f[COL.requisitions.reject] || '',
    status: TR.reqRev[f[COL.requisitions.status]] || f[COL.requisitions.status] || '',
    time: fmtTs(f[COL.requisitions.time]) || ''
  }
}
function normBorrow(f) {
  const status = TR.borrowRev[f[COL.borrow.status]] || f[COL.borrow.status] || ''
  const planTs = Number(f[COL.borrow.plan]) || 0
  return {
    id: f[COL.borrow.id], user: f[COL.borrow.user], toolId: f[COL.borrow.tool],
    out: fmtTs(f[COL.borrow.out]) || '',
    plan: fmtTs(f[COL.borrow.plan]) || '', in: fmtTs(f[COL.borrow.in]) || '',
    status,
    overdue: status === '借出' && planTs > 0 && Date.now() > planTs
  }
}
function normUser(f) {
  const role = TR.role[f[COL.users.role]]
  return {
    id: ('' + (f[COL.users.id] || '')).trim(),
    name: ('' + (f[COL.users.name] || '')).trim(),
    role: (ROLES.indexOf(role) >= 0 ? role : 'student'),
    cls: ('' + (f[COL.users.cls] || '')).trim(),
    status: ('' + (f[COL.users.status] || '')).trim(),
    openid: ('' + (f[COL.users.openid] || '')).trim(),
    robotKeyHash: ('' + (f[COL.users.robotKeyHash] || '')).trim()
  }
}
function normStockIO(f) {
  return {
    no: f[COL.stock_io.id], matId: f[COL.stock_io.item],
    type: TR.ioRev[f[COL.stock_io.dir]] || 'in', qty: Number(f[COL.stock_io.qty]) || 0,
    operator: f[COL.stock_io.op] || '', time: fmtTs(f[COL.stock_io.time]) || '', note: f[COL.stock_io.note] || ''
  }
}
function normAccess(f) {
  return {
    time: fmtTs(f[COL.access.time]) || '', actor: f[COL.access.user] || '',
    door: f[COL.access.point] || '', result: f[COL.access.result] || ''
  }
}
function normLog(f) {
  return {
    time: fmtTs(f[COL.logs.time]) || '', actor: f[COL.logs.actor] || '',
    op: f[COL.logs.op] || '', target: f[COL.logs.target] || '', result: f[COL.logs.result] || ''
  }
}

// ============================================================
// 3. 业务函数（与 tencentdocs.js 同形，仅 requisition/toolRequisition/repairToolRow 适配云库）
// ============================================================
async function getItem(id) {
  const key = ('' + (id || '')).trim().toUpperCase()
  if (!key) return null
  const isTool = key.startsWith('T')
  const col = isTool ? COL.tools : COL.materials
  const list = await getRecords(isTool ? 'tools' : 'materials',
    r => ('' + r.fields[col.id]) === key)
  const rec = list[0]
  if (!rec) return null
  const base = isTool ? normTool(rec.fields) : normMaterial(rec.fields)
  return { type: isTool ? 'tool' : 'material', item: { ...base, rid: rec.recordId } }
}

async function listMaterials() {
  const list = await getRecords('materials')
  return list.map(r => normMaterial(r.fields))
}

async function listTools() {
  const list = await getRecords('tools')
  return list.map(r => normTool(r.fields))
}

async function search(kw) {
  const q = ('' + (kw || '')).trim().toLowerCase()
  if (!q) return []
  const [mats, tools] = await Promise.all([getRecords('materials'), getRecords('tools')])
  const out = []
  for (const r of mats) {
    const m = normMaterial(r.fields)
    const score = fuzzyScore(q, [m.id, m.name, m.spec, m.cat, m.loc, m.unit])
    if (score > 0) {
      const sub = [m.spec, m.unit, m.loc].filter(Boolean).join(' · ') || '耗材'
      out.push({ type: 'material', id: m.id, name: m.name, sub, stock: m.stock, score })
    }
  }
  for (const r of tools) {
    const t = normTool(r.fields)
    const score = fuzzyScore(q, [t.id, t.name, t.spec, t.sn, t.loc])
    if (score > 0) {
      const sub = [t.spec, t.loc].filter(Boolean).join(' · ') || '工具'
      out.push({ type: 'tool', id: t.id, name: t.name, sub, status: t.status, score })
    }
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, 12)
}

function fuzzyScore(q, fields) {
  let best = 0
  for (const f of fields) {
    const s = scoreOne(q, ('' + (f || '')).trim().toLowerCase())
    if (s > best) best = s
  }
  return best
}
function scoreOne(q, t) {
  const tk = t.replace(/\s+/g, '')
  if (!tk) return 0
  if (tk === q) return 1000
  if (tk.includes(q)) return 600 - Math.min(200, Math.abs(tk.length - q.length) * 10)
  let i = 0
  for (let j = 0; j < tk.length && i < q.length; j++) if (tk[j] === q[i]) i++
  if (i === q.length) return 300 - Math.min(200, tk.length)
  let present = 0
  for (const ch of q) if (tk.indexOf(ch) >= 0) present++
  if (q.length > 1 && present >= Math.ceil(q.length * 0.6)) return 100 + present * 2
  return 0
}

async function listMine(user) {
  const u = ('' + (user || '')).trim()
  if (!u) return { requisitions: [], borrow: [] }
  const rs = await getRecords('requisitions', r => ('' + (r.fields[COL.requisitions.user] || '')).trim() === u)
  const bs = await getRecords('borrow', r => ('' + (r.fields[COL.borrow.user] || '')).trim() === u)
  return { requisitions: rs.map(r => normReq(r.fields)), borrow: bs.map(r => normBorrow(r.fields)) }
}

async function listPending() {
  const list = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.status]) === '待审批')
  return list.map(r => normReq(r.fields))
}

// —— 登录鉴权 ——
function publicUser(u) {
  return u ? { id: u.id, name: u.name, role: u.role, cls: u.cls } : null
}
function userEnabled(u) {
  return !u.status || u.status === '启用'
}

async function findUser(id) {
  const key = ('' + (id || '')).trim().toUpperCase()
  if (!key) return null
  const list = await getRecords('users', r => ('' + (r.fields[COL.users.id] || '')).trim().toUpperCase() === key)
  const rec = list[0]
  if (!rec) return null
  const u = normUser(rec.fields)
  if (!userEnabled(u)) return null
  return { rid: rec.recordId, user: publicUser(u), openid: u.openid, robotKeyHash: u.robotKeyHash }
}

// 按机器人密钥哈希反查用户（可信机器通道用）。robotKeyHash 不存在/为空的用户一律不匹配。
async function findUserByRobotKey(hash) {
  if (!hash) return null
  const list = await getRecords('users', r => ('' + (r.fields[COL.users.robotKeyHash] || '')).trim() === ('' + hash).trim())
  const rec = list[0]
  if (!rec) return null
  const u = normUser(rec.fields)
  if (!userEnabled(u)) return null
  return { rid: rec.recordId, user: publicUser(u), openid: u.openid, robotKeyHash: u.robotKeyHash }
}

// 写入/清空某用户的机器人密钥哈希（hash 为空串表示吊销）。
async function setRobotKey(id, hash) {
  const fu = await findUser(id)
  if (!fu) return { code: 404, data: { msg: '用户不存在' } }
  await updateRecord('users', fu.rid, { [COL.users.robotKeyHash]: ('' + (hash || '')).trim() })
  return { ok: true }
}

async function listUsers() {
  const list = await getRecords('users')
  return list.map(r => normUser(r.fields)).filter(userEnabled).map(publicUser)
}

// openid 在云库是普通字段，始终存在 → 幂等 no-op
async function ensureOpenIdColumn() { return true }

async function bindOpenId(rid, openid) {
  if (!rid || !openid) return
  await updateRecord('users', rid, { [COL.users.openid]: openid })
}

async function findUserByOpenId(openid) {
  if (!openid) return null
  const map = getFieldMap('users')
  if (!map[COL.users.openid]) return null
  const list = await getRecords('users', r => ('' + (r.fields[COL.users.openid] || '')).trim() === ('' + openid).trim())
  const rec = list[0]
  if (!rec) return null
  const u = normUser(rec.fields)
  return userEnabled(u) ? publicUser(u) : null
}

async function whoami(openid) {
  return openid ? await findUserByOpenId(openid) : null
}

// —— 用户管理 ——
async function adminListUsers() {
  const list = await getRecords('users')
  return list
    .map(r => {
      const u = normUser(r.fields)
      return {
        rid: r.recordId,
        id: u.id,
        name: u.name,
        role: u.role,
        cls: u.cls,
        status: u.status,
        bound: !!(u.openid && ('' + u.openid).trim())
      }
    })
    .filter(u => !!(u.id && ('' + u.id).trim()))
}

function decideUserWrite(me, target) {
  const callerRole = me ? me.role : null
  const callerSuper = callerRole === SUPER
  const callerAdmin = callerSuper || callerRole === ADMIN
  if (!callerAdmin) return { code: 403, data: { msg: '仅管理员可操作' } }
  const existing = target.existingRole || 'student'
  const newRole = ('' + (target.role || '')).trim().toLowerCase()
  if (newRole === SUPER && !callerSuper) return { code: 403, data: { msg: '仅超级管理员可授予超级管理员' } }
  if (me && target.id && ('' + target.id).toUpperCase() === ('' + me.id).toUpperCase() && !callerSuper) {
    if (newRole && newRole !== existing) return { code: 400, data: { msg: '不能修改自己的角色（防止把自己锁在管理功能外）' } }
    if (target.statusChanging) return { code: 400, data: { msg: '不能修改自己的账号状态' } }
  }
  if (target.existingRole && (existing === ADMIN || existing === SUPER) && !callerSuper)
    return { code: 403, data: { msg: '仅超级管理员可管理管理员/超级管理员账号' } }
  return null
}

function decideUserDelete(me, existingRole, id) {
  const callerRole = me ? me.role : null
  const callerSuper = callerRole === SUPER
  const callerAdmin = callerSuper || callerRole === ADMIN
  if (!callerAdmin) return { code: 403, data: { msg: '仅管理员可操作' } }
  if (existingRole && (existingRole === ADMIN || existingRole === SUPER) && !callerSuper)
    return { code: 403, data: { msg: '仅超级管理员可删除管理员/超级管理员账号' } }
  if (me && id && ('' + id).toUpperCase() === ('' + me.id).toUpperCase())
    return { code: 400, data: { msg: '不能删除当前登录的账号' } }
  return null
}

async function adminUpsertUser(data, me) {
  return withWriteLock(async () => {
    data = data || {}
    const id = ('' + (data.id || '')).trim().toUpperCase()
    const name = ('' + (data.name || '')).trim()
    const role = ('' + (data.role || '')).trim().toLowerCase()
    const cls = ('' + (data.cls || '')).trim()
    const status = ('' + (data.status || '')).trim() || '启用'
    const rid = ('' + (data.rid || '')).trim()
    if (!id || !name) return { code: 400, data: { msg: '工号和姓名必填' } }
    if (ROLES.indexOf(role) < 0) return { code: 400, data: { msg: '角色必须是 student / teacher / admin / super 之一' } }
    if (status !== '启用' && status !== '停用') return { code: 400, data: { msg: '状态必须是 启用 / 停用' } }
    await ensureOpenIdColumn()

    const allUsers = await getRecords('users')
    const byId = allUsers.filter(r => ('' + (r.fields[COL.users.id] || '')).trim().toUpperCase() === id)
    if (byId.length > 1) return { code: 409, data: { msg: '工号 ' + id + ' 在表中存在多行（历史脏数据），请先合并后再操作' } }
    let rec = byId[0]
    if (rid) {
      const byRid = allUsers.find(r => r.recordId === rid)
      if (!byRid) return { code: 404, data: { msg: '要编辑的行不存在（可能已被删除），请刷新列表重试' } }
      if (rec && rec.recordId !== rid) return { code: 409, data: { msg: '工号 ' + id + ' 已被其他行占用，不能重复' } }
      rec = byRid
    }

    const su = rec ? normUser(rec.fields) : null
    const decision = decideUserWrite(me, {
      id,
      role,
      existingRole: su ? su.role : null,
      statusChanging: su ? (status !== (su.status || '启用')) : false
    })
    if (decision) return decision

    const fields = {
      [COL.users.id]: id,
      [COL.users.name]: name,
      [COL.users.role]: TR.roleFwd[role] || role,
      [COL.users.cls]: cls,
      [COL.users.status]: status
    }
    if (rec) {
      await updateRecord('users', rec.recordId, fields)
      return { id, updated: true }
    }
    await addRecord('users', fields)
    return { id, created: true }
  })
}

async function adminDeleteUser(data, me) {
  return withWriteLock(async () => {
    const id = ('' + (data && data.id || '')).trim().toUpperCase()
    if (!id) return { code: 400, data: { msg: '工号必填' } }
    const list = await getRecords('users', r => ('' + (r.fields[COL.users.id] || '')).trim().toUpperCase() === id)
    const rec = list[0]
    if (!rec) return { code: 404, data: { msg: '该工号不存在' } }
    const su = normUser(rec.fields)
    const decision = decideUserDelete(me, su.role, id)
    if (decision) return decision
    await deleteRecordByIds('users', [rec.recordId])
    return { id }
  })
}

async function bindLogin(data, openid) {
  return withWriteLock(async () => {
    if (!openid) return { code: 400, data: { msg: '未获取到微信身份，请在微信中打开小程序' } }
    const id = ('' + (data && data.id || '')).trim().toUpperCase()
    const name = ('' + (data && data.name || '')).trim()
    if (!id || !name) return { code: 400, data: { msg: '请输入姓名和工号' } }
    await ensureOpenIdColumn()
    const byId = await getRecords('users', r => ('' + (r.fields[COL.users.id] || '')).trim().toUpperCase() === id)
    const rec = byId[0]
    if (!rec) return { code: 404, data: { msg: '工号不存在，请联系管理员先在用户表录入' } }
    const u = normUser(rec.fields)
    if (u.status && u.status !== '启用') return { code: 400, data: { msg: '该账号未启用，请联系管理员' } }
    if (name !== ('' + (u.name || '')).trim()) return { code: 400, data: { msg: '姓名与工号不匹配，请核对后重试' } }
    if (u.openid && u.openid === openid) return { code: 0, data: publicUser(u) }
    if (u.openid && u.openid !== openid) return { code: 409, data: { msg: '该工号已绑定其他微信，无法重复绑定；如需换绑请联系管理员清空该工号的绑定' } }
    const byOpen = await getRecords('users', r => ('' + (r.fields[COL.users.openid] || '')).trim() === ('' + openid).trim())
    if (byOpen.length) {
      const other = normUser(byOpen[0].fields)
      return { code: 409, data: { msg: '此微信已绑定工号 ' + (other.id || '?') + '，一个微信只能绑定一个工号' } }
    }
    await updateRecord('users', rec.recordId, { [COL.users.openid]: openid })
    return { code: 0, data: publicUser(u) }
  })
}

async function readBackNo(rec, sheetKey, idCol) {
  if (!rec || !rec.recordId) return ''
  for (let i = 0; i < 3; i++) {
    const list = await getRecords(sheetKey, r => r.recordId === rec.recordId)
    if (list[0] && list[0].fields[idCol]) return list[0].fields[idCol]
    await new Promise(r => setTimeout(r, 300))
  }
  return ''
}

// 领用申请：云库无自动编号列 → 本地 genNo 生成单号写入 id 字段
async function requisition(data) {
  const matId = ('' + (data.matId || '')).trim()
  if (!matId) return { code: 400, data: { msg: '缺少物品ID，无法提交申请' } }
  const qty = Math.floor(Number(data.qty) || 0)
  if (qty < 1) return { code: 400, data: { msg: '数量必须是大于 0 的整数' } }
  const reason = ('' + (data.reason || '')).trim().slice(0, 60)
  if (!reason) return { code: 400, data: { msg: '请填写用途说明' } }
  const no = genNo('R')
  const idemKey = ['req', data.user || '', matId, qty].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
    if (!mats[0]) return { code: 400, data: { msg: '物品不存在：' + matId } }
    await addRecord('requisitions', {
      [COL.requisitions.id]: no, [COL.requisitions.user]: data.user, [COL.requisitions.item]: matId,
      [COL.requisitions.type]: '领用', [COL.requisitions.qty]: qty, [COL.requisitions.reason]: reason,
      [COL.requisitions.status]: '待审批', [COL.requisitions.time]: now(), [COL.requisitions.approver]: ''
    })
    await addRecord('logs', {
      [COL.logs.actor]: data.user, [COL.logs.op]: '提交领用申请', [COL.logs.target]: matId, [COL.logs.result]: '待审批'
    })
    return { no }
  }))
}

async function cancelReq(data) {
  return withWriteLock(async () => {
    const no = '' + (data.no || '')
    if (!no) return { code: 400, data: { msg: '缺少申请单号' } }
    const reqs = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.id]) === no)
    const req = reqs[0]
    if (!req) return { code: 404, data: { msg: '申请不存在：' + no } }
    const status = '' + (req.fields[COL.requisitions.status] || '')
    if (status !== '待审批') {
      return { code: 400, data: { msg: '仅待审批的申请可撤销（当前：' + (status || '未知') + '）' } }
    }
    const owner = ('' + (req.fields[COL.requisitions.user] || '')).trim().toUpperCase()
    const me = ('' + (data.user || '')).trim().toUpperCase()
    if (!owner || owner !== me) return { code: 403, data: { msg: '只能撤销本人提交的申请' } }
    await updateRecord('requisitions', req.recordId, { [COL.requisitions.status]: '已撤销' })
    await addRecord('logs', {
      [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: me,
      [COL.logs.op]: '撤销申请', [COL.logs.target]: no, [COL.logs.result]: '已撤销'
    })
    const nowRows = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.id]) === no, { noCache: true })
    if (('' + ((nowRows[0] && nowRows[0].fields[COL.requisitions.status]) || '')) !== '已撤销') {
      throw new Error('撤销未生效（申请 ' + no + '）。请刷新后重试；若反复失败请到控制台手动修改状态')
    }
    return {}
  })
}

// 工具借出申请：云库无自动编号列 → 本地 genNo 生成单号
async function toolRequisition(data) {
  const toolId = ('' + (data.toolId || '')).trim()
  if (!toolId) return { code: 400, data: { msg: '缺少工具ID，无法提交申请' } }
  const reason = ('' + (data.reason || '')).trim().slice(0, 60)
  if (!reason) return { code: 400, data: { msg: '请填写用途说明' } }
  const no = genNo('T')
  const idemKey = ['treq', data.user || '', toolId].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === toolId)
    if (!tools[0]) return { code: 400, data: { msg: '工具不存在：' + toolId } }
    await addRecord('requisitions', {
      [COL.requisitions.id]: no, [COL.requisitions.user]: data.user, [COL.requisitions.item]: toolId,
      [COL.requisitions.type]: '借出', [COL.requisitions.qty]: 1, [COL.requisitions.reason]: reason,
      [COL.requisitions.status]: '待审批', [COL.requisitions.time]: now(), [COL.requisitions.approver]: ''
    })
    await addRecord('logs', {
      [COL.logs.actor]: data.user, [COL.logs.op]: '提交工具借出申请', [COL.logs.target]: toolId, [COL.logs.result]: '待审批'
    })
    return { no }
  }))
}

async function approve(data) {
  return withWriteLock(async () => {
    const reqs = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.id]) === ('' + data.no))
    const req = reqs[0]
    if (!req) return { code: 404, data: { msg: '申请不存在：' + data.no } }
    if (('' + req.fields[COL.requisitions.status]) !== '待审批') return { code: 400, data: { msg: '该申请已处理' } }

    const isTool = ('' + (req.fields[COL.requisitions.type] || '')) === '借出'

    if (!data.ok) {
      const why = ('' + (data.reason || '')).trim().slice(0, 60)
      if (!why) return { code: 400, data: { msg: '请填写驳回原因，便于申请人改正后重新提交' } }
      await updateRecord('requisitions', req.recordId, {
        [COL.requisitions.status]: '已拒绝', [COL.requisitions.approver]: data.actor, [COL.requisitions.reject]: why
      })
      await addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor, [COL.logs.op]: '审批拒绝', [COL.logs.target]: data.no, [COL.logs.result]: '已拒绝' })
      return {}
    }

    if (isTool) {
      const toolId = '' + (req.fields[COL.requisitions.item] == null ? '' : req.fields[COL.requisitions.item])
      if (!toolId) return { code: 400, data: { msg: '该申请缺少工具ID，疑似脏数据（' + ('' + (req.fields[COL.requisitions.id] || '?')) + '），无法审批' } }
      const applicant = ('' + (req.fields[COL.requisitions.user] == null ? '' : req.fields[COL.requisitions.user])).trim()
      if (!applicant) return { code: 400, data: { msg: '该申请缺少申请人ID，疑似脏数据（' + ('' + (req.fields[COL.requisitions.id] || '?')) + '），无法审批' } }
      const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === toolId)
      const tool = tools[0]
      if (!tool) return { code: 400, data: { msg: '工具不存在：' + toolId } }
      if (('' + tool.fields[COL.tools.status]) !== '在库') return { code: 400, data: { msg: '该工具不在库' } }
      const borrowPayload = () => ({
        [COL.borrow.id]: genNo('B'), [COL.borrow.user]: applicant, [COL.borrow.tool]: toolId,
        [COL.borrow.out]: now(), [COL.borrow.plan]: planDue(data.days), [COL.borrow.in]: '', [COL.borrow.status]: '借出中'
      })
      await Promise.all([
        updateRecord('tools', tool.recordId, { [COL.tools.status]: '借出', [COL.tools.holder]: applicant }),
        updateRecord('requisitions', req.recordId, { [COL.requisitions.status]: '已通过', [COL.requisitions.approver]: data.actor }),
        addRecord('borrow', borrowPayload()),
        addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor, [COL.logs.op]: '审批通过工具借出', [COL.logs.target]: toolId, [COL.logs.result]: '已通过' })
      ])
      if (!(await verifyToolBorrow(req, toolId, tool, applicant, borrowPayload))) {
        throw new Error('审批未完全生效（申请 ' + data.no + ' / 工具 ' + toolId + '）：申请单、工具或借还记录有写入失败。请刷新后重试')
      }
      return {}
    }

    const matId = '' + (req.fields[COL.requisitions.item] == null ? '' : req.fields[COL.requisitions.item])
    if (!matId) return { code: 400, data: { msg: '该申请缺少物品ID，疑似脏数据（' + ('' + (req.fields[COL.requisitions.id] || '?')) + '），无法审批，请在控制台删除该记录' } }
    const qty = Number(req.fields[COL.requisitions.qty]) || 0
    const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
    const mat = mats[0]
    if (!mat) return { code: 400, data: { msg: '物品不存在：' + matId } }
    const cur = Number(mat.fields[COL.materials.stock]) || 0
    if (cur < qty) return { code: 400, data: { msg: `库存不足：当前 ${cur}，申请 ${qty}` } }
    if (qty < 1) return { code: 400, data: { msg: '该申请的数量异常（' + qty + '），疑似脏数据，无法审批，请在控制台删除该记录' } }
    const applicant = ('' + (req.fields[COL.requisitions.user] == null ? '' : req.fields[COL.requisitions.user])).trim() || data.actor
    const note = '领用申请 ' + ('' + (req.fields[COL.requisitions.id] || data.no))
    const outFlow = {
      [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: matId,
      [COL.stock_io.dir]: '出库', [COL.stock_io.qty]: qty,
      [COL.stock_io.op]: applicant, [COL.stock_io.time]: now(), [COL.stock_io.note]: note, [COL.stock_io.src]: '领用出库'
    }
    await Promise.all([
      updateRecord('materials', mat.recordId, { [COL.materials.stock]: cur - qty }),
      updateRecord('requisitions', req.recordId, { [COL.requisitions.status]: '已通过', [COL.requisitions.approver]: data.actor }),
      addRecord('stock_io', outFlow),
      addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor, [COL.logs.op]: '审批通过', [COL.logs.target]: data.no, [COL.logs.result]: '已通过' })
    ])
    if (!(await verifyStock(matId, cur - qty))) {
      throw new Error('审批未完全生效（申请 ' + data.no + '）：库存可能未扣减。请刷新后重试')
    }
    if (!(await verifyReqApproved(req))) {
      throw new Error('审批未完全生效（申请 ' + data.no + '）：申请单状态可能未更新。请刷新审批列表后重试')
    }
    if (!(await verifyReqOutFlow(outFlow, matId))) {
      throw new Error('审批已生效但出库流水写入失败（申请 ' + data.no + ' / 物品 ' + matId + '）。请重试以补记流水')
    }
    return {}
  })
}

async function addMaterial(data) {
  const name = ('' + (data.name || '')).trim()
  if (!name) return { code: 400, data: { msg: '请填写物品名称' } }
  const unit = ('' + (data.unit || '')).trim() || '个'
  const qty = Number(data.qty) || 0
  if (qty < 0) return { code: 400, data: { msg: '数量不能为负数' } }
  const idemKey = ['addMat', data.actor || '', name, qty].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const exists = await getRecords('materials', r => ('' + r.fields[COL.materials.name]).trim() === name)
    if (exists.length) {
      const ex = exists[0].fields
      return { code: 409, data: { msg: '该物品已存在：' + ex[COL.materials.id] + '，请直接在出入库登记中选择它', matId: ex[COL.materials.id] } }
    }
    const all = await getRecords('materials')
    let max = 0
    for (const r of all) {
      const m = /^\s*[Mm](\d+)\s*$/.exec('' + r.fields[COL.materials.id])
      if (m) max = Math.max(max, parseInt(m[1], 10) || 0)
    }
    const newId = 'M' + String(max + 1).padStart(3, '0')
    await addRecord('materials', {
      [COL.materials.id]: newId,
      [COL.materials.name]: name,
      [COL.materials.spec]: ('' + (data.spec || '')).trim(),
      [COL.materials.cat]: ('' + (data.cat || '')).trim() || '电子元件',
      [COL.materials.loc]: ('' + (data.loc || '')).trim(),
      [COL.materials.stock]: qty,
      [COL.materials.unit]: unit,
      [COL.materials.safe]: Number(data.safe) || 0,
      [COL.materials.status]: '正常'
    })
    if (qty > 0) {
      await Promise.all([
        addRecord('stock_io', {
          [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: newId,
          [COL.stock_io.dir]: TR.ioFwd.in || '入库', [COL.stock_io.qty]: qty,
          [COL.stock_io.op]: data.actor || '', [COL.stock_io.time]: now(),
          [COL.stock_io.note]: '建档入库', [COL.stock_io.src]: '建档入库'
        }),
        addRecord('logs', {
          [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor || '',
          [COL.logs.op]: '新增耗材', [COL.logs.target]: newId, [COL.logs.result]: '建档成功'
        })
      ])
    }
    return { id: newId, name, stock: qty, unit }
  }))
}

async function io(data) {
  const matId = ('' + data.matId || '').trim()
  if (!matId) return { code: 400, data: { msg: '请选择耗材' } }
  if (data.type !== 'in' && data.type !== 'out') return { code: 400, data: { msg: '登记方向必须是 in / out' } }
  const qty = Math.floor(Number(data.qty) || 0)
  if (qty < 1) return { code: 400, data: { msg: '数量必须是大于 0 的整数' } }
  const idemKey = ['io', data.actor || '', matId, data.type, qty].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
    const mat = mats[0]
    if (!mat) return { code: 400, data: { msg: '物品不存在：' + matId } }
    const delta = (data.type === 'in' ? 1 : -1) * qty
    const cur = Number(mat.fields[COL.materials.stock]) || 0
    const next = cur + delta
    if (next < 0) return { code: 400, data: { msg: `库存不足：当前 ${cur}` } }
    await Promise.all([
      updateRecord('materials', mat.recordId, { [COL.materials.stock]: next }),
      addRecord('stock_io', {
        [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: matId,
        [COL.stock_io.dir]: TR.ioFwd[data.type] || '入库', [COL.stock_io.qty]: qty,
        [COL.stock_io.op]: data.actor, [COL.stock_io.time]: now(), [COL.stock_io.note]: data.note || '',
        [COL.stock_io.src]: data.src || (data.type === 'in' ? '手动入库' : '手动出库')
      }),
      addRecord('logs', {
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor,
        [COL.logs.op]: data.type === 'in' ? '入库登记' : '出库登记', [COL.logs.target]: matId, [COL.logs.result]: '成功'
      })
    ])
    if (!(await verifyStock(matId, next))) {
      throw new Error('库存更新未生效（期望 ' + next + '）。请到控制台核对「当前库存」列后重试')
    }
    return {}
  }))
}

async function verifyReqOutFlow(outFlow, matId) {
  const note = '' + (outFlow[COL.stock_io.note] || '')
  const exists = async () => {
    const rows = await getRecords('stock_io', null, { noCache: true })
    return rows.some(r => ('' + (r.fields[COL.stock_io.note] || '')) === note)
  }
  if (await exists()) return true
  try { await addRecord('stock_io', outFlow) } catch (e) { /* 下一轮再验 */ }
  return exists()
}

async function verifyStock(matId, expect) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const rows = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId, { noCache: true })
    const rec = rows[0]
    const cur = Number(rec && rec.fields[COL.materials.stock]) || 0
    if (cur === expect) return true
    if (attempt === 1 && rec) {
      try { await updateRecord('materials', rec.recordId, { [COL.materials.stock]: expect }) } catch (e) { /* 下一轮再验 */ }
    }
  }
  return false
}

async function verifyReqApproved(req) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const rows = await getRecords('requisitions', r => r.recordId === req.recordId, { noCache: true })
    const rec = rows[0]
    if (rec && ('' + rec.fields[COL.requisitions.status]) === '已通过') return true
    if (attempt === 1 && rec) {
      try { await updateRecord('requisitions', rec.recordId, { [COL.requisitions.status]: '已通过' }) } catch (e) { /* 下一轮再验 */ }
    }
  }
  return false
}

async function verifyToolOut(toolId, tool, holder, makeBorrow) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === toolId, { noCache: true })
    const okTool = tools[0] && ('' + tools[0].fields[COL.tools.status]) === '借出'
    const borrows = await getRecords('borrow', r => ('' + r.fields[COL.borrow.tool]) === toolId && ('' + r.fields[COL.borrow.status]) === '借出中')
    const okBorrow = borrows.length > 0
    if (okTool && okBorrow) return true
    if (attempt === 1) {
      try {
        if (!okTool) await updateRecord('tools', tool.recordId, { [COL.tools.status]: '借出', [COL.tools.holder]: holder })
        if (!okBorrow) {
          console.warn('[clouddb] verifyToolOut 补写借还记录：' + toolId)
          await addRecord('borrow', makeBorrow())
        }
      } catch (e) { /* 下一轮再验 */ }
    }
  }
  return false
}

async function verifyToolBorrow(req, toolId, tool, applicant, makeBorrow) {
  if (!(await verifyReqApproved(req))) return false
  return verifyToolOut(toolId, tool, applicant, makeBorrow)
}

async function batchIo(data) {
  const actor = '' + (data.actor || '')
  const type = data.type === 'out' ? 'out' : 'in'
  const items = Array.isArray(data.items) ? data.items : []
  if (!items.length) return { code: 400, data: { msg: '没有需要登记的物品' } }
  const merged = new Map()
  for (const it of items) {
    const matId = ('' + (it.matId || '')).trim()
    if (!matId) continue
    const qty = Math.floor(Number(it.qty) || 0)
    if (qty < 1) return { code: 400, data: { msg: '数量必须是大于 0 的整数：' + matId } }
    merged.set(matId, (merged.get(matId) || 0) + qty)
  }
  if (!merged.size) return { code: 400, data: { msg: '没有有效的登记数据' } }
  const idemKey = ['batchIo', actor, type].concat([...merged.entries()].map(([k, v]) => k + ':' + v)).join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const details = []
    let done = 0
    for (const [matId, qty] of merged) {
      const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
      const mat = mats[0]
      if (!mat) { details.push({ matId, qty, err: '物品不存在' }); continue }
      const cur = Number(mat.fields[COL.materials.stock]) || 0
      const next = cur + (type === 'in' ? 1 : -1) * qty
      if (next < 0) { details.push({ matId, qty, err: '库存不足（当前 ' + cur + '）' }); continue }
      await Promise.all([
        updateRecord('materials', mat.recordId, { [COL.materials.stock]: next }),
        addRecord('stock_io', {
          [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: matId,
          [COL.stock_io.dir]: type === 'in' ? '入库' : '出库', [COL.stock_io.qty]: qty,
          [COL.stock_io.op]: actor, [COL.stock_io.time]: now(), [COL.stock_io.note]: data.note || '',
          [COL.stock_io.src]: data.src || '批量入库'
        })
      ])
      if (!(await verifyStock(matId, next))) {
        details.push({ matId, qty, err: '库存回读失败' }); continue
      }
      done++
      details.push({ matId, name: mat.fields[COL.materials.name] || '', qty, stock: next })
    }
    await addRecord('logs', {
      [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: actor,
      [COL.logs.op]: type === 'in' ? '批量入库' : '批量出库',
      [COL.logs.target]: merged.size + ' 项', [COL.logs.result]: '成功 ' + done + ' 项'
    })
    return { type, done, failed: details.filter(d => d.err).length, details }
  }))
}

async function listStockIO(data) {
  const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
  const recs = await getRecords('stock_io')
  const valid = recs.filter(r => {
    const f = r.fields
    return (f[COL.stock_io.item] || '') && (f[COL.stock_io.dir] || '')
  })
  const kw = ('' + (data.op || '')).trim().toUpperCase()
  const item = ('' + (data.item || '')).trim().toUpperCase()
  const dir = ('' + (data.dir || '')).trim()
  const from = Number(data.from) || 0
  const to = Number(data.to) || 0
  const filtered = valid.filter(r => {
    const f = r.fields
    if (item && ('' + f[COL.stock_io.item]).trim().toUpperCase().indexOf(item) < 0) return false
    if (dir && ('' + f[COL.stock_io.dir]) !== dir) return false
    if (kw && (('' + (f[COL.stock_io.op] || '')).trim().toUpperCase().indexOf(kw) < 0)) return false
    const t = Number(f[COL.stock_io.time]) || 0
    if (from && t && t < from) return false
    if (to && t && t > to) return false
    return true
  })
  filtered.sort((a, b) => ('' + (b.fields[COL.stock_io.time] || '')).localeCompare('' + (a.fields[COL.stock_io.time] || '')))
  const total = filtered.length
  const offset = Math.max(0, Number(data.offset) || 0)
  const pageRows = filtered.slice(offset, offset + limit)
  const rows = pageRows.map(r => {
    const f = r.fields
    return {
      id: f[COL.stock_io.id] || '',
      item: f[COL.stock_io.item] || '',
      dir: f[COL.stock_io.dir] || '',
      qty: Number(f[COL.stock_io.qty]) || 0,
      op: f[COL.stock_io.op] || '',
      time: fmtTs(f[COL.stock_io.time]) || '',
      note: f[COL.stock_io.note] || '',
      src: f[COL.stock_io.src] || '',
      reversed: ('' + (f[COL.stock_io.note] || '')).indexOf('[已冲销]') >= 0
    }
  })
  const mats = await getRecords('materials')
  const nameMap = {}
  for (const r of mats) nameMap['' + r.fields[COL.materials.id]] = r.fields[COL.materials.name] || ''
  rows.forEach(r => { r.itemName = nameMap[r.item] || r.item })
  return {
    rows,
    total,
    offset,
    limit,
    hasMore: offset + rows.length < total,
    inQty: filtered.reduce((s, r) => s + (('' + r.fields[COL.stock_io.dir]) === '入库' ? (Number(r.fields[COL.stock_io.qty]) || 0) : 0), 0),
    outQty: filtered.reduce((s, r) => s + (('' + r.fields[COL.stock_io.dir]) === '出库' ? (Number(r.fields[COL.stock_io.qty]) || 0) : 0), 0)
  }
}

async function listLogs(data) {
  const recs = await getRecords('logs')
  const actor = ('' + (data.actor || '')).trim().toUpperCase()
  const op = ('' + (data.op || '')).trim()
  const target = ('' + (data.target || '')).trim().toUpperCase()
  const from = Number(data.from) || 0
  const to = Number(data.to) || 0
  const filtered = recs.filter(r => {
    const f = r.fields
    if (actor && ('' + (f[COL.logs.actor] || '')).trim().toUpperCase().indexOf(actor) < 0) return false
    if (op && ('' + (f[COL.logs.op] || '')) !== op) return false
    if (target && ('' + (f[COL.logs.target] || '')).trim().toUpperCase().indexOf(target) < 0) return false
    const t = Number(f[COL.logs.time]) || 0
    if (from && t && t < from) return false
    if (to && t && t > to) return false
    return true
  })
  filtered.sort((a, b) => ('' + (b.fields[COL.logs.time] || '')).localeCompare('' + (a.fields[COL.logs.time] || '')))
  const total = filtered.length
  const offset = Math.max(0, Number(data.offset) || 0)
  const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
  const rows = filtered.slice(offset, offset + limit).map(r => {
    const f = r.fields
    return {
      id: f[COL.logs.id] || '', time: fmtTs(f[COL.logs.time]) || '',
      actor: f[COL.logs.actor] || '', op: f[COL.logs.op] || '',
      target: f[COL.logs.target] || '', result: f[COL.logs.result] || ''
    }
  })
  return { rows, total, offset, limit, hasMore: offset + rows.length < total }
}

async function listAccess(data) {
  const recs = await getRecords('access')
  const user = ('' + (data.user || '')).trim().toUpperCase()
  const point = ('' + (data.point || '')).trim()
  const from = Number(data.from) || 0
  const to = Number(data.to) || 0
  const filtered = recs.filter(r => {
    const f = r.fields
    if (user && ('' + (f[COL.access.user] || '')).trim().toUpperCase().indexOf(user) < 0) return false
    if (point && ('' + (f[COL.access.point] || '')) !== point) return false
    const t = Number(f[COL.access.time]) || 0
    if (from && t && t < from) return false
    if (to && t && t > to) return false
    return true
  })
  filtered.sort((a, b) => ('' + (b.fields[COL.access.time] || '')).localeCompare('' + (a.fields[COL.access.time] || '')))
  const total = filtered.length
  const offset = Math.max(0, Number(data.offset) || 0)
  const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
  const rows = filtered.slice(offset, offset + limit).map(r => {
    const f = r.fields
    return {
      id: f[COL.access.id] || '', time: fmtTs(f[COL.access.time]) || '',
      user: f[COL.access.user] || '', point: f[COL.access.point] || '',
      result: f[COL.access.result] || ''
    }
  })
  return { rows, total, offset, limit, hasMore: offset + rows.length < total }
}

async function reverseIO(data) {
  const no = '' + (data.no || '')
  if (!no) return { code: 400, data: { msg: '缺少流水号' } }
  return withWriteLock(async () => {
    const list = await getRecords('stock_io', r => ('' + r.fields[COL.stock_io.id]) === no)
    const rec = list[0]
    if (!rec) return { code: 404, data: { msg: '流水不存在：' + no } }
    const f = rec.fields
    if (('' + (f[COL.stock_io.note] || '')).indexOf('[已冲销]') >= 0) {
      return { code: 400, data: { msg: '该流水已冲销过，不可重复冲销' } }
    }
    const matId = '' + (f[COL.stock_io.item] || '')
    const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
    const mat = mats[0]
    if (!mat) return { code: 400, data: { msg: '关联物品不存在：' + matId } }
    const qty = Number(f[COL.stock_io.qty]) || 0
    const dir = '' + (f[COL.stock_io.dir] || '')
    if (dir !== '入库' && dir !== '出库') return { code: 400, data: { msg: '该流水方向异常，无法冲销：' + (dir || '空') } }
    const backDir = dir === '入库' ? '出库' : '入库'
    const stock = Number(mat.fields[COL.materials.stock]) || 0
    const next = dir === '入库' ? stock - qty : stock + qty
    if (next < 0) return { code: 400, data: { msg: '冲销后库存为负（当前 ' + stock + '，需退回 ' + qty + '）' } }
    await Promise.all([
      updateRecord('materials', mat.recordId, { [COL.materials.stock]: next }),
      updateRecord('stock_io', rec.recordId, { [COL.stock_io.note]: '[已冲销] ' + (f[COL.stock_io.note] || '') }),
      addRecord('stock_io', {
        [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: matId,
        [COL.stock_io.dir]: backDir, [COL.stock_io.qty]: qty,
        [COL.stock_io.op]: data.actor, [COL.stock_io.time]: now(),
        [COL.stock_io.note]: '冲销流水 ' + no, [COL.stock_io.src]: '冲销'
      }),
      addRecord('logs', {
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor,
        [COL.logs.op]: '冲销出入库流水', [COL.logs.target]: no, [COL.logs.result]: '已冲销'
      })
    ])
    if (!(await verifyStock(matId, next))) {
      throw new Error('冲销未完全生效（流水 ' + no + '）：库存可能未回滚。请刷新后重试')
    }
    return { no, item: matId, dir: backDir, qty, stock: next }
  })
}

async function borrow(data) {
  return withWriteLock(async () => {
    const toolId = ('' + (data.toolId || '')).trim()
    if (!toolId) return { code: 400, data: { msg: '缺少工具ID' } }
    const user = ('' + (data.user || '')).trim()
    if (!user) return { code: 400, data: { msg: '缺少借用人' } }
    const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === toolId)
    const tool = tools[0]
    if (!tool) return { code: 400, data: { msg: '工具不存在：' + toolId } }
    if (('' + tool.fields[COL.tools.status]) !== '在库') {
      return { code: 400, data: { msg: '该工具不在库（当前：' + (tool.fields[COL.tools.status] || '未知') + '）' } }
    }
    const borrowPayload = () => ({
      [COL.borrow.id]: genNo('B'), [COL.borrow.user]: user, [COL.borrow.tool]: toolId,
      [COL.borrow.out]: now(), [COL.borrow.plan]: planDue(data.days), [COL.borrow.in]: '', [COL.borrow.status]: '借出中'
    })
    await Promise.all([
      updateRecord('tools', tool.recordId, { [COL.tools.status]: '借出', [COL.tools.holder]: user }),
      addRecord('borrow', borrowPayload()),
      addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: user, [COL.logs.op]: '借出工具', [COL.logs.target]: toolId, [COL.logs.result]: '借出中' })
    ])
    if (!(await verifyToolOut(toolId, tool, user, borrowPayload))) {
      throw new Error('借出未完全生效（工具 ' + toolId + '）。请刷新后重试')
    }
    return {}
  })
}

async function returnTool(data) {
  return withWriteLock(async () => {
    const toolId = '' + (data.toolId || '')
    const list = await getRecords('borrow', r =>
      ('' + r.fields[COL.borrow.tool]) === toolId && ('' + r.fields[COL.borrow.status]) === '借出中')
    const rec = list[0]
    const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === toolId)
    const tool = tools[0]
    const toolStatus = tool ? ('' + (tool.fields[COL.tools.status] || '')) : ''
    const needRepair = !!tool && toolStatus === '借出'
    if (!rec && !needRepair) {
      throw new Error('没有可归还的记录：' + toolId +
        (tool ? '（当前状态：' + (toolStatus || '未知') + '）' : '（工具不存在）'))
    }
    if (needRepair) await repairToolRow('tools', tool.recordId)
    if (rec) {
      await updateRecord('borrow', rec.recordId, { [COL.borrow.status]: '已归还', [COL.borrow.in]: now() })
    } else {
      console.warn('[clouddb] returnTool 自愈：' + toolId + ' 无「借出中」借还记录，已直接修复工具行')
    }
    await addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor, [COL.logs.op]: '归还工具', [COL.logs.target]: toolId, [COL.logs.result]: '已归还' })
    return { healed: !rec }
  })
}

function isBlank(v) {
  if (v === '' || v === null || v === undefined) return true
  if (Array.isArray(v)) return !v.length || v.every(x => !x || x.text === '' || x.text == null)
  if (typeof v === 'object' && 'text' in v) return !v.text
  return false
}

// 工具行修回「在库」并清空「当前持有人」：云库直接存空字符串（无需腾讯文档的文本数组 hack）
async function repairToolRow(sheetKey, recordId) {
  let lastErr = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await updateRecord(sheetKey, recordId, {
        [COL.tools.status]: '在库',
        [COL.tools.holder]: ''
      })
    } catch (e) { lastErr = e && e.message }
    const rows = await getRecords(sheetKey, r => r.recordId === recordId, { noCache: true })
    const f = rows[0] ? rows[0].fields : {}
    if (('' + (f[COL.tools.status] || '')) === '在库' && isBlank(f[COL.tools.holder])) return true
    if (!lastErr) lastErr = '状态=' + (f[COL.tools.status] || '(空)') + ' 持有人=' + JSON.stringify(f[COL.tools.holder])
  }
  throw new Error('工具行更新未生效（' + lastErr + '）。请到控制台把该行「状态」改为在库、「当前持有人」清空')
}

async function access(data) {
  await addRecord('access', {
    [COL.access.id]: genNo('A'), [COL.access.user]: data.user || data.actor,
    [COL.access.point]: data.door || '实训室门', [COL.access.time]: now(),
    [COL.access.result]: data.result || '开门'
  })
  return {}
}

// ============================================================
// 导出（P1-⑩）：拼 CSV 文本
// ============================================================
function csvCell(v) {
  const s = (v === null || v === undefined) ? '' : '' + v
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
function csvLines(header, rows) {
  return [header.map(csvCell).join(',')].concat(rows.map(r => r.map(csvCell).join(','))).join('\r\n')
}
function csvToday() {
  const t = nowParts(); const q = n => ('' + n).padStart(2, '0')
  return '' + t.y + q(t.mo) + q(t.d)
}

async function exportData(data) {
  const kind = ('' + (data.kind || 'materials')).trim()
  const today = csvToday()
  const bj = (t) => fmtTs(t) || ''
  let header = [], rows = [], name = kind

  if (kind === 'materials') {
    const list = await getRecords('materials')
    header = ['耗材ID', '名称', '规格', '类别', '存放位置', '当前库存', '单位', '预警线']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.materials.id], f[COL.materials.name], f[COL.materials.spec] || '', f[COL.materials.cat] || '',
      f[COL.materials.loc] || '', Number(f[COL.materials.stock]) || 0, f[COL.materials.unit] || '',
      Number(f[COL.materials.safe]) || 0
    ] })
    name = '耗材库存清单'
  } else if (kind === 'tools') {
    const list = await getRecords('tools')
    header = ['工具ID', '名称', '规格', '存放位置', '状态', '当前持有人']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.tools.id], f[COL.tools.name], f[COL.tools.spec] || '', f[COL.tools.loc] || '',
      f[COL.tools.status] || '', f[COL.tools.holder] || ''
    ] })
    name = '工具台账'
  } else if (kind === 'stock_io') {
    const list = await getRecords('stock_io')
    const mats = await getRecords('materials')
    const nm = {}
    for (const r of mats) nm['' + r.fields[COL.materials.id]] = r.fields[COL.materials.name] || ''
    header = ['流水ID', '物品ID', '物品名称', '方向', '数量', '操作人', '操作时间', '来源类型', '备注']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.stock_io.id], f[COL.stock_io.item], nm['' + f[COL.stock_io.item]] || '',
      f[COL.stock_io.dir] || '', Number(f[COL.stock_io.qty]) || 0, f[COL.stock_io.op] || '',
      bj(f[COL.stock_io.time]), f[COL.stock_io.src] || '', f[COL.stock_io.note] || ''
    ] })
    name = '出入库流水'
  } else if (kind === 'requisitions') {
    const list = await getRecords('requisitions')
    header = ['申请ID', '申请人ID', '物品ID', '类型', '数量', '用途说明', '状态', '申请时间', '审批人', '驳回原因']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.requisitions.id], f[COL.requisitions.user], f[COL.requisitions.item], f[COL.requisitions.type] || '',
      Number(f[COL.requisitions.qty]) || 0, f[COL.requisitions.reason] || '', f[COL.requisitions.status] || '',
      bj(f[COL.requisitions.time]), f[COL.requisitions.approver] || '', f[COL.requisitions.reject] || ''
    ] })
    name = '领用申请单'
  } else if (kind === 'borrow') {
    const list = await getRecords('borrow')
    header = ['借还ID', '借用人ID', '工具ID', '借出时间', '计划归还', '实际归还', '状态']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.borrow.id], f[COL.borrow.user], f[COL.borrow.tool], bj(f[COL.borrow.out]),
      bj(f[COL.borrow.plan]), bj(f[COL.borrow.in]), f[COL.borrow.status] || ''
    ] })
    name = '工具借用记录'
  } else if (kind === 'access') {
    const list = await getRecords('access')
    header = ['记录ID', '用户ID', '门禁点', '刷卡时间', '结果']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.access.id], f[COL.access.user], f[COL.access.point] || '', bj(f[COL.access.time]), f[COL.access.result] || ''
    ] })
    name = '门禁记录'
  } else if (kind === 'logs') {
    const list = await getRecords('logs')
    header = ['日志ID', '时间', '操作人', '操作类型', '对象', '结果']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.logs.id], bj(f[COL.logs.time]), f[COL.logs.actor] || '', f[COL.logs.op] || '',
      f[COL.logs.target] || '', f[COL.logs.result] || ''
    ] })
    name = '操作日志'
  } else {
    return { code: 400, data: { msg: '不支持的导出类型：' + kind } }
  }

  return {
    filename: name + '_' + today + '.csv',
    count: rows.length,
    csv: '\uFEFF' + csvLines(header, rows)
  }
}

async function stocktake(data) {
  const mode = ('' + (data.mode || 'stocktake')) === 'opening' ? 'opening' : 'stocktake'
  const actor = '' + (data.actor || '')
  const items = Array.isArray(data.items) ? data.items : []
  if (!items.length) return { code: 400, data: { msg: '没有需要处理的物品' } }
  const clean = []
  for (const it of items) {
    const matId = ('' + (it.matId || '')).trim()
    if (!matId) continue
    const real = Math.floor(Number(it.real))
    if (!Number.isFinite(real) || real < 0) {
      return { code: 400, data: { msg: '实盘数量必须是不小于 0 的整数：' + matId } }
    }
    clean.push({ matId, real })
  }
  if (!clean.length) return { code: 400, data: { msg: '没有有效的实盘数据' } }

  const idemKey = ['stocktake', mode, actor].concat(clean.map(i => i.matId + ':' + i.real)).join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const stamp = csvToday()
    const note = (id) => mode === 'opening'
      ? '期初建账 ' + stamp + '（' + id + '）'
      : '盘点调整 ' + stamp + '（' + id + '）'
    const details = []
    let adjusted = 0, unchanged = 0

    for (const it of clean) {
      const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === it.matId)
      const mat = mats[0]
      if (!mat) { details.push({ matId: it.matId, err: '物品不存在' }); continue }
      const book = Number(mat.fields[COL.materials.stock]) || 0
      const diff = it.real - book
      if (diff === 0) { unchanged++; details.push({ matId: it.matId, book, real: it.real, diff: 0 }); continue }
      const next = it.real
      if (next < 0) { details.push({ matId: it.matId, err: '调整后为负，已跳过' }); continue }
      await Promise.all([
        updateRecord('materials', mat.recordId, { [COL.materials.stock]: next }),
        addRecord('stock_io', {
          [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: it.matId,
          [COL.stock_io.dir]: diff > 0 ? '入库' : '出库', [COL.stock_io.qty]: Math.abs(diff),
          [COL.stock_io.op]: actor, [COL.stock_io.time]: now(), [COL.stock_io.note]: note(it.matId),
          [COL.stock_io.src]: mode === 'opening' ? '期初建账' : '盘点调整'
        })
      ])
      if (!(await verifyStock(it.matId, next))) {
        details.push({ matId: it.matId, book, real: it.real, diff, err: '库存回读失败' }); continue
      }
      adjusted++
      details.push({ matId: it.matId, name: mat.fields[COL.materials.name] || '', book, real: it.real, diff })
    }

    await addRecord('logs', {
      [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: actor,
      [COL.logs.op]: mode === 'opening' ? '期初建账' : '库存盘点',
      [COL.logs.target]: clean.length + ' 项', [COL.logs.result]: '调整 ' + adjusted + ' 项'
    })
    return { mode, adjusted, unchanged, details }
  }))
}

async function usage() {
  const logs = await getRecords('logs')
  const accesses = await getRecords('access')
  const users = (await getRecords('users')).map(r => normUser(r.fields))
  const userMap = {}
  users.forEach(u => { userMap[u.id] = u })

  const byUser = {}
  const bump = (uid, time) => {
    const k = ('' + (uid || '')).trim()
    if (!k) return
    if (!byUser[k]) byUser[k] = { n: 0, last: time }
    byUser[k].n++
    if (time && (!byUser[k].last || time > byUser[k].last)) byUser[k].last = time
  }
  logs.forEach(l => bump(l.fields[COL.logs.actor], fmtTs(l.fields[COL.logs.time])))
  accesses.forEach(a => bump(a.fields[COL.access.user], fmtTs(a.fields[COL.access.time])))

  const rank = Object.keys(byUser).map(uid => ({
    user: userMap[uid] || { id: uid, name: uid, role: '?', cls: '' },
    n: byUser[uid].n, last: byUser[uid].last
  })).sort((a, b) => b.n - a.n)

  const teachers = users.filter(u => u.role === 'teacher')
  const teacherActive = teachers.filter(t => byUser[t.id]).length

  const ioList = await getRecords('stock_io')
  const reqRows = await getRecords('requisitions')
  const mats = await getRecords('materials')
  const tools = await getRecords('tools')
  const borrowRows = await getRecords('borrow')
  const matName = {}
  const matUnit = {}
  for (const r of mats) {
    matName['' + r.fields[COL.materials.id]] = r.fields[COL.materials.name] || ''
    matUnit['' + r.fields[COL.materials.id]] = r.fields[COL.materials.unit] || ''
  }
  const toolName = {}
  for (const r of tools) toolName['' + r.fields[COL.tools.id]] = r.fields[COL.tools.name] || ''

  const isReversed = (f) => {
    const n = '' + (f[COL.stock_io.note] || '')
    const s = '' + (f[COL.stock_io.src] || '')
    return n.indexOf('[已冲销]') >= 0 || s === '冲销' || n.indexOf('冲销流水') >= 0
  }
  const bjMonthKey = (ts) => {
    if (!ts) return ''
    const d = new Date(Number(ts) + 8 * 3600 * 1000)
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
  }
  const months = []
  const base = new Date(Date.now() + 8 * 3600 * 1000)
  base.setUTCDate(1); base.setUTCHours(0, 0, 0, 0)
  for (let i = 5; i >= 0; i--) {
    const d = new Date(base)
    d.setUTCMonth(d.getUTCMonth() - i)
    months.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'))
  }
  const trendMap = {}
  months.forEach(m => { trendMap[m] = { m, out: 0, in: 0 } })
  for (const r of ioList) {
    const f = r.fields
    if (isReversed(f)) continue
    const k = bjMonthKey(f[COL.stock_io.time])
    if (!k || !trendMap[k]) continue
    const q = Number(f[COL.stock_io.qty]) || 0
    if (('' + f[COL.stock_io.dir]) === '出库') trendMap[k].out += q
    else trendMap[k].in += q
  }
  const trend = months.map(m => trendMap[m])
  const trendMax = Math.max(1, ...trend.map(x => Math.max(x.in, x.out)))

  const topMap = {}
  const addOut = (matId, qty) => {
    const k = '' + (matId || '')
    if (!k || !matName[k]) return
    if (!topMap[k]) topMap[k] = { id: k, name: matName[k], unit: matUnit[k] || '', qty: 0, times: 0 }
    topMap[k].qty += qty
    topMap[k].times++
  }
  for (const r of ioList) {
    const f = r.fields
    if (isReversed(f)) continue
    if (('' + f[COL.stock_io.dir]) === '出库') addOut(f[COL.stock_io.item], Number(f[COL.stock_io.qty]) || 0)
  }
  const topMaterials = Object.values(topMap).sort((a, b) => b.qty - a.qty).slice(0, 10)

  const turnMap = {}
  for (const r of borrowRows) {
    const f = r.fields
    const k = '' + (f[COL.borrow.tool] || '')
    if (!k) continue
    if (!turnMap[k]) turnMap[k] = { id: k, name: toolName[k] || k, times: 0, returned: 0, out: 0 }
    turnMap[k].times++
    const st = '' + (f[COL.borrow.status] || '')
    if (st === '已归还') turnMap[k].returned++
    else turnMap[k].out++
  }
  const toolTurnover = Object.values(turnMap).sort((a, b) => b.times - a.times).slice(0, 10)
  const borrowTotal = borrowRows.length
  const borrowOpen = borrowRows.filter(r => ('' + r.fields[COL.borrow.status]) !== '已归还').length
  const overdue = await (async () => {
    const rows = borrowRows
      .filter(r => ('' + r.fields[COL.borrow.status]) === '借出中')
      .map(r => normBorrow(r.fields))
      .filter(b => b.overdue)
    return rows.sort((a, b) => ('' + (b.plan || '')).localeCompare('' + (a.plan || '')))
  })()
  const lowStock = mats
    .map(r => normMaterial(r.fields))
    .filter(m => m.safe > 0 && m.stock < m.safe)
    .sort((a, b) => (a.stock / Math.max(1, a.safe)) - (b.stock / Math.max(1, b.safe)))

  return {
    total: logs.length + accesses.length,
    activeUsers: Object.keys(byUser).length,
    teacherActive, teacherTotal: teachers.length,
    rank,
    trend, trendMax,
    topMaterials,
    toolTurnover,
    borrow: { total: borrowTotal, open: borrowOpen, returned: borrowTotal - borrowOpen },
    overdue,
    lowStock,
    reqStat: (() => {
      const map = { pending: 0, approved: 0, rejected: 0, canceled: 0, other: 0 }
      for (const r of reqRows) {
        const s = TR.reqRev['' + r.fields[COL.requisitions.status]] || 'other'
        map[s] = (map[s] || 0) + 1
      }
      return map
    })()
  }
}

async function snapshot() {
  const [userRows, materialRows, toolRows, reqRows, borrowRows, ioRows, accessRows, logRows] = await Promise.all([
    getRecords('users'), getRecords('materials'), getRecords('tools'),
    getRecords('requisitions'), getRecords('borrow'), getRecords('stock_io'),
    getRecords('access'), getRecords('logs')
  ])
  const userList = userRows
    .map(r => {
      const u = normUser(r.fields)
      return {
        rid: r.recordId,
        id: u.id, name: u.name, role: u.role, cls: u.cls,
        status: u.status,
        bound: !!(u.openid && ('' + u.openid).trim())
      }
    })
    .filter(u => !!(u.id && ('' + u.id).trim()))
  const usersByRole = userList.reduce((acc, u) => { acc[u.role] = (acc[u.role] || 0) + 1; return acc }, {})
  return {
    users: userList,
    usersByRole,
    materials: materialRows.map(r => ({ ...normMaterial(r.fields), qr: r.fields[COL.materials.id] })),
    tools: toolRows.map(r => normTool(r.fields)),
    requisitions: reqRows.map(r => normReq(r.fields)),
    borrow: borrowRows.map(r => normBorrow(r.fields)),
    stock_io: ioRows.map(r => normStockIO(r.fields)),
    access: accessRows.map(r => normAccess(r.fields)),
    logs: logRows.map(r => normLog(r.fields))
  }
}

// ============================================================
// 导出（与 tencentdocs.js 完全一致，index.js 按名调用）
// ============================================================
// ============================================================
// 4. 实训室归属管理体系（labs / repairs / inspections）
//    报修/巡检/位置/负责人数据均绑定到实训室，支持按实训室维度统一查询。
//    状态值统一存中文（与腾讯文档/云库同构）：
//      labs.status: 启用/停用
//      repairs.status: 待处理/处理中/已完成/已取消；priority: 紧急/一般/低
//      inspections.status: 待巡检/已完成/已逾期
// ============================================================
function normLab(f) {
  return {
    id: f[COL.labs.id], name: f[COL.labs.name] || '',
    campus: f[COL.labs.campus] || '', building: f[COL.labs.building] || '',
    floor: f[COL.labs.floor] || '', roomNo: f[COL.labs.roomNo] || '',
    address: f[COL.labs.address] || '',
    lng: Number(f[COL.labs.lng]) || 0, lat: Number(f[COL.labs.lat]) || 0,
    managerId: f[COL.labs.managerId] || '', managerName: f[COL.labs.managerName] || '',
    status: f[COL.labs.status] || '启用', note: f[COL.labs.note] || '',
    createdAt: fmtTs(f[COL.labs.createdAt]), updatedAt: fmtTs(f[COL.labs.updatedAt])
  }
}
function normRepair(f) {
  return {
    id: f[COL.repairs.id], labId: f[COL.repairs.labId], labName: f[COL.repairs.labName] || '',
    title: f[COL.repairs.title] || '', category: f[COL.repairs.category] || '', desc: f[COL.repairs.desc] || '',
    reporterId: f[COL.repairs.reporterId] || '', reporterName: f[COL.repairs.reporterName] || '',
    status: f[COL.repairs.status] || '待处理', priority: f[COL.repairs.priority] || '一般',
    handlerId: f[COL.repairs.handlerId] || '', handlerName: f[COL.repairs.handlerName] || '',
    resolvedNote: f[COL.repairs.resolvedNote] || '',
    createdAt: fmtTs(f[COL.repairs.createdAt]), updatedAt: fmtTs(f[COL.repairs.updatedAt])
  }
}
// 计划日期当日 23:59:59（+08:00）时间戳，用于"逾期"判定（与 io.js dayEnd 同口径，避开时区错）
function planEndTs(s) {
  if (!s) return 0
  const t = new Date('' + s + 'T23:59:59+08:00').getTime()
  return isNaN(t) ? 0 : t
}
function normInspection(f) {
  const status = f[COL.inspections.status] || '待巡检'
  const planDate = f[COL.inspections.planDate] || ''
  const overdue = status === '待巡检' && !!planDate && Date.now() > planEndTs(planDate)
  return {
    id: f[COL.inspections.id], labId: f[COL.inspections.labId], labName: f[COL.inspections.labName] || '',
    title: f[COL.inspections.title] || '', planDate,
    executorId: f[COL.inspections.executorId] || '', executorName: f[COL.inspections.executorName] || '',
    status, result: f[COL.inspections.result] || '', overdue,
    createdAt: fmtTs(f[COL.inspections.createdAt]), doneAt: fmtTs(f[COL.inspections.doneAt])
  }
}

// —— 实训室（核心归属实体）——
async function listLabs() {
  const list = await getRecords('labs')
  return list.map(r => normLab(r.fields))
}
async function getLab(id) {
  const key = ('' + (id || '')).trim().toUpperCase()
  if (!key) return null
  const list = await getRecords('labs', r => ('' + r.fields[COL.labs.id]).trim().toUpperCase() === key)
  const rec = list[0]
  return rec ? { ...normLab(rec.fields), rid: rec.recordId } : null
}
async function addLab(data) {
  const name = ('' + (data.name || '')).trim()
  if (!name) return { code: 400, data: { msg: '请填写实训室名称' } }
  const idemKey = ['addLab', data.actor || '', name].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const exists = await getRecords('labs', r => ('' + r.fields[COL.labs.name]).trim() === name)
    if (exists.length) return { code: 409, data: { msg: '该实训室已存在：' + exists[0].fields[COL.labs.id] } }
    const all = await getRecords('labs')
    let max = 0
    for (const r of all) { const m = /^\s*[Ll](\d+)\s*$/.exec('' + r.fields[COL.labs.id]); if (m) max = Math.max(max, parseInt(m[1], 10) || 0) }
    const newId = 'L' + String(max + 1).padStart(3, '0')
    const ts = now()
    await addRecord('labs', {
      [COL.labs.id]: newId, [COL.labs.name]: name,
      [COL.labs.campus]: ('' + (data.campus || '')).trim(),
      [COL.labs.building]: ('' + (data.building || '')).trim(),
      [COL.labs.floor]: ('' + (data.floor || '')).trim(),
      [COL.labs.roomNo]: ('' + (data.roomNo || '')).trim(),
      [COL.labs.address]: ('' + (data.address || '')).trim(),
      [COL.labs.lng]: Number(data.lng) || 0, [COL.labs.lat]: Number(data.lat) || 0,
      [COL.labs.managerId]: ('' + (data.managerId || '')).trim(),
      [COL.labs.managerName]: ('' + (data.managerName || '')).trim(),
      [COL.labs.status]: ('' + (data.status || '启用')).trim(),
      [COL.labs.note]: ('' + (data.note || '')).trim(),
      [COL.labs.createdAt]: ts, [COL.labs.updatedAt]: ts
    })
    return { id: newId, name }
  }))
}
async function updateLab(data) {
  const id = ('' + (data.id || '')).trim().toUpperCase()
  if (!id) return { code: 400, data: { msg: '缺少实训室ID' } }
  const list = await getRecords('labs', r => ('' + r.fields[COL.labs.id]).trim().toUpperCase() === id)
  const rec = list[0]
  if (!rec) return { code: 404, data: { msg: '未找到该实训室' } }
  const f = {}
  const set = (k, v) => { if (v !== undefined && v !== null) f[COL.labs[k]] = ('' + v).trim() }
  set('name', data.name); set('campus', data.campus); set('building', data.building)
  set('floor', data.floor); set('roomNo', data.roomNo); set('address', data.address)
  if (data.lng !== undefined) f[COL.labs.lng] = Number(data.lng) || 0
  if (data.lat !== undefined) f[COL.labs.lat] = Number(data.lat) || 0
  set('managerId', data.managerId); set('managerName', data.managerName)
  set('status', data.status); set('note', data.note)
  f[COL.labs.updatedAt] = now()
  await updateRecord('labs', rec.recordId, f)
  return { id, updated: true }
}
async function deleteLab(data) {
  const id = ('' + (data.id || '')).trim().toUpperCase()
  if (!id) return { code: 400, data: { msg: '缺少实训室ID' } }
  const list = await getRecords('labs', r => ('' + r.fields[COL.labs.id]).trim().toUpperCase() === id)
  if (!list.length) return { code: 404, data: { msg: '未找到该实训室' } }
  await deleteRecordByIds('labs', list.map(r => r.recordId))
  return { id, deleted: true }
}

// —— 报修（归属实训室，教师发起与处理）——
async function listRepairs(filter) {
  const f = filter || {}
  const list = await getRecords('repairs', r => {
    const ff = r.fields
    if (f.labId && ('' + ff[COL.repairs.labId]).trim().toUpperCase() !== ('' + f.labId).trim().toUpperCase()) return false
    if (f.status && ('' + ff[COL.repairs.status]) !== ('' + f.status)) return false
    return true
  })
  const sorted = list.slice().sort((a, b) => (Number(b.fields[COL.repairs.createdAt]) || 0) - (Number(a.fields[COL.repairs.createdAt]) || 0))
  return sorted.map(r => normRepair(r.fields))
}
async function addRepair(data) {
  const title = ('' + (data.title || '')).trim()
  const labId = ('' + (data.labId || '')).trim().toUpperCase()
  if (!title) return { code: 400, data: { msg: '请填写报修内容' } }
  if (!labId) return { code: 400, data: { msg: '请选择归属实训室' } }
  const idemKey = ['addRepair', data.actor || '', labId, title].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const lab = await getLab(labId)
    if (!lab) return { code: 404, data: { msg: '归属实训室不存在' } }
    const ts = now()
    const newId = 'R' + ('' + ts).slice(-10) + Math.floor(Math.random() * 90 + 10)
    await addRecord('repairs', {
      [COL.repairs.id]: newId, [COL.repairs.labId]: labId, [COL.repairs.labName]: lab.name,
      [COL.repairs.title]: title, [COL.repairs.category]: ('' + (data.category || '设备故障')).trim(),
      [COL.repairs.desc]: ('' + (data.desc || '')).trim(),
      [COL.repairs.reporterId]: ('' + (data.actor || '')).trim(),
      [COL.repairs.reporterName]: ('' + (data.reporterName || data.actor || '')).trim(),
      [COL.repairs.status]: '待处理', [COL.repairs.priority]: ('' + (data.priority || '一般')).trim(),
      [COL.repairs.handlerId]: '', [COL.repairs.handlerName]: '',
      [COL.repairs.resolvedNote]: '', [COL.repairs.createdAt]: ts, [COL.repairs.updatedAt]: ts
    })
    return { id: newId, labId, labName: lab.name, title }
  }))
}
async function updateRepair(data) {
  const id = ('' + (data.id || '')).trim()
  if (!id) return { code: 400, data: { msg: '缺少报修单ID' } }
  const list = await getRecords('repairs', r => ('' + r.fields[COL.repairs.id]).trim() === id)
  const rec = list[0]
  if (!rec) return { code: 404, data: { msg: '未找到该报修单' } }
  const f = {}
  const set = (k, v) => { if (v !== undefined) f[COL.repairs[k]] = ('' + v).trim() }
  set('status', data.status); set('handlerId', data.handlerId); set('handlerName', data.handlerName)
  set('priority', data.priority); set('resolvedNote', data.resolvedNote)
  f[COL.repairs.updatedAt] = now()
  await updateRecord('repairs', rec.recordId, f)
  return { id, updated: true }
}

// —— 巡检（归属实训室，教师执行）——
async function listInspections(filter) {
  const f = filter || {}
  const list = await getRecords('inspections')
  let arr = list.map(r => normInspection(r.fields))
  if (f.labId) arr = arr.filter(x => ('' + x.labId).trim().toUpperCase() === ('' + f.labId).trim().toUpperCase())
  if (f.status) {
    if (f.status === '已逾期') arr = arr.filter(x => x.status === '待巡检' && x.overdue)
    else arr = arr.filter(x => x.status === f.status)
  }
  arr.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
  return arr
}
async function addInspection(data) {
  const title = ('' + (data.title || '')).trim()
  const labId = ('' + (data.labId || '')).trim().toUpperCase()
  if (!title) return { code: 400, data: { msg: '请填写巡检任务名称' } }
  if (!labId) return { code: 400, data: { msg: '请选择归属实训室' } }
  const idemKey = ['addInsp', data.actor || '', labId, title].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const lab = await getLab(labId)
    if (!lab) return { code: 404, data: { msg: '归属实训室不存在' } }
    const ts = now()
    const newId = 'I' + ('' + ts).slice(-10) + Math.floor(Math.random() * 90 + 10)
    await addRecord('inspections', {
      [COL.inspections.id]: newId, [COL.inspections.labId]: labId, [COL.inspections.labName]: lab.name,
      [COL.inspections.title]: title, [COL.inspections.planDate]: ('' + (data.planDate || '')).trim(),
      [COL.inspections.executorId]: ('' + (data.actor || '')).trim(),
      [COL.inspections.executorName]: ('' + (data.executorName || data.actor || '')).trim(),
      [COL.inspections.status]: '待巡检', [COL.inspections.result]: '',
      [COL.inspections.createdAt]: ts, [COL.inspections.doneAt]: ''
    })
    return { id: newId, labId, labName: lab.name, title }
  }))
}
async function updateInspection(data) {
  const id = ('' + (data.id || '')).trim()
  if (!id) return { code: 400, data: { msg: '缺少巡检单ID' } }
  const list = await getRecords('inspections', r => ('' + r.fields[COL.inspections.id]).trim() === id)
  const rec = list[0]
  if (!rec) return { code: 404, data: { msg: '未找到该巡检单' } }
  const f = {}
  const set = (k, v) => { if (v !== undefined) f[COL.inspections[k]] = ('' + v).trim() }
  set('status', data.status); set('result', data.result); set('planDate', data.planDate)
  set('executorId', data.executorId); set('executorName', data.executorName)
  if (data.status === '已完成') f[COL.inspections.doneAt] = now()
  f[COL.inspections.updatedAt] = now()
  await updateRecord('inspections', rec.recordId, f)
  return { id, updated: true }
}

// 按实训室维度统一查询：实训室本体 + 其报修 + 其巡检
async function labOverview(labId) {
  const lab = await getLab(labId)
  if (!lab) return { code: 404, data: { msg: '未找到该实训室' } }
  const [reps, insps] = await Promise.all([listRepairs({ labId }), listInspections({ labId })])
  return { lab, repairs: reps, inspections: insps }
}

module.exports = {
  TABLE, CFG, COL, TR, runtimeInfo, warmFieldMaps,
  getToken, authorizeWithCode, callSmart, callApi, getFieldMap, buildValues,
  getRecords, addRecord, updateRecord, deleteRecordByIds, getItem,
  invalidateCache, cacheStats, clearFieldMapCache,
  listMaterials, listTools, listMine, listPending, search,
  findUser, listUsers, ensureOpenIdColumn, bindOpenId, findUserByOpenId, findUserByRobotKey, setRobotKey, whoami, bindLogin,
  adminListUsers, adminUpsertUser, adminDeleteUser, decideUserWrite, decideUserDelete,
  requisition, toolRequisition, approve, cancelReq, io, borrow, returnTool, access, usage, snapshot,
  addMaterial, listStockIO, exportData, stocktake, listLogs, reverseIO, batchIo, listAccess,
  // 实训室归属管理体系（labs / repairs / inspections）
  listLabs, getLab, addLab, updateLab, deleteLab,
  listRepairs, addRepair, updateRepair,
  listInspections, addInspection, updateInspection, labOverview,
  // 测试/本地注入用（非契约，但导出便于单测）
  __setDbForTest
}
