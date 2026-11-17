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

// —— 数据域（班级）行级隔离引擎：请求级上下文 + 纯函数裁决 ——
const ds = require('./data-scope.js')

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
  users: { id: 'id', name: 'name', role: 'role', cls: 'cls', status: 'status', openid: 'openid', robotKeyHash: 'robotKeyHash', managedClasses: 'managedClasses' },
  materials: { id: 'id', name: 'name', spec: 'spec', cat: 'cat', loc: 'loc', stock: 'stock', unit: 'unit', safe: 'safe', status: 'status', expire: 'expire' },
  tools: { id: 'id', name: 'name', spec: 'spec', loc: 'loc', status: 'status', holder: 'holder' },
  // 以下 7 张流水表带 cls（归属班级），由 data-scope 在 addRecord 时自动继承发起人班级
  // days = 申请的借期天数（仅工具借出有意义；此前申请时无处填、审批一律按默认 7 天，
  // 导致「要用两周的学生」在第 7 天就被标逾期，而老师也无处调整）
  // delivered = 实物交付确认时间（审批通过 ≠ 已把东西交给学生）：
  //   审批通过时库存已扣，但东西可能还没交到手上 → 管理员需要一个「待交付单」照着发料。
  //   腾讯文档侧需手工加「交付时间」列；未加列时 buildValues 跳过 → 交付状态记不住（其余功能不受影响）。
  requisitions: { id: 'id', user: 'user', item: 'item', type: 'type', qty: 'qty', reason: 'reason', status: 'status', time: 'time', approver: 'approver', reject: 'reject', days: 'days', cls: 'cls', delivered: 'delivered' },
  // note=借出备注（用途/临时说明），backNote=归还入库时的验收备注（完好/缺件）
  borrow: { id: 'id', user: 'user', tool: 'tool', out: 'out', plan: 'plan', in: 'in', status: 'status', note: 'note', backNote: 'backNote', cls: 'cls' },
  stock_io: { id: 'id', item: 'item', dir: 'dir', qty: 'qty', op: 'op', time: 'time', note: 'note', src: 'src', cls: 'cls' },
  access: { id: 'id', user: 'user', point: 'point', time: 'time', result: 'result', cls: 'cls' },
  logs: { id: 'id', time: 'time', actor: 'actor', op: 'op', target: 'target', result: 'result', cls: 'cls' },
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
    resolvedNote: 'resolvedNote', createdAt: 'createdAt', updatedAt: 'updatedAt', cls: 'cls'
  },
  inspections: {
    id: 'id', labId: 'labId', labName: 'labName', title: 'title', planDate: 'planDate',
    executorId: 'executorId', executorName: 'executorName',
    status: 'status', result: 'result', createdAt: 'createdAt', doneAt: 'doneAt', cls: 'cls'
  }
}

// 角色契约：super > admin > teacher > student（与前端 identity.normalizeRole 共用）
const ROLES = ['student', 'teacher', 'admin', 'super']
const SUPER = 'super'
const ADMIN = 'admin'
// 角色层级：super(3) > admin(2) > teacher(1) > student(0)
// 创建/管理/删除权限按「调用者层级」裁决：super 可操作任意角色，其余仅可操作「严格低于自身层级」的角色
//   → 管理员只能建 教师/学生；教师只能建 学生（详见 decideUserWrite / decideUserDelete）
const ROLE_LEVEL = { student: 0, teacher: 1, admin: 2, super: 3 }

// —— 数量解析：必须是范围内的整数 ——
// 为什么不再用 Math.floor(Number(x) || 0)：
//   ① 小数 2.5 被静默截断成 2 —— 账面按 2 记、实物给 2.5，账实差 0.5，
//      而提示文案写着「必须是整数」却放行了小数（校验与文案不符）；
//   ② 建档/导入原用 Number(x) || 0（完全不取整），小数直接进库存，
//      而演示 mock 会截断 → 生产与演示行为分叉（库存口径不一致）。
// 上限：误输 1e12 会把库存写成天文数字，导出 Excel（15 位有效数字）直接失真。
const MAX_QTY = 1000000
function parseQty(v, min) {
  const n = Number(v)
  const lo = (min === undefined) ? 1 : min
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  if (n < lo || n > MAX_QTY) return null
  return n
}

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
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
}
// 单号唯一性：分钟级+2位随机时同分钟约12笔即50%撞号，冲销按单号查会命中错行。
// 改为「秒 + 进程内单调序号 + 2位随机」。
let _genSeq = 0
// 云库模式下 now() 返回 epoch 毫秒（字符串时间列统一存数字，便于排序/报表/趋势图）。
function now() { return Date.now() }
function genNo(p) {
  const t = nowParts(); const q = n => ('' + n).padStart(2, '0')
  _genSeq = (_genSeq + 1) % 1000
  return `${p}${t.y}${q(t.mo)}${q(t.d)}${q(t.h)}${q(t.mi)}${q(t.s)}${String(_genSeq).padStart(3, '0')}${Math.floor(Math.random() * 90 + 10)}`
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
// ⚠ 窗口长度要覆盖「用户看到失败提示 → 反应过来 → 再点一次」的间隔：
//   弱网/超时后请求其实已经到达服务器并执行了，用户看不到结果会再点一次 → 重复执行。
//   5 秒太短（人反应不过来），30 秒能覆盖绝大多数重试。
//   命中时会给结果挂 idem 标记，前端明确提示「重复提交已忽略」，不会假装做了两次。
const IDEM_WINDOW_MS = 30000
const _recentWrites = new Map()
function withWriteIdem(key, fn) {
  const t = Date.now()
  const hit = _recentWrites.get(key)
  if (hit && t - hit.t < IDEM_WINDOW_MS) {
    // ⚠ 命中幂等窗口时不能原样返回上次的"成功"结果 ——
    //   老师会看到"入库成功"两次，实际只入了一次（静默丢库存，且毫无提示）。
    //   这里挂上 idem/deduped 标记 + 明确文案，由前端提示"重复提交已忽略"。
    //   注意：这正是防"双击/弱网重试"的设计本意（那种情况返回同一结果是对的），
    //   关键是不能假装"做了两次"。
    const p = hit.p.then(r => {
      // 注意：适配器内部的返回值有两种形态 —— 业务失败是 {code:400,data:{msg}}，
      // 成功则是【裸载荷】（如 {} 或 {no,id}，没有 code 字段），code:0 是外层包装时才加的。
      // 所以这里不能用 r.code === 0 判定成功，否则永远不成立、标记永远挂不上。
      const bizFail = !!(r && typeof r === 'object' && r.code && r.code >= 400)
      if (r && typeof r === 'object' && !bizFail) {
        // 标记同时放在顶层与 data 里：各 action 的载荷位置不统一
        // （有的直接是业务对象，有的包在 data 里），只放一处会读不到。
        const mark = {
          idem: true, deduped: true,
          warn: '检测到重复提交（相同内容），本次未重复执行'
        }
        const out = Object.assign({}, r, mark)
        if (r.data && typeof r.data === 'object') out.data = Object.assign({}, r.data, mark)
        return out
      }
      return r
    })
    p.catch(() => {})
    return p
  }
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
// 原始全表读取（不过滤）：供 getRecords 与跨班写守卫共用。
// 云函数端 collection.get() 单次【最多 100 条】（与腾讯文档适配器的分页循环对齐）。
// 旧版只取一次，集合超过 100 行后：第 101 单审批永远报「不存在」、编号生成重复、
// 报表/导出/清库全部只统计前 100 行——这是云库模式的根级数据可见性缺陷。
const CLOUD_PAGE = 100
async function __rawAll(sheetKey) {
  if (!__db) throw new Error('云数据库未初始化（请确认云函数已部署到 CloudBase 且环境正常）')
  const out = []
  let offset = 0
  // 上限 2000 页（20 万行）防止异常集合把云函数拖到超时
  for (let guard = 0; guard < 2000; guard++) {
    const res = await __db.collection(sheetKey).skip(offset).limit(CLOUD_PAGE).get()
    const batch = res.data || []
    for (const d of batch) {
      const { _id, _openid, ...fields } = d
      out.push({ recordId: _id, fields })
    }
    if (batch.length < CLOUD_PAGE) break
    offset += CLOUD_PAGE
  }
  return out
}

// 数据域读过滤：在业务 filterFn 之后追加行级裁决。
// 放在唯一读入口 → 报表/导出/快照的聚合口径天然正确，业务函数零改动。
async function getRecords(sheetKey, filterFn, opts) {
  const o = opts || {}
  const all = await __rawAll(sheetKey)
  const scope = ds.currentScope()
  // 行级裁决必须统一在此唯一读出口完成：recordIDs 快路径也不能绕过，
  // 否则超范围传他人记录 ID 即可读到本不该看到的数据（与腾讯文档侧 applyScope 对齐）。
  const guard = ds.needGuard(scope) && ds.isScopedTable(sheetKey)
  const scoped = rows => (guard ? rows.filter(r => ds.rowVisible(scope, sheetKey, r.fields)) : rows)
  if (o.recordIDs && o.recordIDs.length) {
    return scoped(all.filter(r => o.recordIDs.indexOf(r.recordId) >= 0))
  }
  const base = filterFn ? all.filter(filterFn) : all
  return scoped(base)
}

// 跨班写守卫：用原始（未过滤）记录判断，避免把「无权」误报成「记录不存在」。
async function __assertWritable(sheetKey, ids) {
  const scope = ds.currentScope()
  if (!ds.needGuard(scope) || !ds.isScopedTable(sheetKey)) return
  const all = await __rawAll(sheetKey)
  for (const id of ids) {
    const row = all.find(r => r.recordId === id)
    if (row && !ds.canWriteRow(scope, sheetKey, row.fields)) {
      throw new ds.ScopeDeniedError('无权操作其他班级的数据')
    }
  }
}

async function addRecord(sheetKey, fieldsMap) {
  if (!__db) throw new Error('云数据库未初始化')
  const scope = ds.currentScope()
  // 流水表自动继承发起人归属班级（已显式给出则不覆盖，便于冲销等继承原班级）
  if (ds.shouldStampCls(scope, sheetKey) && COL[sheetKey] && COL[sheetKey].cls) {
    const k = COL[sheetKey].cls
    if (fieldsMap[k] === undefined || fieldsMap[k] === null || fieldsMap[k] === '') {
      fieldsMap[k] = scope.ownerCls || ''
    }
  }
  const values = await buildValues(sheetKey, fieldsMap)
  const res = await __db.collection(sheetKey).add({ data: values })
  invalidateCache(sheetKey)
  return { recordId: res._id, fields: values }
}

async function updateRecord(sheetKey, recordId, fieldsMap) {
  if (!__db) throw new Error('云数据库未初始化')
  await __assertWritable(sheetKey, [recordId])
  const values = await buildValues(sheetKey, fieldsMap)
  await __db.collection(sheetKey).doc(recordId).update({ data: values })
  invalidateCache(sheetKey)
  return { recordId, fields: values }
}

// —— 原子条件更新（CAS）——
// 为什么需要：库存与工具状态的写入原本是「读 → 算 → 写」三步，
//   进程内的 withWriteLock 只能挡住【同一个云函数实例】内的并发；
//   CloudBase 多实例部署时，两个老师同时操作同一件物品会各自读到同一个旧值，
//   后写的覆盖先写的 → 入库少加 / 审批双扣 / 同一件工具被借两次。
//   把「读到的期望值」写进 where 条件，由数据库保证原子性 → 跨实例也安全。
//   腾讯文档侧没有条件更新能力（表格 API 只能整行读改写），那边只能靠写锁 + 回读校验。
async function casUpdate(sheetKey, recordId, condition, fieldsMap) {
  if (!__db) throw new Error('云数据库未初始化')
  await __assertWritable(sheetKey, [recordId])
  const values = await buildValues(sheetKey, fieldsMap)
  const where = Object.assign({ _id: recordId }, condition || {})
  const res = await __db.collection(sheetKey).where(where).update({ data: values })
  invalidateCache(sheetKey)
  const n = (res && (res.updated !== undefined ? res.updated : (res.stats && res.stats.updated))) || 0
  return { ok: n > 0, updated: n }
}

// 原子增减库存（入库 +qty / 出库 -qty）：
//   条件里带上读到的期望值，只有库存未被并发改动过才写入；
//   条件不匹配 → 期间被别人改了 → 重新读取再试（最多 4 次）。
//   算出新值为负 → 库存不足（业务拒绝，不重试）。
async function atomicAdjustStock(recordId, delta, tries) {
  const maxTry = tries || 4
  for (let i = 0; i < maxTry; i++) {
    invalidateCache('materials')
    const list = await getRecords('materials', r => r.recordId === recordId)
    const rec = list[0]
    if (!rec) return { ok: false, reason: 'missing' }
    const cur = Number(rec.fields[COL.materials.stock]) || 0
    const next = cur + delta
    if (next < 0) return { ok: false, reason: 'insufficient', stock: cur }
    const r = await casUpdate('materials', recordId,
      { [COL.materials.stock]: cur }, { [COL.materials.stock]: next })
    if (r.ok) return { ok: true, stock: next }
  }
  return { ok: false, reason: 'conflict' }
}

// 原子切换工具状态：只有当状态仍等于 fromStatus 时才改（防止同一件工具被借两次）
async function atomicSwitchToolStatus(recordId, fromStatus, toStatus, extraFields) {
  const fields = Object.assign({ [COL.tools.status]: toStatus }, extraFields || {})
  const r = await casUpdate('tools', recordId, { [COL.tools.status]: fromStatus }, fields)
  return r.ok
}

async function deleteRecordByIds(sheetKey, ids) {
  if (!__db) throw new Error('云数据库未初始化')
  const list = (ids || []).filter(Boolean)
  if (!list.length) return 0
  await __assertWritable(sheetKey, list)
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
// 效期（有效期）转换：'YYYY-MM-DD' → 该日 23:59:59（北京时间）的 epoch 毫秒。
// 统一放在服务端：前端传本地时区字符串会差一天；到期日当天仍算有效，次日才算过期。
// 效期解析：支持 YYYY-MM-DD / YYYY/M/D / YYYY年M月D日 / YYYYMMDD，
// 并校验「真实日期」——2026-02-30 这种会被 Date.UTC 自动进位到 3-02，
// 看起来像设了一个月后的效期，实际比用户填的晚了 2 天。
// 返回 { ts }（空值=无限制）或 null（格式非法，调用方必须明确报错，不能静默丢弃）。
function expireTs(v) {
  const s = ('' + (v || '')).trim()
  if (!s) return { ts: 0 }
  const mk = (y, mo, d) => {
    if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1) return null
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate()   // 该月实际天数
    if (d > dim) return null
    return { ts: Date.UTC(y, mo - 1, d, 15, 59, 59) }      // 15:59:59 UTC == 23:59:59 +08:00
  }
  // 纯数字 8 位：YYYYMMDD（Excel 里最常见的日期形态）
  if (/^\d{8}$/.test(s)) return mk(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8))
  const m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/)
  if (m) return mk(+m[1], +m[2], +m[3])
  const n = Number(s)
  if (Number.isFinite(n) && n > 0) return { ts: n }
  return null
}

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
    // 借期：老单没有这一列时为空，前端显示"默认 7 天"
    days: Number(f[COL.requisitions.days]) || 0,
    reason: f[COL.requisitions.reason] || '', reject: f[COL.requisitions.reject] || '',
    status: TR.reqRev[f[COL.requisitions.status]] || f[COL.requisitions.status] || '',
    time: fmtTs(f[COL.requisitions.time]) || '',
    delivered: f[COL.requisitions.delivered] || '',
    cls: ds.readCls(f)
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
    // 借出备注（用途/临时说明）与归还验收备注：老数据没有这两列时为空，不影响既有渲染
    note: f[COL.borrow.note] || '',
    backNote: f[COL.borrow.backNote] || '',
    overdue: status === '借出' && planTs > 0 && Date.now() > planTs,
    cls: ds.readCls(f)
  }
}
function normUser(f) {
  const role = TR.role[f[COL.users.role]]
  return {
    id: ('' + (f[COL.users.id] || '')).trim(),
    name: ('' + (f[COL.users.name] || '')).trim(),
    role: (ROLES.indexOf(role) >= 0 ? role : 'student'),
    cls: ('' + (f[COL.users.cls] || '')).trim(),
    // 老师带班列表（多班逗号分隔）。数据域隔离据此裁决可见班级。
    managedClasses: ds.sanitizeManagedClasses(ds.readText(f, COL.users.managedClasses)),
    status: ('' + (f[COL.users.status] || '')).trim(),
    openid: ('' + (f[COL.users.openid] || '')).trim(),
    robotKeyHash: ('' + (f[COL.users.robotKeyHash] || '')).trim()
  }
}
// 冲销反向流水本身不可再冲销（否则无限回滚库存），报表也已排除这一类。
function isSettledFlow(f) {
  const note = '' + (f[COL.stock_io.note] || '')
  const src = '' + (f[COL.stock_io.src] || '')
  // ⚠ 判定必须精确，不能用「备注里含'冲销流水'」这种宽匹配：
  //   老师随手写一句「与张老师冲销流水核对无误」，这条流水就会被误判成已冲销 →
  //   ① 此后再也冲销不了 ② 被报表排除在库存统计之外 → 账实不符。
  // 锚点：src === '冲销'（反向流水，最可靠）；note 前缀 '[已冲销]'（原流水已被冲销）；
  //   反向流水的 note 形如「冲销流水 S2026...」→ 用正则精确匹配（不误伤普通备注）。
  //   src 是兜底之外的第二道保险：腾讯文档未手工加「来源类型」列时 src 恒空，
  //   这时只能靠 note 判定，所以 note 这条不能去掉，只能收紧。
  return src === '冲销'
    || /^\[已冲销\]/.test(note)
    || /^冲销流水\s+\S+$/.test(note)
}
function normStockIO(f) {
  return {
    no: f[COL.stock_io.id], matId: f[COL.stock_io.item],
    type: TR.ioRev[f[COL.stock_io.dir]] || 'in', qty: Number(f[COL.stock_io.qty]) || 0,
    operator: f[COL.stock_io.op] || '', time: fmtTs(f[COL.stock_io.time]) || '', note: f[COL.stock_io.note] || '',
    cls: ds.readCls(f), reversed: isSettledFlow(f)
  }
}
function normAccess(f) {
  return {
    time: fmtTs(f[COL.access.time]) || '', actor: f[COL.access.user] || '',
    door: f[COL.access.point] || '', result: f[COL.access.result] || '',
    cls: ds.readCls(f)
  }
}
function normLog(f) {
  return {
    time: fmtTs(f[COL.logs.time]) || '', actor: f[COL.logs.actor] || '',
    op: f[COL.logs.op] || '', target: f[COL.logs.target] || '', result: f[COL.logs.result] || '',
    cls: ds.readCls(f)
  }
}

// ============================================================
// 3. 业务函数（与 tencentdocs.js 同形，仅 requisition/toolRequisition/repairToolRow 适配云库）
// ============================================================
async function getItem(id, type) {
  const key = ('' + (id || '')).trim().toUpperCase()
  if (!key) return null
  const pick = async (t) => {
    const isTool = t === 'tool'
    const col = isTool ? COL.tools : COL.materials
    const list = await getRecords(isTool ? 'tools' : 'materials',
      r => ('' + r.fields[col.id]) === key)
    const rec = list[0]
    if (!rec) return null
    const base = isTool ? normTool(rec.fields) : normMaterial(rec.fields)
    return { type: isTool ? 'tool' : 'material', item: { ...base, rid: rec.recordId } }
  }
  // 显式类型优先：搜索结果跳转时会带上 type（search 已返回 type，不必再靠猜）
  if (type === 'tool' || type === 'material') return await pick(type)
  // 未指定类型：先按「ID 首字母」猜（保持原有行为），猜不到再查另一张表。
  // ⚠ 旧实现只猜一次 → 批量建档允许自定义编号，只要编号不以 M/T 开头
  //   （如「WM-001」「仪器01」）就查不到；编号以 T 开头却不是工具的还会查到错的那张表。
  const guess = key.startsWith('T') ? 'tool' : 'material'
  return (await pick(guess)) || (await pick(guess === 'tool' ? 'material' : 'tool'))
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
  if (!list.length) return []
  // 名称映射：审批是老师最关键的操作界面，却只显示工号与物品ID
  // （「申请人 S001」「M001 × 2」——老师得自己查台账才知道批的是谁、领什么）。
  // 领用记录页 listClaims 早已做同样映射，两页口径必须一致；
  // 前端 approve.js 也早就写了 `item.userName || item.user` 的兼容读取，只是后端一直没给这两个字段。
  const mats = await getRecords('materials')
  const tools = await getRecords('tools')
  const users = await getRecords('users')
  const nameOf = {}
  for (const r of mats) nameOf['' + r.fields[COL.materials.id]] = r.fields[COL.materials.name] || ''
  for (const r of tools) nameOf['' + r.fields[COL.tools.id]] = r.fields[COL.tools.name] || ''
  const userOf = {}
  for (const r of users) {
    const f = r.fields
    userOf['' + (f[COL.users.id] || '')] = { name: f[COL.users.name] || '', cls: ('' + (f[COL.users.cls] || '')).trim() }
  }
  return list.map(r => {
    const q = normReq(r.fields)
    const itemId = '' + (r.fields[COL.requisitions.item] || '')
    const u = userOf['' + (r.fields[COL.requisitions.user] || '')] || {}
    return Object.assign(q, {
      itemName: nameOf[itemId] || '',
      userName: u.name || '',
      userCls: u.cls || ''
    })
  })
}

// —— 登录鉴权 ——
function publicUser(u) {
  // managedClasses 必须透出：prodHandler 的 me 由此构造，数据域裁决依赖它
  return u ? { id: u.id, name: u.name, role: u.role, cls: u.cls, managedClasses: u.managedClasses || '' } : null
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
// 教职工名册（指派执行人/处理人用）。
// 刻意不走 ds.userVisible：那个函数按班级过滤，教师看不到任何同事（教师自身 cls 为空），
// 导致"把任务派给某位老师"永远做不了。这里只暴露工号/姓名/角色三项最小信息，
// 且过滤掉已停用账号——工号姓名本就是同事之间互相知道的公开信息。
async function listStaff() {
  const list = await getRecords('users')
  return list
    .map(r => normUser(r.fields))
    .filter(u => u.role === 'teacher' || u.role === 'admin' || u.role === 'super')
    .filter(u => u.status !== '停用')
    .filter(u => !!(u.id && u.id.trim()))
    .map(u => ({ id: u.id, name: u.name, role: u.role }))
}

// 账号配置体检用：返回全部账号的最小字段（不做行级过滤，仅供管理员自检）。
// 与 adminListUsers 的区别：那个按调用者层级过滤，这个给管理员做全库配置核对。
async function listAllUsersForAudit() {
  const list = await getRecords('users')
  return list
    .map(r => normUser(r.fields))
    .filter(u => !!(u.id && u.id.trim()))
    .map(u => ({ id: u.id, name: u.name, role: u.role, cls: u.cls, managedClasses: u.managedClasses, status: u.status }))
}

async function adminListUsers(me) {
  const list = await getRecords('users')
  const callerLevel = me ? (ROLE_LEVEL[me.role] != null ? ROLE_LEVEL[me.role] : 0) : 0
  return list
    .map(r => {
      const u = normUser(r.fields)
      return {
        rid: r.recordId,
        id: u.id,
        name: u.name,
        role: u.role,
        cls: u.cls,
        managedClasses: u.managedClasses,
        status: u.status,
        bound: !!(u.openid && ('' + u.openid).trim())
      }
    })
    .filter(u => !!(u.id && ('' + u.id).trim()))
    // 服务端按调用者层级过滤：超级管理员看全部；其余仅看「严格低于自身层级」的账号（admin 看教师/学生，teacher 看学生）
    .filter(u => callerLevel >= ROLE_LEVEL.super ? true : (ROLE_LEVEL[u.role] != null ? ROLE_LEVEL[u.role] : 0) < callerLevel)
    // 数据域过滤：老师只能看到自己带班的学生（super/admin 全通，不受影响）
    .filter(u => ds.userVisible(ds.currentScope(), u))
}

function decideUserWrite(me, target) {
  const callerRole = me ? me.role : null
  const callerLevel = ROLE_LEVEL[callerRole] != null ? ROLE_LEVEL[callerRole] : -1
  const callerSuper = callerRole === SUPER
  // 至少教师及以上才能操作用户
  if (callerLevel < ROLE_LEVEL.teacher) return { code: 403, data: { msg: '仅教师及以上可操作用户' } }
  const newRole = ('' + (target.role || '')).trim().toLowerCase()
  const newLevel = ROLE_LEVEL[newRole] != null ? ROLE_LEVEL[newRole] : -1
  // 超级管理员可创建/管理任何角色；其余仅可创建/管理「严格低于自身层级」的角色
  //   —— 即：管理员只能建 教师/学生；教师只能建 学生
  if (!callerSuper && newLevel >= callerLevel) {
    const allow = callerLevel === ROLE_LEVEL.admin ? '教师、学生' : '学生'
    return { code: 403, data: { msg: '权限不足：' + (callerRole === ADMIN ? '管理员' : '教师') + '仅可创建/管理 ' + allow + ' 角色' } }
  }
  // 自锁：非超级管理员不能改自己的角色/状态（防把自己锁在管理功能外）
  if (me && target.id && ('' + target.id).toUpperCase() === ('' + me.id).toUpperCase() && !callerSuper) {
    const existing = target.existingRole || 'student'
    if (newRole && newRole !== existing) return { code: 400, data: { msg: '不能修改自己的角色（防止把自己锁在管理功能外）' } }
    if (target.statusChanging) return { code: 400, data: { msg: '不能修改自己的账号状态' } }
  }
  return null
}

function decideUserDelete(me, existingRole, id) {
  const callerRole = me ? me.role : null
  const callerLevel = ROLE_LEVEL[callerRole] != null ? ROLE_LEVEL[callerRole] : -1
  const callerSuper = callerRole === SUPER
  if (callerLevel < ROLE_LEVEL.teacher) return { code: 403, data: { msg: '仅教师及以上可操作用户' } }
  const targetLevel = ROLE_LEVEL[existingRole] != null ? ROLE_LEVEL[existingRole] : -1
  // 超级管理员可删除任何角色；其余仅可删除「严格低于自身层级」的角色
  //   —— 即：管理员只能删 教师/学生；教师只能删 学生
  if (!callerSuper && targetLevel >= callerLevel) {
    const allow = callerLevel === ROLE_LEVEL.admin ? '教师、学生' : '学生'
    return { code: 403, data: { msg: '权限不足：' + (callerRole === ADMIN ? '管理员' : '教师') + '仅可删除 ' + allow + ' 账号' } }
  }
  if (me && id && ('' + id).toUpperCase() === ('' + me.id).toUpperCase())
    return { code: 400, data: { msg: '不能删除当前登录的账号' } }
  return null
}

// users 是全局表，教师虽有层级权限，仍只能在本人带班范围内建/改/删学生账号。
function userScopeErr(scope, data, existing) {
  if (!ds.needGuard(scope) || scope.role !== 'teacher') return null
  if (existing) {
    const u = normUser(existing.fields)
    if (!ds.userVisible(scope, { id: u.id, cls: u.cls })) {
      return { code: 403, data: { msg: '只能管理本人带班的学生账号' } }
    }
  }
  const cls = String((data && data.cls) || '').trim()
  if (!cls && !existing) return { code: 403, data: { msg: '新增学生必须属于本人带班（归属班级须与带班一致）' } }
  if (cls && scope.classes.indexOf(cls) < 0) {
    return { code: 403, data: { msg: '不能把学生改到本人带班之外' } }
  }
  return null
}

// 保护：系统必须保留至少一名【启用中的超级管理员】。
// 背景：decideUserWrite 对 super 豁免了"不能改自己"的限制（否则超管改不了自己的姓名），
//   但也留下了自毁口子——唯一一名超管把自己降级/停用/删除后，全校再无管理入口：
//   清库、迁移、日志、门禁、创建管理员全部失效，只能进数据库手工改回。
//   这里在写入前做一次兜底裁决，任何人都无法绕过。
function lastSuperGuard(userObjs, targetId, nextRole, nextStatus) {
  const tid = ('' + (targetId || '')).trim().toUpperCase()
  const cur = (userObjs || []).find(u => ('' + (u.id || '')).trim().toUpperCase() === tid)
  if (!cur || cur.role !== SUPER || (cur.status || '启用') !== '启用') return null
  // 目标操作后仍是"启用中的 super" → 放行
  if (nextRole === SUPER && (nextStatus || '启用') === '启用') return null
  const others = (userObjs || []).filter(u =>
    ('' + (u.id || '')).trim().toUpperCase() !== tid &&
    u.role === SUPER && (u.status || '启用') === '启用')
  if (others.length) return null
  return { code: 400, data: { msg: '系统必须保留至少一名启用中的超级管理员，不能降级/停用/删除最后一个超管' } }
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
    // 新增（无 rid）且工号已存在 → 明确报错，避免把已有账号的姓名/角色静默覆盖掉
    if (!rid && rec) return { code: 409, data: { msg: '工号 ' + id + ' 已存在，请直接编辑该账号或换用工号' } }

    const su = rec ? normUser(rec.fields) : null
    const decision = decideUserWrite(me, {
      id,
      role,
      existingRole: su ? su.role : null,
      statusChanging: su ? (status !== (su.status || '启用')) : false
    })
    if (decision) return decision
    // 最后一个启用超管的保护（降级/停用自己）
    const superGuard = lastSuperGuard(allUsers.map(r => normUser(r.fields)), id, role, status)
    if (superGuard) return superGuard
    const scopeErr = userScopeErr(ds.currentScope(), data, rec)
    if (scopeErr) return scopeErr

    // 老师带班列表：仅 super / admin 可设置，且仅 teacher 角色有效。
    // 未显式提交时保留原值，避免编辑姓名/状态时把带班信息清空（导致隔离范围意外收窄）。
    const canSetScope = !!(me && (me.role === SUPER || me.role === ADMIN))
    const hasMC = Object.prototype.hasOwnProperty.call(data, 'managedClasses')
    const managedClasses = role === 'teacher'
      ? (canSetScope && hasMC ? ds.sanitizeManagedClasses(data.managedClasses) : (su ? su.managedClasses : ''))
      : ''
    // 教师必须配带班班级：漏配的后果是「静默失效」——
    // 行级隔离按 managedClasses 过滤，没配的老师看不到本班任何申请与流水，
    // 但账号在用户列表里看起来完全正常，现场只会表现为"老师反映看不到数据"，极难排查。
    // 这里直接拒绝建档/改档，逼着配置完整。
    if (role === 'teacher' && !managedClasses) {
      return { code: 400, data: { msg: '教师账号必须配置带班班级，否则看不到本班任何申请与流水' } }
    }
    const fields = {
      [COL.users.id]: id,
      [COL.users.name]: name,
      [COL.users.role]: TR.roleFwd[role] || role,
      [COL.users.cls]: cls,
      [COL.users.managedClasses]: managedClasses,
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
    const scopeErr = userScopeErr(ds.currentScope(), null, rec)
    if (scopeErr) return scopeErr
    const decision = decideUserDelete(me, su.role, id)
    if (decision) return decision
    // 最后一个启用超管的保护（删除自己）
    const superGuard = lastSuperGuard(list.map(r => normUser(r.fields)), id, null, null)
    if (superGuard) return superGuard
    // ⚠ 已绑定微信的账号禁止物理删除：
    //   删除会让 openid 随行一起消失 → 同一工号若被重建（错录账号清理后重建、或换人接手），
    //   新行处于「未绑定」状态，「一个工号被绑定后他人不可再绑」这条保护随之失效，
    //   任何人都能抢绑该工号（实测复现：删除→同名重建→另一微信绑定成功）。
    //   正确处理：停用（保留档案与绑定），确需删除则先「解绑」再删。
    if (su.openid) {
      return { code: 409, data: { msg: '该账号已绑定微信，不能直接删除：请改用「停用」（保留档案与绑定），或先「解绑」再删除' } }
    }
    await deleteRecordByIds('users', [rec.recordId])
    return { id }
  })
}

// 解除微信绑定（管理员）：清空该账号行的 openid，使该工号可以重新绑定。
//
// 为什么必须有它：bindLogin 在「该工号已绑定其他微信」时提示"请联系管理员清空该工号的绑定"，
//   但此前管理员根本没有清空绑定的入口（adminUpsertUser 不写 openid、前端也没有按钮）→ 换绑是死路：
//   本人换了微信号想重新登录、或管理员发现绑定录错，都只能进数据库手改。
// 解绑后该工号即可被重新绑定 —— 这正是"工号↔openid 一对一"能被管理员纠错的前提。
async function adminUnbindUser(data, me) {
  return withWriteLock(async () => {
    const id = ('' + (data && data.id || '')).trim().toUpperCase()
    if (!id) return { code: 400, data: { msg: '工号必填' } }
    const list = await getRecords('users', r => ('' + (r.fields[COL.users.id] || '')).trim().toUpperCase() === id)
    const rec = list[0]
    if (!rec) return { code: 404, data: { msg: '该工号不存在' } }
    const su = normUser(rec.fields)
    const scopeErr = userScopeErr(ds.currentScope(), null, rec)
    if (scopeErr) return scopeErr
    // 层级裁决与删除一致：super 任意；admin 仅教师/学生；teacher 仅学生
    const callerRole = me ? me.role : null
    const callerLevel = ROLE_LEVEL[callerRole] != null ? ROLE_LEVEL[callerRole] : -1
    const targetLevel = ROLE_LEVEL[su.role] != null ? ROLE_LEVEL[su.role] : -1
    if (callerLevel < ROLE_LEVEL.teacher) return { code: 403, data: { msg: '仅教师及以上可解绑账号' } }
    if (callerRole !== SUPER && targetLevel >= callerLevel) {
      const allow = callerLevel === ROLE_LEVEL.admin ? '教师、学生' : '学生'
      return { code: 403, data: { msg: '权限不足：' + (callerRole === ADMIN ? '管理员' : '教师') + '仅可解绑 ' + allow + ' 账号' } }
    }
    if (!su.openid) return { code: 400, data: { msg: '该账号尚未绑定微信，无需解绑' } }
    await updateRecord('users', rec.recordId, { [COL.users.openid]: '' })
    // 解绑是安全敏感操作，必须留痕（谁、何时、解了谁）
    ds.overrideOwnerCls(ds.readCls(rec.fields))
    await addRecord('logs', {
      [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: (me && me.id) || '',
      [COL.logs.op]: '解除微信绑定', [COL.logs.target]: id, [COL.logs.result]: '已解绑，该工号可重新绑定'
    })
    return { id, unbound: true }
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
  const qty = parseQty(data.qty)
  if (qty === null) return { code: 400, data: { msg: '数量必须是 1 ~ 1000000 之间的整数' } }
  const reason = ('' + (data.reason || '')).trim().slice(0, 60)
  if (!reason) return { code: 400, data: { msg: '请填写用途说明' } }
  const no = genNo('R')
  // 幂等键要能区分"不同的操作"：用途不同就是两次不同的申请，
  // 键里少了用途说明 → 5 秒内两次不同用途的申请，第二次会拿到第一次的单号，用途被吞。
  const idemKey = ['req', data.user || '', matId, qty, reason].join('|')
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
  // 键里必须带用途与借期：同一学生同一工具但借期不同（比赛/实训周期不同）是两次不同申请
  const idemKey = ['treq', data.user || '', toolId, reason, data.days || ''].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === toolId)
    if (!tools[0]) return { code: 400, data: { msg: '工具不存在：' + toolId } }
    await addRecord('requisitions', {
      [COL.requisitions.id]: no, [COL.requisitions.user]: data.user, [COL.requisitions.item]: toolId,
      [COL.requisitions.type]: '借出', [COL.requisitions.qty]: 1, [COL.requisitions.reason]: reason,
      // 借期：学生申请时填的天数（1~90），审批通过后按它算应还日期
      [COL.requisitions.days]: Math.min(90, Math.max(1, parseInt(data.days, 10) || DEFAULT_LOAN_DAYS)),
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
    // 与腾讯文档侧一致：审批产生的借还/流水/日志继承申请单班级（申请人所在班），
    // 避免多班老师审批时把别班学生的记录错标到自己的第一带班。
    ds.overrideOwnerCls(ds.readCls(req.fields))

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
        // 应还日期：审批人指定的借期 > 申请单里学生填的借期 > 默认 7 天
        [COL.borrow.out]: now(),
        [COL.borrow.plan]: planDue(data.days || req.fields[COL.requisitions.days]),
        [COL.borrow.in]: '', [COL.borrow.status]: '借出中',
        // 申请单里学生填的「用途说明」天然就是借出备注，直接带过来，无需再问一遍
        [COL.borrow.note]: ('' + (req.fields[COL.requisitions.reason] || '')).trim().slice(0, 120)
      })
      // 原子切换工具状态（CAS）：状态仍是「在库」才借出 → 同一件工具不会被借两次
      const toolSw = await atomicSwitchToolStatus(tool.recordId, '在库', '借出', { [COL.tools.holder]: applicant })
      // CAS 未命中 = 工具已被别人借走 → 与串行路径同口径回 400（不是 500 服务器故障）
      if (!toolSw) return { code: 400, data: { msg: '该工具不在库（已被他人借走）：' + toolId } }
      await Promise.all([
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
    // 归属班级继承「申请单」上的班级（= 申请人学生本人的班级），而不是 scope.ownerCls
    // （审批人是老师，ownerCls 是老师的班级）。否则学生领用流水不带班级，
    // 老师按班级查不到学生领用了什么，且行级隔离下会退化成"公共资源"对所有老师可见。
    const reqCls = ds.readCls(req.fields)
    const outFlow = {
      [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: matId,
      [COL.stock_io.dir]: '出库', [COL.stock_io.qty]: qty,
      [COL.stock_io.op]: applicant, [COL.stock_io.time]: now(), [COL.stock_io.note]: note, [COL.stock_io.src]: '领用出库'
    }
    if (reqCls) outFlow[COL.stock_io.cls] = reqCls

    // ===== 幂等闸门：检测本单此前是否已产生出库流水 =====
    // 审批是一次「扣库存 + 写出库流水 + 改申请单状态 + 写日志」的多步写。
    // 正常情况下步骤内的部分失败已被 verifyStock / verifyReqOutFlow / verifyReqApproved
    // 的「回读校验 + 补写重试」自愈；这里堵的是自愈也失败时抛错、老师按提示重试的那个窗口：
    //   上一次可能已经把库存扣了、却没把申请单状态改成「已通过」→ 状态检查放行 → 重试【再扣一次】，
    //   账面比流水多扣一份，而页面仍显示「已通过」，无人察觉。
    // 锚点用审批必写的 note（'领用申请 <单号>'）：不依赖可能缺列的 src
    //   （腾讯文档未手工加「来源类型」列时 buildValues 会跳过该列，src 恒空）。
    // 反向冲销流水的 note 是「冲销流水 …」，与本锚点不同，不会误命中。
    const priorOut = await getRecords('stock_io', r => ('' + (r.fields[COL.stock_io.note] || '')) === note)
    if (priorOut.length) {
      // 已经出库过 → 绝不二次扣减；只补齐申请单状态并留痕
      await updateRecord('requisitions', req.recordId, {
        [COL.requisitions.status]: '已通过', [COL.requisitions.approver]: data.actor
      })
      await addRecord('logs', Object.assign({
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor,
        [COL.logs.op]: '审批通过（幂等补齐）', [COL.logs.target]: data.no,
        [COL.logs.result]: '已补齐审批状态，库存未重复扣减'
      }, reqCls ? { [COL.logs.cls]: reqCls } : {}))
      return {
        idempotent: true, no: data.no,
        warn: '该申请此前已出库，本次未重复扣减库存；若账面与流水不符，请在库存页执行盘点核对'
      }
    }
    // 原子扣减（CAS）：期望值进条件 → 两个老师同时审批同一单也不会双扣库存
    const adj = await atomicAdjustStock(mat.recordId, -qty)
    if (!adj.ok) {
      if (adj.reason === 'insufficient') return { code: 400, data: { msg: `库存不足：当前 ${adj.stock}，申请 ${qty}` } }
      if (adj.reason === 'missing') return { code: 400, data: { msg: '物品不存在：' + matId } }
      throw new Error('审批未完全生效（申请 ' + data.no + '）：库存并发冲突，重试后仍未成功。请刷新后重试')
    }
    await Promise.all([
      updateRecord('requisitions', req.recordId, { [COL.requisitions.status]: '已通过', [COL.requisitions.approver]: data.actor }),
      addRecord('stock_io', outFlow),
      addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor, [COL.logs.op]: '审批通过', [COL.logs.target]: data.no, [COL.logs.result]: '已通过' })
    ])
    if (!(await verifyStock(matId, adj.stock))) {
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

// 审批撤销：只撤销「已通过」的申请，并回滚其账务影响。
// 耗材单：把审批产生的出库流水冲销（库存回补 + 写反向入库流水 + 原流水打 [已冲销]）。
// 工具单：把已生成的借还记录结清、工具回在库。
// 约束：① 仅「已通过」可撤，撤后状态=已撤销，二次撤销被拒；② 归属班级跟随申请单；
//       ③ 冲销/结清在本函数内内联完成——writeLock 不可重入，不能调用 reverseIO/returnTool；
//       ④ 若对应流水已冲销（历史手工冲销过），跳过重复回补，只改状态，避免二次加库存。
async function revokeApprove(data) {
  const no = '' + (data.no || '')
  if (!no) return { code: 400, data: { msg: '缺少申请单号' } }
  const why = ('' + (data.reason || '')).trim().slice(0, 60)
  return withWriteLock(async () => {
    const reqs = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.id]) === no)
    const req = reqs[0]
    if (!req) return { code: 404, data: { msg: '申请不存在：' + no } }
    const curStatus = '' + (req.fields[COL.requisitions.status] || '')
    if (curStatus !== '已通过') {
      return { code: 400, data: { msg: curStatus === '已撤销' ? '该申请已撤销，不可重复撤销' : '只有「已通过」的申请可以撤销（当前：' + (curStatus || '未知') + '）' } }
    }
    const f = req.fields
    ds.overrideOwnerCls(ds.readCls(f))
    const isTool = ('' + (f[COL.requisitions.type] || '')) === '借出'
    const info = { no, kind: isTool ? 'tool' : 'material', rolledBack: false }
    const cls = ds.readCls(f)

    if (isTool) {
      const toolId = '' + (f[COL.requisitions.item] == null ? '' : f[COL.requisitions.item])
      const applicant = '' + (f[COL.requisitions.user] == null ? '' : f[COL.requisitions.user])
      const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === toolId)
      const borrows = await getRecords('borrow', r =>
        ('' + r.fields[COL.borrow.tool]) === toolId && ('' + r.fields[COL.borrow.user]) === applicant &&
        ('' + r.fields[COL.borrow.status]) === '借出中')
      const writes = []
      if (tools[0] && ('' + tools[0].fields[COL.tools.holder]) === applicant) {
        // 原子回库（CAS）：状态仍是「借出」才置在库 → 不覆盖并发发生的新借出
        const backSw = await atomicSwitchToolStatus(tools[0].recordId, '借出', '在库', { [COL.tools.holder]: '' })
        if (!backSw) writes.push(updateRecord('tools', tools[0].recordId, { [COL.tools.status]: '在库', [COL.tools.holder]: '' }))
        info.rolledBack = true
      }
      for (const b of borrows) {
        writes.push(updateRecord('borrow', b.recordId, { [COL.borrow.status]: '已归还', [COL.borrow.in]: now() }))
        info.rolledBack = true
      }
      writes.push(updateRecord('requisitions', req.recordId, {
        [COL.requisitions.status]: '已撤销', [COL.requisitions.approver]: data.actor,
        [COL.requisitions.reject]: why || '审批撤销'
      }))
      writes.push(addRecord('logs', Object.assign({
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor,
        [COL.logs.op]: '审批撤销', [COL.logs.target]: no, [COL.logs.result]: info.rolledBack ? '已撤销并回滚' : '已撤销（无需回滚）'
      }, cls ? { [COL.logs.cls]: cls } : {})))
      await Promise.all(writes)
      // 工具路径：借还记录找不到「借出中」且工具已不在借用人名下 → 说明学生已自行归还，
      // 本来就没有可回滚的账务影响，属正常情况，不算异常。
      info.impact = info.rolledBack ? 'rolledBack' : 'none'
      return info
    }

    // 耗材：找到审批生成的出库流水（note='领用申请 <no>'，src='领用出库'）
    const matId = '' + (f[COL.requisitions.item] == null ? '' : f[COL.requisitions.item])
    const note = '领用申请 ' + no
    const flows = await getRecords('stock_io', r => {
      const fn = '' + (r.fields[COL.stock_io.note] || '')
      if (fn !== note) return false
      const src = '' + (r.fields[COL.stock_io.src] || '')
      // 「来源类型」列可能没在腾讯文档手工添加（buildValues 对不存在的列会 warn 并跳过），
      // src 恒空时不能据此判定「不是领用出库」——note 由审批写入，是可靠锚点。
      if (src && src !== '领用出库') return false
      return true
    })
    const out = flows.find(x => !isSettledFlow(x.fields))
    if (!out) {
      // 找不到账务影响：可能是这单本来就没产生出库流水，也可能是流水被删/被改过。
      // 绝不能静默当成「无需回滚」——否则库存没回来却看不出问题，账实不符。
      info.impact = 'missing'
      info.warn = '未找到该申请对应的出库流水，库存可能未回补，请人工核对库存'
    } else {
      const qty = Number(out.fields[COL.stock_io.qty]) || 0
      const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
      if (!mats[0]) return { code: 404, data: { msg: '关联物品不存在：' + matId } }
      const stock = Number(mats[0].fields[COL.materials.stock]) || 0
      const next = stock + qty
      const backCls = ds.readCls(out.fields) || cls
      await Promise.all([
        updateRecord('materials', mats[0].recordId, { [COL.materials.stock]: next }),
        updateRecord('stock_io', out.recordId, { [COL.stock_io.note]: '[已冲销] ' + (out.fields[COL.stock_io.note] || '') }),
        addRecord('stock_io', Object.assign({
          [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: matId, [COL.stock_io.dir]: '入库', [COL.stock_io.qty]: qty,
          [COL.stock_io.op]: data.actor, [COL.stock_io.time]: now(),
          [COL.stock_io.note]: '冲销流水 ' + ('' + out.fields[COL.stock_io.id]), [COL.stock_io.src]: '冲销'
        }, backCls ? { [COL.stock_io.cls]: backCls } : {}))
      ])
      if (!(await verifyStock(matId, next))) {
        throw new Error('撤销未完全生效：库存 ' + matId + ' 未回补，请刷新后重试')
      }
      info.rolledBack = true
      info.impact = 'rolledBack'
      info.stock = next
    }
    await updateRecord('requisitions', req.recordId, {
      [COL.requisitions.status]: '已撤销', [COL.requisitions.approver]: data.actor,
      [COL.requisitions.reject]: why || '审批撤销'
    })
    await addRecord('logs', Object.assign({
      [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor,
      [COL.logs.op]: '审批撤销', [COL.logs.target]: no,
      [COL.logs.result]: info.rolledBack ? '已撤销并回滚'
        : (info.impact === 'missing' ? '已撤销（未找到出库流水，库存未回补）' : '已撤销（无需回滚）')
    }, cls ? { [COL.logs.cls]: cls } : {}))
    return info
  })
}

// 批量驳回：一次写锁内驳回多条「待审批」申请，统一驳回原因，返回成功/跳过明细。
// 仅供已有 approve 权限调用；单条失败（状态已变/记录被删）不阻断其余条目。
async function batchReject(data) {
  const nos = Array.isArray(data.nos) ? data.nos.map(x => '' + x).filter(Boolean) : []
  if (!nos.length) return { code: 400, data: { msg: '请先选择要驳回的申请' } }
  const why = ('' + (data.reason || '')).trim().slice(0, 60)
  if (!why) return { code: 400, data: { msg: '请填写驳回原因' } }
  return withWriteLock(async () => {
    const okNos = [], skipped = []
    for (const no of nos) {
      const rows = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.id]) === no)
      const req = rows[0]
      if (!req || ('' + req.fields[COL.requisitions.status]) !== '待审批') {
        skipped.push({ no, reason: req ? '该申请已处理' : '申请不存在' })
        continue
      }
      ds.overrideOwnerCls(ds.readCls(req.fields))
      await updateRecord('requisitions', req.recordId, {
        [COL.requisitions.status]: '已拒绝', [COL.requisitions.approver]: data.actor, [COL.requisitions.reject]: why
      })
      await addRecord('logs', Object.assign({
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor,
        [COL.logs.op]: '审批拒绝', [COL.logs.target]: no, [COL.logs.result]: '已拒绝：' + why
      }, ds.readCls(req.fields) ? { [COL.logs.cls]: ds.readCls(req.fields) } : {}))
      okNos.push(no)
    }
    return { ok: okNos.length, skipped, nos: okNos }
  })
}

async function addMaterial(data) {
  const name = ('' + (data.name || '')).trim()
  if (!name) return { code: 400, data: { msg: '请填写物品名称' } }
  const unit = ('' + (data.unit || '')).trim() || '个'
  const qty = parseQty(data.qty, 0)
  if (qty === null) return { code: 400, data: { msg: '数量必须是 0 ~ 1000000 之间的整数' } }
  // 效期：填了就必须是能解析的日期，不能静默丢弃（丢了用户以为设了效期、实际没有 → 临期提醒不触发）
  const expParsed = expireTs(data.expire)
  if (expParsed === null) return { code: 400, data: { msg: '有效期格式不正确，请用日期选择器或 YYYY-MM-DD' } }
  const expTs = expParsed.ts
  const idemKey = ['addMat', data.actor || '', name, qty, data.spec || '', data.expire || ''].join('|')
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
      [COL.materials.status]: '正常',
      // 效期：此前只有读取与展示、全库无任何写入 → 库存页的「已过期/临期」提示永远不显示
      [COL.materials.expire]: expTs
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

// 批量导入耗材清单（设备清单 → materials 集合）：建或更新。
// 行为：按 id（优先）→ name 匹配已有；命中则更新描述字段并按需校准库存（差额写流水），
//       未命中则新建（自动 Mxxx 编号、建档入库流水）。整体单笔确认令牌覆盖，fail-closed。
async function importMaterials(data) {
  const rows = Array.isArray(data.rows) ? data.rows : []
  if (!rows.length) return { code: 400, data: { msg: '清单为空（rows 为空）' } }
  const actor = data.actor || ''
  const all = await getRecords('materials')
  let max = 0
  const byId = new Map(), byName = new Map()
  for (const r of all) {
    const f = r.fields
    const id = '' + (f[COL.materials.id] || '')
    const name = ('' + (f[COL.materials.name] || '')).trim()
    const m = /^\s*[Mm](\d+)\s*$/.exec(id)
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0)
    if (id) byId.set(id, r)
    if (name) byName.set(name, r)
  }
  const created = [], updated = [], skipped = []
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || {}
    const name = ('' + (raw.name || '')).trim()
    if (!name) { skipped.push({ idx: i + 1, reason: '缺名称，跳过' }); continue }
    const id = ('' + (raw.id || '')).trim()
    const spec = ('' + (raw.spec || '')).trim()
    const cat = ('' + (raw.cat || '')).trim() || '电子元件'
    const loc = ('' + (raw.loc || '')).trim()
    const unit = ('' + (raw.unit || '')).trim() || '个'
    const safe = Number(raw.safe) || 0
    const setStock = ('' + (raw.stock ?? '')).trim() !== ''
    const stockNum = setStock ? parseQty(raw.stock, 0) : 0
    if (setStock && stockNum === null) { skipped.push({ idx: i + 1, reason: '库存数量不是 0 ~ 1000000 的整数，跳过' }); continue }
    // 效期：Excel 里常见 2026/3/5、20260305 等形态 → 一并接受；实在认不出的才跳过该行
    const expParsed = expireTs(raw.expire)
    if (expParsed === null) { skipped.push({ idx: i + 1, reason: '有效期格式无法识别，跳过' }); continue }
    const expTs = expParsed.ts
    const existing = (id && byId.get(id)) || byName.get(name)
    if (existing) {
      const f = existing.fields
      const oldStock = Number(f[COL.materials.stock]) || 0
      const patch = {
        [COL.materials.spec]: spec, [COL.materials.cat]: cat, [COL.materials.loc]: loc,
        [COL.materials.unit]: unit, [COL.materials.safe]: safe
      }
      // 效期：清单里给了才覆盖（留空表示"不改动"，避免误清已录的效期）
      // 注意用外层已解析好的 expTs（数字）：此前内层又取一次，会把整个对象写进 expire 列
      if (expTs) patch[COL.materials.expire] = expTs
      if (setStock) patch[COL.materials.stock] = stockNum
      await updateRecord('materials', existing.recordId, patch)
      if (setStock && stockNum !== oldStock) {
        const diff = stockNum - oldStock
        await addRecord('stock_io', {
          [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: f[COL.materials.id],
          [COL.stock_io.dir]: diff > 0 ? (TR.ioFwd.in || '入库') : (TR.ioFwd.out || '出库'),
          [COL.stock_io.qty]: Math.abs(diff), [COL.stock_io.op]: actor,
          [COL.stock_io.time]: now(), [COL.stock_io.note]: '清单导入·期初校准', [COL.stock_io.src]: '清单导入'
        })
      }
      updated.push({ id: f[COL.materials.id], name })
    } else {
      max += 1
      const newId = id || ('M' + String(max).padStart(3, '0'))
      await addRecord('materials', {
        [COL.materials.id]: newId, [COL.materials.name]: name, [COL.materials.spec]: spec,
        [COL.materials.cat]: cat, [COL.materials.loc]: loc, [COL.materials.stock]: stockNum,
        [COL.materials.unit]: unit, [COL.materials.safe]: safe, [COL.materials.status]: '正常',
        [COL.materials.expire]: expTs
      })
      if (stockNum > 0) {
        await addRecord('stock_io', {
          [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: newId,
          [COL.stock_io.dir]: TR.ioFwd.in || '入库', [COL.stock_io.qty]: stockNum,
          [COL.stock_io.op]: actor, [COL.stock_io.time]: now(),
          [COL.stock_io.note]: '清单导入·建档入库', [COL.stock_io.src]: '清单导入'
        })
        await addRecord('logs', {
          [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: actor,
          [COL.logs.op]: '清单导入耗材', [COL.logs.target]: newId, [COL.logs.result]: '建档成功'
        })
      }
      created.push({ id: newId, name, stock: stockNum })
    }
  }
  return { created: created.length, updated: updated.length, skipped: skipped.length }
}

// 工具批量导入：与 importMaterials 同构。工具无库存概念（不写 stock_io），
// 按 id（→Txxx）→ name 匹配；命中则更新描述字段并记日志，未命中则新建（自动 Txxx 编号）。
async function importTools(data) {
  const rows = Array.isArray(data.rows) ? data.rows : []
  if (!rows.length) return { code: 400, data: { msg: '清单为空（rows 为空）' } }
  const actor = data.actor || ''
  const all = await getRecords('tools')
  let max = 0
  const byId = new Map(), byName = new Map()
  for (const r of all) {
    const f = r.fields
    const id = '' + (f[COL.tools.id] || '')
    const name = ('' + (f[COL.tools.name] || '')).trim()
    const m = /^\s*[Tt](\d+)\s*$/.exec(id)
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0)
    if (id) byId.set(id, r)
    if (name) byName.set(name, r)
  }
  const created = [], updated = [], skipped = []
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || {}
    const name = ('' + (raw.name || '')).trim()
    if (!name) { skipped.push({ idx: i + 1, reason: '缺名称，跳过' }); continue }
    const id = ('' + (raw.id || '')).trim()
    const spec = ('' + (raw.spec || '')).trim()
    const loc = ('' + (raw.loc || '')).trim()
    // 默认是「在库」而非「正常」：工具以「正常」入库后 borrow/approve 会判定「不在库」无法借出
    const status = ('' + (raw.status || '')).trim() || '在库'
    const holder = ('' + (raw.holder || '')).trim()
    const existing = (id && byId.get(id)) || byName.get(name)
    if (existing) {
      const f = existing.fields
      const patch = {
        [COL.tools.spec]: spec, [COL.tools.loc]: loc,
        [COL.tools.status]: status, [COL.tools.holder]: holder
      }
      await updateRecord('tools', existing.recordId, patch)
      await addRecord('logs', {
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: actor,
        [COL.logs.op]: '清单导入工具', [COL.logs.target]: f[COL.tools.id], [COL.logs.result]: '更新成功'
      })
      updated.push({ id: f[COL.tools.id], name })
    } else {
      max += 1
      const newId = id || ('T' + String(max).padStart(3, '0'))
      await addRecord('tools', {
        [COL.tools.id]: newId, [COL.tools.name]: name, [COL.tools.spec]: spec,
        [COL.tools.loc]: loc, [COL.tools.status]: status, [COL.tools.holder]: holder
      })
      await addRecord('logs', {
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: actor,
        [COL.logs.op]: '清单导入工具', [COL.logs.target]: newId, [COL.logs.result]: '建档成功'
      })
      created.push({ id: newId, name })
    }
  }
  return { created: created.length, updated: updated.length, skipped: skipped.length }
}

async function io(data) {
  const matId = ('' + data.matId || '').trim()
  if (!matId) return { code: 400, data: { msg: '请选择耗材' } }
  if (data.type !== 'in' && data.type !== 'out') return { code: 400, data: { msg: '登记方向必须是 in / out' } }
  const qty = parseQty(data.qty)
  if (qty === null) return { code: 400, data: { msg: '数量必须是 1 ~ 1000000 之间的整数' } }
  // 键里必须带备注：同物品同方向同数量但备注不同（例如分两批到货），
  // 少了备注 → 5 秒内第二笔会被静默吞掉，库存少加且用户毫无察觉。
  const idemKey = ['io', data.actor || '', matId, data.type, qty, data.note || ''].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
    const mat = mats[0]
    if (!mat) return { code: 400, data: { msg: '物品不存在：' + matId } }
    const delta = (data.type === 'in' ? 1 : -1) * qty
    // 原子增减（CAS）：把读到的期望值写进条件，由数据库保证原子性 →
    // 多实例部署时两个老师同时入库也不会互相覆盖（少加/双加）。
    const adj = await atomicAdjustStock(mat.recordId, delta)
    if (!adj.ok) {
      if (adj.reason === 'insufficient') return { code: 400, data: { msg: `库存不足：当前 ${adj.stock}` } }
      if (adj.reason === 'missing') return { code: 400, data: { msg: '物品不存在：' + matId } }
      throw new Error('库存更新未生效（并发冲突，重试后仍未成功）。请刷新后重试')
    }
    const next = adj.stock
    await Promise.all([
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
    const qty = parseQty(it.qty)
    if (qty === null) return { code: 400, data: { msg: '数量必须是 1 ~ 1000000 之间的整数：' + matId } }
    merged.set(matId, (merged.get(matId) || 0) + qty)
  }
  if (!merged.size) return { code: 400, data: { msg: '没有有效的登记数据' } }
  // 幂等键必须带备注与来源：同一物品、同一数量但备注不同（分两批到货）是两次不同的入库。
  // 键里少了备注 → 5 秒内第二笔被幂等窗口静默吞掉，库存少加，而返回值仍是第一笔的
  // 「成功」副本（已实测复现：库存 10→15，第二笔 5 卷凭空消失，流水只有 1 条）。
  const idemKey = ['batchIo', actor, type, data.note || '', data.src || ''].concat([...merged.entries()].map(([k, v]) => k + ':' + v)).join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const details = []
    let done = 0
    for (const [matId, qty] of merged) {
      const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
      const mat = mats[0]
      if (!mat) { details.push({ matId, qty, err: '物品不存在' }); continue }
      const delta = (type === 'in' ? 1 : -1) * qty
      // 原子增减（CAS）：并发批量补货时不会丢更新，也不会把库存扣成负
      const adj = await atomicAdjustStock(mat.recordId, delta)
      if (!adj.ok) {
        if (adj.reason === 'insufficient') { details.push({ matId, qty, err: '库存不足（当前 ' + adj.stock + '）' }); continue }
        if (adj.reason === 'missing') { details.push({ matId, qty, err: '物品不存在' }); continue }
        details.push({ matId, qty, err: '并发冲突，重试后仍未成功' }); continue
      }
      const next = adj.stock
      await Promise.all([
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
  // 时间倒序 + 单号倒序：只用时间排序时，同一毫秒的多条流水顺序不确定，
  // 分页读取时可能造成"某行重复出现/整行漏掉"（审计日志漏行不可接受）。
  filtered.sort((a, b) => {
    const d = ('' + (b.fields[COL.stock_io.time] || '')).localeCompare('' + (a.fields[COL.stock_io.time] || ''))
    return d !== 0 ? d : ('' + (b.fields[COL.stock_io.id] || '')).localeCompare('' + (a.fields[COL.stock_io.id] || ''))
  })
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
      // 反向流水也已结清，不能再冲销；前端据此隐藏按钮
      reversed: isSettledFlow(f),
      cls: ds.readCls(f)
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

// ===== 教师端「领用记录」查询 =====
// 老师此前无法查看「学生领取使用了什么耗材」：
//   · io 页是出入库操作台，不是查询台；
//   · approve 页只看待审批，审批完就没了；
//   · usage 页是聚合统计，看不到逐条明细。
// 本接口以「申请单」为主表（它带申请人/班级/用途/审批人），联查物品名，
// 支持按班级/物品/领用人/状态/时间筛选，并受行级隔离约束（老师只看本班+公共）。
// 待交付清单：审批已通过、但实物还没确认交到学生手里的单子。
// 审批通过时库存已扣；这里只做「实物发料」的现场确认，不再动账（避免二次扣减）。
// 默认只看近 30 天的单：上线瞬间历史已通过单会一次性涌出来，30 天窗口可避开。
async function listDeliveries(data) {
  const d0 = data || {}
  const days = Math.max(0, Number(d0.days) || 30)   // 0 = 不限时间窗
  const showDelivered = !!d0.showDelivered
  const reqs = await getRecords('requisitions')
  const mats = await getRecords('materials')
  const tools = await getRecords('tools')
  const users = await getRecords('users')
  const nameOf = {}
  for (const r of mats) nameOf['' + r.fields[COL.materials.id]] = r.fields[COL.materials.name] || ''
  for (const r of tools) nameOf['' + r.fields[COL.tools.id]] = r.fields[COL.tools.name] || ''
  const userOf = {}
  for (const r of users) {
    const f = r.fields
    userOf['' + (f[COL.users.id] || '')] = { name: f[COL.users.name] || '', cls: ('' + (f[COL.users.cls] || '')).trim() }
  }
  const dayMs = 86400000
  const nowMs = Date.now()
  const p2 = n => ('' + n).padStart(2, '0')
  const cut = new Date(nowMs - days * dayMs + 8 * 3600 * 1000)
  const cutStr = `${cut.getUTCFullYear()}-${p2(cut.getUTCMonth() + 1)}-${p2(cut.getUTCDate())} ${p2(cut.getUTCHours())}:${p2(cut.getUTCMinutes())}`
  const rows = []
  for (const r of reqs) {
    const f = r.fields
    if (('' + (f[COL.requisitions.status] || '')) !== '已通过') continue
    const delivered = f[COL.requisitions.delivered] || ''
    if (delivered ? !showDelivered : showDelivered) continue
    const timeVal = f[COL.requisitions.time]
    const ts = Number(timeVal) || 0
    const timeStr = '' + (timeVal || '')
    if (days > 0) {
      if (ts) { if (nowMs - ts > days * dayMs) continue }
      else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(timeStr)) { if (timeStr < cutStr) continue }
    }
    const q = normReq(f)
    const itemId = '' + (f[COL.requisitions.item] || '')
    const u = userOf['' + (f[COL.requisitions.user] || '')] || {}
    rows.push(Object.assign(q, {
      itemName: nameOf[itemId] || '',
      userName: u.name || '',
      userCls: u.cls || '',
      delivered: delivered ? fmtTs(delivered) : ''
    }))
  }
  rows.sort((a, b) => ('' + b.time).localeCompare('' + a.time))
  return { rows, total: rows.length }
}

// 确认交付：把「审批通过但东西还没交」的申请标记为已交付，只留痕「实物已发出」，不再动库存。
async function confirmDelivery(data) {
  const no = '' + (data.no || '')
  if (!no) return { code: 400, data: { msg: '缺少申请单号' } }
  return withWriteLock(async () => {
    const reqs = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.id]) === no)
    const req = reqs[0]
    if (!req) return { code: 404, data: { msg: '申请不存在：' + no } }
    const status = '' + (req.fields[COL.requisitions.status] || '')
    if (status !== '已通过') {
      return { code: 400, data: { msg: '只有「已通过」的申请可以确认交付（当前：' + (status || '未知') + '）' } }
    }
    if (req.fields[COL.requisitions.delivered]) {
      return { code: 400, data: { msg: '该单已确认交付，请勿重复操作' } }
    }
    // 日志继承申请单班级（申请人是学生，管理员/教师只是代为发料）
    ds.overrideOwnerCls(ds.readCls(req.fields))
    const ts = now()
    await updateRecord('requisitions', req.recordId, { [COL.requisitions.delivered]: ts })
    await addRecord('logs', {
      [COL.logs.id]: genNo('L'), [COL.logs.time]: ts, [COL.logs.actor]: data.actor || '',
      [COL.logs.op]: '确认交付', [COL.logs.target]: no, [COL.logs.result]: '已交付'
    })
    return {}
  })
}

// 单件工具建档（教师及以上，与耗材建档权限对齐）：
//   批量导入 importTools 是管理员专属（可按编号/名称覆盖更新台账），
//   而现场登记一件工具不该有「覆盖」语义，也不该只有管理员能做 → 独立动作。
async function addTool(data) {
  const name = ('' + (data.name || '')).trim()
  if (!name) return { code: 400, data: { msg: '请填写工具名称' } }
  const spec = ('' + (data.spec || '')).trim()
  const loc = ('' + (data.loc || '')).trim()
  const wantId = ('' + (data.id || '')).trim()
  const idemKey = ['addTool', data.actor || '', name, wantId].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const all = await getRecords('tools')
    const byName = all.find(r => ('' + (r.fields[COL.tools.name] || '')).trim() === name)
    if (byName) {
      return { code: 409, data: { msg: '已有同名工具（' + ('' + byName.fields[COL.tools.id]) + '），请直接给它贴标签，或在批量建档里更新规格' } }
    }
    if (wantId) {
      const byId = all.find(r => ('' + (r.fields[COL.tools.id] || '')).trim().toUpperCase() === wantId.toUpperCase())
      if (byId) return { code: 409, data: { msg: '该编号已被占用：' + wantId } }
    }
    let max = 0
    for (const r of all) {
      const m = /^\s*[Tt](\d+)\s*$/.exec('' + r.fields[COL.tools.id])
      if (m) max = Math.max(max, parseInt(m[1], 10) || 0)
    }
    const newId = wantId || ('T' + String(max + 1).padStart(3, '0'))
    const ts = now()
    await addRecord('tools', {
      [COL.tools.id]: newId, [COL.tools.name]: name, [COL.tools.spec]: spec,
      [COL.tools.loc]: loc, [COL.tools.status]: '在库', [COL.tools.holder]: ''
    })
    await addRecord('logs', {
      [COL.logs.id]: genNo('L'), [COL.logs.time]: ts, [COL.logs.actor]: data.actor || '',
      [COL.logs.op]: '新增工具', [COL.logs.target]: newId, [COL.logs.result]: '建档成功'
    })
    return { id: newId, name, status: '在库' }
  }))
}

async function listClaims(data) {
  const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
  const offset = Math.max(0, Number(data.offset) || 0)
  const clsFilter = ('' + (data.cls || '')).trim()
  const itemKw = ('' + (data.item || '')).trim().toUpperCase()
  const userKw = ('' + (data.user || '')).trim().toUpperCase()
  const status = ('' + (data.status || '')).trim()
  const from = Number(data.from) || 0
  const to = Number(data.to) || 0

  const reqs = await getRecords('requisitions')
  const mats = await getRecords('materials')
  const nameMap = {}
  const unitMap = {}
  for (const r of mats) {
    const id = '' + r.fields[COL.materials.id]
    nameMap[id] = r.fields[COL.materials.name] || ''
    unitMap[id] = r.fields[COL.materials.unit] || ''
  }
  // 领用人 → 姓名/班级（申请单里存的是工号，展示要换成姓名）
  const users = await getRecords('users')
  const userMap = {}
  for (const r of users) {
    const f = r.fields
    userMap['' + (f[COL.users.id] || '')] = {
      name: f[COL.users.name] || '',
      cls: ('' + (f[COL.users.cls] || '')).trim()
    }
  }

  const filtered = reqs.filter(r => {
    const f = r.fields
    const item = ('' + (f[COL.requisitions.item] || '')).trim()
    const user = ('' + (f[COL.requisitions.user] || '')).trim()
    const rc = ds.readCls(f)
    if (clsFilter && rc !== clsFilter) return false
    if (itemKw && item.toUpperCase().indexOf(itemKw) < 0) {
      // 允许按物品名称搜（工号搜不到时用名称）
      const nm = ('' + (nameMap[item] || '')).toUpperCase()
      if (nm.indexOf(itemKw) < 0) return false
    }
    if (userKw && user.toUpperCase().indexOf(userKw) < 0) {
      const nm = ('' + ((userMap[user] || {}).name || '')).toUpperCase()
      if (nm.indexOf(userKw) < 0) return false
    }
    if (status && ('' + (f[COL.requisitions.status] || '')).trim() !== status) return false
    const t = Number(f[COL.requisitions.time]) || 0
    if (from && t && t < from) return false
    if (to && t && t > to) return false
    return true
  })
  filtered.sort((a, b) => {
    const d = (Number(b.fields[COL.requisitions.time]) || 0) - (Number(a.fields[COL.requisitions.time]) || 0)
    return d !== 0 ? d : ('' + (b.fields[COL.requisitions.id] || '')).localeCompare('' + (a.fields[COL.requisitions.id] || ''))
  })

  const total = filtered.length
  const pageRows = filtered.slice(offset, offset + limit)
  const rows = pageRows.map(r => {
    const f = r.fields
    const item = ('' + (f[COL.requisitions.item] || '')).trim()
    const user = ('' + (f[COL.requisitions.user] || '')).trim()
    const u = userMap[user] || {}
    return {
      no: f[COL.requisitions.id] || '',
      item,
      itemName: nameMap[item] || item,
      unit: unitMap[item] || '',
      qty: Number(f[COL.requisitions.qty]) || 0,
      user,
      userName: u.name || user,
      // 流水上的班级优先（领用出库流水继承自申请单），否则回退用户档案班级
      cls: ds.readCls(f) || u.cls || '',
      reason: f[COL.requisitions.reason] || '',
      reject: f[COL.requisitions.reject] || '',
      approver: f[COL.requisitions.approver] || '',
      status: TR.reqRev[f[COL.requisitions.status]] || f[COL.requisitions.status] || '',
      time: fmtTs(f[COL.requisitions.time]) || ''
    }
  })
  // 汇总：按班级统计领用数量（老师最关心"哪个班领了多少"）
  const byCls = {}
  filtered.forEach(r => {
    const f = r.fields
    const user = ('' + (f[COL.requisitions.user] || '')).trim()
    const rc = ds.readCls(f) || ((userMap[user] || {}).cls) || ''
    const key = rc || '未标注班级'
    if (!byCls[key]) byCls[key] = { cls: key, qty: 0, count: 0 }
    byCls[key].qty += (Number(f[COL.requisitions.qty]) || 0)
    byCls[key].count += 1
  })
  return {
    rows,
    total,
    offset,
    limit,
    hasMore: offset + rows.length < total,
    byCls: Object.values(byCls).sort((a, b) => b.qty - a.qty),
    classOptions: Array.from(new Set(
      filtered.map(r => {
        const f = r.fields
        const user = ('' + (f[COL.requisitions.user] || '')).trim()
        return ds.readCls(f) || ((userMap[user] || {}).cls) || ''
      }).filter(Boolean)
    )).sort()
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
  filtered.sort((a, b) => {
    const d = ('' + (b.fields[COL.logs.time] || '')).localeCompare('' + (a.fields[COL.logs.time] || ''))
    return d !== 0 ? d : ('' + (b.fields[COL.logs.id] || '')).localeCompare('' + (a.fields[COL.logs.id] || ''))
  })
  const total = filtered.length
  const offset = Math.max(0, Number(data.offset) || 0)
  const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
  const rows = filtered.slice(offset, offset + limit).map(r => {
    const f = r.fields
    return {
      id: f[COL.logs.id] || '', time: fmtTs(f[COL.logs.time]) || '',
      actor: f[COL.logs.actor] || '', op: f[COL.logs.op] || '',
      target: f[COL.logs.target] || '', result: f[COL.logs.result] || '',
      cls: ds.readCls(f)
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
  filtered.sort((a, b) => {
    const d = ('' + (b.fields[COL.access.time] || '')).localeCompare('' + (a.fields[COL.access.time] || ''))
    return d !== 0 ? d : ('' + (b.fields[COL.access.id] || '')).localeCompare('' + (a.fields[COL.access.id] || ''))
  })
  const total = filtered.length
  const offset = Math.max(0, Number(data.offset) || 0)
  const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
  const rows = filtered.slice(offset, offset + limit).map(r => {
    const f = r.fields
    return {
      id: f[COL.access.id] || '', time: fmtTs(f[COL.access.time]) || '',
      user: f[COL.access.user] || '', point: f[COL.access.point] || '',
      result: f[COL.access.result] || '',
      cls: ds.readCls(f)
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
    if (isSettledFlow(f)) {
      return { code: 400, data: { msg: '该流水已冲销或本身就是冲销产生的反向流水，不可再次冲销' } }
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
    // 反向流水/日志跟随原流水班级，避免按班对账差一笔、或退化成公共资源
    const reverseCls = ds.readCls(f)
    // 原子回滚（CAS）：期望值进条件 → 并发冲销/领用不会把库存改错
    const adj = await atomicAdjustStock(mat.recordId, dir === '入库' ? -qty : qty)
    if (!adj.ok) {
      if (adj.reason === 'insufficient') return { code: 400, data: { msg: '冲销后库存为负（当前 ' + adj.stock + '，需退回 ' + qty + '）' } }
      if (adj.reason === 'missing') return { code: 400, data: { msg: '关联物品不存在：' + matId } }
      throw new Error('冲销未完全生效（流水 ' + no + '）：库存并发冲突，重试后仍未成功。请刷新后重试')
    }
    await Promise.all([
      updateRecord('stock_io', rec.recordId, { [COL.stock_io.note]: '[已冲销] ' + (f[COL.stock_io.note] || '') }),
      addRecord('stock_io', Object.assign({
        [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: matId,
        [COL.stock_io.dir]: backDir, [COL.stock_io.qty]: qty,
        [COL.stock_io.op]: data.actor, [COL.stock_io.time]: now(),
        [COL.stock_io.note]: '冲销流水 ' + no, [COL.stock_io.src]: '冲销'
      }, reverseCls ? { [COL.stock_io.cls]: reverseCls } : {})),
      addRecord('logs', Object.assign({
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor,
        [COL.logs.op]: '冲销出入库流水', [COL.logs.target]: no, [COL.logs.result]: '已冲销'
      }, reverseCls ? { [COL.logs.cls]: reverseCls } : {}))
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
      [COL.borrow.out]: now(), [COL.borrow.plan]: planDue(data.days), [COL.borrow.in]: '', [COL.borrow.status]: '借出中',
      // 借出备注：用途、临时借用说明等（教师直接借出与审批通过两条路径共用）
      [COL.borrow.note]: ('' + (data.note || '')).trim().slice(0, 120)
    })
    // 原子切换工具状态（CAS）：状态仍是「在库」才借出 → 同一件工具不会被并发借出两次
    const toolSw = await atomicSwitchToolStatus(tool.recordId, '在库', '借出', { [COL.tools.holder]: user })
    // CAS 未命中 = 工具已被别人借走 → 与串行路径同口径回 400（不是 500 服务器故障）
    if (!toolSw) return { code: 400, data: { msg: '该工具不在库（已被他人借走）：' + toolId } }
    await Promise.all([
      addRecord('borrow', borrowPayload()),
      // actor=操作人（教师直接借出时是老师），user=实际借用人；自借时两者相同
      addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor || user, [COL.logs.op]: '借出工具', [COL.logs.target]: toolId, [COL.logs.result]: '借出中' })
    ])
    if (!(await verifyToolOut(toolId, tool, user, borrowPayload))) {
      throw new Error('借出未完全生效（工具 ' + toolId + '）。请刷新后重试')
    }
    return {}
  })
}

// 教师直接借出：不必等学生申请，登记「某工具现在借给了某人」。
// 归属班级跟随【借用人】而非操作老师，确保流水落在借用人本班、任课教师可见、按班对账正确。
async function directBorrow(data) {
  const borrowerId = ('' + (data.borrower || '')).trim().toUpperCase()
  if (!borrowerId) return { code: 400, data: { msg: '请填写借用工号' } }
  const fu = await findUser(borrowerId)
  if (!fu || !fu.user) return { code: 404, data: { msg: '借用人不存在或已停用：' + borrowerId } }
  const cls = fu.user.cls || ''
  ds.overrideOwnerCls(cls)
  return borrow({
    toolId: data.toolId, user: fu.user.id, actor: data.actor,
    days: data.days, reason: data.reason, note: data.note
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
    const backNote = ('' + (data.note || '')).trim().slice(0, 120)
    const needRepair = !!tool && toolStatus === '借出'
    if (!rec && !needRepair) {
      // 这是用户操作问题（重复归还 / 工具从未借出），不是服务器故障 →
      // 必须回 400 业务错误；用 throw 会被当成 500，前端只能显示"操作失败"，
      // 老师看不出到底是自己重复归还了还是系统坏了。
      return { code: 400, data: { msg: '没有可归还的记录：' + toolId +
        (tool ? '（当前状态：' + (toolStatus || '未知') + '）' : '（工具不存在）') } }
    }
    if (needRepair) await repairToolRow('tools', tool.recordId)
    if (rec) {
      await updateRecord('borrow', rec.recordId, {
        [COL.borrow.status]: '已归还', [COL.borrow.in]: now(),
        // 归还入库时的验收备注（完好/缺件/需维修）
        [COL.borrow.backNote]: backNote
      })
    } else {
      console.warn('[clouddb] returnTool 自愈：' + toolId + ' 无「借出中」借还记录，已直接修复工具行')
    }
    await addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor, [COL.logs.op]: '归还工具', [COL.logs.target]: toolId,
      [COL.logs.result]: '已归还' + (backNote ? '：' + backNote : '') })
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
      if (sheetKey === 'tools') {
        // 原子切换（CAS）：状态仍是「借出」才置为在库 → 不会覆盖并发发生的新借出。
        // 归还时若这件工具刚被另一位老师借走，这里就不动它（CAS 不命中）。
        const sw = await atomicSwitchToolStatus(recordId, '借出', '在库', { [COL.tools.holder]: '' })
        if (sw) return true
      }
      // CAS 未命中（状态本就不是「借出」，属于状态异常）：走无条件修复 + 回读校验
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
  let s = (v === null || v === undefined) ? '' : '' + v
  // CSV 公式注入防护：以 = + - @ 开头（含前导空白）的单元格会被 Excel/WPS 当成公式执行，
  //   清单里若被塞进 =HYPERLINK(...) 之类，打开导出的 CSV 就会触发钓鱼；
  //   同时合法值（「+5V模块」「-40℃环境」）也会被 Excel 显示成 #NAME?。
  // 前置单引号 → Excel 按文本处理，粘贴后仍显示原值；导入侧 unguardFormula 会还原。
  if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s
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
    // 列序必须与「批量建档导入」的解析顺序一致（名称在前、编号在后）：
    //   此前导出是「耗材ID,名称,…,当前库存,单位,…」而导入按「名称,编号,…,单位,期初库存,…」解析，
    //   导致用户「导出→改→再导入」会把 ID 当成名称、单位当库存数，把台账写坏。
    //   导出再带上「有效期」，否则往返一次效期就没了。
    header = ['名称', '耗材ID', '规格', '类别', '存放位置', '单位', '当前库存', '预警线', '有效期']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.materials.name], f[COL.materials.id], f[COL.materials.spec] || '', f[COL.materials.cat] || '',
      f[COL.materials.loc] || '', f[COL.materials.unit] || '', Number(f[COL.materials.stock]) || 0,
      Number(f[COL.materials.safe]) || 0,
      f[COL.materials.expire] ? fmtTs(f[COL.materials.expire]) : ''
    ] })
    name = '耗材库存清单'
  } else if (kind === 'tools') {
    const list = await getRecords('tools')
    // 列序与「批量建档导入」一致（名称在前、编号在后），否则导出再导入会写坏
    header = ['名称', '工具ID', '规格', '存放位置', '状态', '当前持有人']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.tools.name], f[COL.tools.id], f[COL.tools.spec] || '', f[COL.tools.loc] || '',
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
    const real = parseQty(it.real, 0)
    if (real === null) {
      return { code: 400, data: { msg: '实盘数量必须是 0 ~ 1000000 之间的整数：' + matId } }
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
      // 原子写实盘（CAS）：条件是读到的账面值 → 盘点与领用并发时不会互相覆盖
      const adj = await casUpdate('materials', mat.recordId,
        { [COL.materials.stock]: book }, { [COL.materials.stock]: next })
      if (!adj.ok) { details.push({ matId: it.matId, name: mat.fields[COL.materials.name] || '', book, real: it.real, diff, err: '库存已被并发改动，请重新盘点' }); continue }
      await Promise.all([
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
    // 低库存阈值口径必须与前端一致（前端 4 处均为 stock < safe）：库存恰好等于安全线视为「已达标」
    // 不预警。后端曾用 <= → 统计页「低库存物品数」与库存页/补货列表对不上（老师按简报去补货却找不到该项）。
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
  const [userRows, materialRows, toolRows, reqRows, borrowRows, ioRows, accessRows, logRows,
    labRows, repairRows, inspectionRows] = await Promise.all([
    getRecords('users'), getRecords('materials'), getRecords('tools'),
    getRecords('requisitions'), getRecords('borrow'), getRecords('stock_io'),
    getRecords('access'), getRecords('logs'),
    getRecords('labs'), getRecords('repairs'), getRecords('inspections')
  ])
  const userList = userRows
    .map(r => {
      const u = normUser(r.fields)
      return {
        rid: r.recordId,
        id: u.id, name: u.name, role: u.role, cls: u.cls,
        managedClasses: u.managedClasses || '',
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
    logs: logRows.map(r => normLog(r.fields)),
    // 备份必须覆盖全部 11 张表：此前漏掉实训室/报修/巡检，恢复后这三块业务数据会永久丢失。
    labs: labRows.map(r => normLab(r.fields)),
    repairs: repairRows.map(r => normRepair(r.fields)),
    inspections: inspectionRows.map(r => normInspection(r.fields)),
    generatedAt: now(),
    version: 1
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
    createdAt: fmtTs(f[COL.repairs.createdAt]), updatedAt: fmtTs(f[COL.repairs.updatedAt]),
    cls: ds.readCls(f)
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
    createdAt: fmtTs(f[COL.inspections.createdAt]), doneAt: fmtTs(f[COL.inspections.doneAt]),
    cls: ds.readCls(f)
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
  // 幂等键要能区分两次不同的报修：同一教师对同一实训室报两条同名故障（如两盏灯都坏，
  // 都写「灯管坏」）是两次独立报修 → 键里少了区分字段时第二单被幂等窗口吞掉，
  // 返回第一条的单号、库里只剩一条，故障记录凭空消失（已实测复现）。
  const idemKey = ['addRepair', data.actor || '', labId, title, (data.category || ''), (data.desc || ''), (data.priority || '')].join('|')
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
  // 必须先按原始时间戳排序：normInspection 会把 createdAt 转成展示字符串，
  // 之后再 Number() 会得到 NaN，比较器恒为 0，排序等于没做（报修页已是正确写法）。
  list.sort((a, b) => (Number(b.fields[COL.inspections.createdAt]) || 0) - (Number(a.fields[COL.inspections.createdAt]) || 0))
  let arr = list.map(r => normInspection(r.fields))
  if (f.labId) arr = arr.filter(x => ('' + x.labId).trim().toUpperCase() === ('' + f.labId).trim().toUpperCase())
  if (f.status) {
    if (f.status === '已逾期') arr = arr.filter(x => x.status === '待巡检' && x.overdue)
    else arr = arr.filter(x => x.status === f.status)
  }
  return arr
}
async function addInspection(data) {
  const title = ('' + (data.title || '')).trim()
  const labId = ('' + (data.labId || '')).trim().toUpperCase()
  if (!title) return { code: 400, data: { msg: '请填写巡检任务名称' } }
  if (!labId) return { code: 400, data: { msg: '请选择归属实训室' } }
  // 同理：同名同实训室的巡检任务是两次独立任务，计划日期/执行人都不同则不能被判为重复
  const idemKey = ['addInsp', data.actor || '', labId, title, (data.planDate || ''), (data.executorId || '')].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const lab = await getLab(labId)
    if (!lab) return { code: 404, data: { msg: '归属实训室不存在' } }
    const ts = now()
    const newId = 'I' + ('' + ts).slice(-10) + Math.floor(Math.random() * 90 + 10)
    await addRecord('inspections', {
      [COL.inspections.id]: newId, [COL.inspections.labId]: labId, [COL.inspections.labName]: lab.name,
      [COL.inspections.title]: title, [COL.inspections.planDate]: ('' + (data.planDate || '')).trim(),
      // 执行人可指派：executorId 为空时默认创建人；有值时按指派写入（建单即派活）
      [COL.inspections.executorId]: ('' + (data.executorId || data.actor || '')).trim(),
      [COL.inspections.executorName]: ('' + (data.executorName || data.executorId || data.actor || '')).trim(),
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

// 清空全库数据（super 专属，须二次确认；见 index.js case 'clearAllData'）。
// 默认保留 users 表——否则把执行清库的 super 账号自身也删掉，会导致无人可登录的鸡生蛋死锁。
// opts.includeUsers === true 时显式连用户表一起清（调用方需自担"清完无法登录"后果）。
// 逐表 getRecords → deleteRecordByIds，逐表计数；单表失败不影响其余表，结果里如实回报。
async function clearAllData(opts) {
  const o = opts || {}
  const includeUsers = o.includeUsers === true
  // 全 11 张表；默认跳过 users。顺序：业务流水在前、基础台账在后、users 最后。
  const allTables = ['requisitions', 'borrow', 'stock_io', 'access', 'logs', 'repairs', 'inspections', 'labs', 'tools', 'materials', 'users']
  const targets = allTables.filter(t => includeUsers || t !== 'users')
  const result = { cleared: {}, skipped: [], errors: [], total: 0, includeUsers }
  for (const t of targets) {
    if (t === 'users' && !includeUsers) { result.skipped.push(t); continue }
    try {
      const rows = await getRecords(t, null, { noCache: true })
      const ids = rows.map(r => r.recordId).filter(Boolean)
      const n = ids.length ? await deleteRecordByIds(t, ids) : 0
      result.cleared[t] = n
      result.total += n
    } catch (e) {
      result.errors.push({ table: t, msg: (e && e.message) || String(e) })
      result.cleared[t] = 0
    }
  }
  return result
}

module.exports = {
  TABLE, CFG, COL, TR, runtimeInfo, warmFieldMaps,
  getToken, authorizeWithCode, callSmart, callApi, getFieldMap, buildValues,
  getRecords, addRecord, updateRecord, deleteRecordByIds, getItem,
  casUpdate, atomicAdjustStock, atomicSwitchToolStatus,
  invalidateCache, cacheStats, clearFieldMapCache,
  listMaterials, listTools, listMine, listPending, search,
  findUser, listUsers, ensureOpenIdColumn, bindOpenId, findUserByOpenId, findUserByRobotKey, setRobotKey, whoami, bindLogin,
  adminListUsers, listAllUsersForAudit, listStaff, adminUpsertUser, adminDeleteUser, adminUnbindUser, decideUserWrite, decideUserDelete,
  requisition, toolRequisition, approve, revokeApprove, batchReject, cancelReq, io, borrow, directBorrow, returnTool, access, usage, snapshot,
  addMaterial, addTool, listStockIO, listClaims, listDeliveries, confirmDelivery, exportData, stocktake, listLogs, reverseIO, batchIo, listAccess, importMaterials, importTools,
  // 实训室归属管理体系（labs / repairs / inspections）
  listLabs, getLab, addLab, updateLab, deleteLab,
  listRepairs, addRepair, updateRepair,
  listInspections, addInspection, updateInspection, labOverview,
  // 清库（super 专属，二次确认；默认保留 users）
  clearAllData,
  // 测试/本地注入用（非契约，但导出便于单测）
  __setDbForTest
}
