// 云函数 docsProxy —— 中继层
// 职责：持有腾讯文档密钥（仅服务端）、封装文档 API、写操作串行化、权限校验、留痕。
// 部署：微信开发者工具右键 cloudfunctions/docsProxy → 上传并部署（云端安装依赖）。

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const crypto = require('crypto')

// —— 数据域（班级 / 老师）行级隔离引擎 ——
const ds = require('./data-scope.js')

// —— 数量解析：必须是范围内的整数（与两套生产适配器同款口径）——
// 小数 2.5 不再被静默截断成 2（账面比实物少 0.5，且与「必须是整数」的文案不符）；
// 建档期初与盘点实盘允许 0，上限 1000000，避免误输把库存写成天文数字。
const MAX_QTY = 1000000
function parseQty(v, min) {
  const n = Number(v)
  const lo = (min === undefined) ? 1 : min
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  if (n < lo || n > MAX_QTY) return null
  return n
}

// 模块级活动后端引用（默认腾讯文档）；并发安全的做法是在每次请求时把对应后端模块
// 作为 prodHandler 的参数传入（见下方 main 分发与 prodHandler 签名），此处仅作兜底默认值。
const td = require('./tencentdocs.js')

// —— 数据后端选择与冗余回退（纯逻辑见 backend-switch.js，可单测、免外部依赖）——
const bs = require('./backend-switch.js')
const ENV = bs.resolveEnv()
const { PRIMARY, chain: CHAIN, kinds: CHAIN_KINDS } = bs.buildChain(ENV, require)

// 演示开关/真实开关决策规则（保留旧语义，整体收敛到 backend-switch）：
//   ① USE_MOCK='true'  → 强制 mock；='false' → 强制真实后端且关闭自动回退；
//   ② 未设置 → 自动模式（按凭证/回退链自适应，见 backend-switch.resolvePrimary）。
// 这样即使控制台「保存」按钮转圈、环境变量没落库，只要凭证由 env.local.js 补进来，就自动走真数据。
const USE_MOCK = ENV.FORCE_MOCK
console.log('[docsProxy] 启动：USE_MOCK=' + (ENV.RAW_USE_MOCK === undefined ? '(未设置→自动)' : ENV.RAW_USE_MOCK)
  + ' DATA_BACKEND=' + ENV.RAW_DATA_BACKEND + ' FALLBACK=' + (ENV.AUTO_FALLBACK ? 'on' : 'off')
  + ' 主后端=' + PRIMARY + ' 回退链=[' + CHAIN_KINDS.join(' → ') + ']'
  + ' 凭证=' + (ENV.HAS_CREDENTIAL ? '4项齐全' : '缺失(自动降级)')
  + ' 机器人=' + (ENV.ROBOT_KEY ? '已启用(' + ENV.ROBOT_ACTOR_ID + ')' : '未配置'))

/* ===================== 内存 mock（演示用，不持久） ===================== */
/* 注意：演示模式刻意不做服务端鉴权（无 openid 概念，whoami 恒返回 null）；
   真实鉴权仅在 prodHandler 中生效，详见切换处 USE_MOCK 三元判断。
   【数据域隔离 · 有意例外】本 mock 同样不做班级行级隔离：seed 全空、无真实身份、
   不接触线上数据。真实路径由 prodHandler + data-scope.js 完整隔离（见 docs/数据域隔离设计.md）。 */
const seed = {
  // 测试数据已全部清空（2026-11-15）：准备录入真实数据。
  // 仅 USE_MOCK 模式使用；生产走真实后端（腾讯文档或微信云数据库）。
  users: [],
  materials: [],
  tools: [],
  requisitions: [],
  borrow: [],
  stock_io: [],
  access: [],
  logs: [],
  // 实训室归属管理体系：演示数据已清空；生产由云函数读写云数据库 labs/repairs/inspections 集合
  labs: [],
  repairs: [],
  inspections: []
}
let DB = JSON.parse(JSON.stringify(seed))
// 与 tencentdocs.now() 一致按北京时间（UTC+8）格式化：云函数容器 TZ=UTC，
// 直接用本地时间会让演示数据的时间比用户感知慢 8 小时。
function now() { const d = new Date(Date.now() + 8 * 3600 * 1000); const p = n => ('' + n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` }
function ok(d) { return { code: 0, data: d } }
// 演示模式流水记录也带 cls 字段（恒为空），保持与生产返回契约同形。
function flowCls(x) { return Object.assign({}, x, { cls: x.cls || '' }) }
// 生产.normBorrow 会把表里的「借出中/已归还」翻成前端契约「借出/已还」，
// 云 mockHandler 内部沿用表值，输出时必须做同样转换，否则「我的借还」没有归还按钮。
function flowBorrow(x) {
  const o = flowCls(x)
  o.status = (x.status === '借出中') ? '借出' : (x.status === '已归还' ? '已还' : x.status)
  return o
}

// ============ 可信机器通道（WorkBuddy 自然语言操作）安全辅助 ============
// 机器人密钥哈希：密钥本身高熵（48 hex），加盐 SHA-256 后存储，DB 泄露也无法反推明文。
const ROBOT_PEPPER = 'lab-robot-key-v1'
function hashRobotKey(key) {
  return crypto.createHash('sha256').update(ROBOT_PEPPER + ':' + key).digest('hex')
}
// 写操作二次确认令牌（L1）：把 动作+参数+机器人身份 绑定到一段 HMAC，
// 用户确认时原样回传，后端重算比对；篡改 action/params/身份即失效（fail-closed）。
function makeConfirmToken(robotPayload, action, params) {
  const secret = (ENV && ENV.ROBOT_KEY && ('' + ENV.ROBOT_KEY).trim()) || ROBOT_PEPPER
  const body = JSON.stringify({ a: action, p: params || {}, r: robotPayload })
  return crypto.createHmac('sha256', secret).update(body).digest('hex').slice(0, 24)
}
// 写操作可读摘要（给用户确认时展示）
function describeRobotWrite(action, data, me) {
  const d = data || {}
  const who = me ? (me.name + '(' + me.id + ')') : '未知身份'
  const map = {
    requisition: '提交物料领用申请（' + (d.matId || d.item || '?') + ' ×' + (d.qty || '?') + '）',
    toolRequisition: '提交工具借用申请（' + (d.toolId || d.item || '?') + '）',
    cancelReq: '撤销申请（单号 ' + (d.no || '?') + '）',
    io: '库存出入库（' + (d.type || d.dir || '?') + ' ' + (d.matId || '?') + ' ×' + (d.qty || '?') + '）',
    batchIo: '批量出入库（' + (d.rows ? d.rows.length : 0) + ' 条）',
    approve: '审批单据（单号 ' + (d.no || '?') + ' → ' + (d.ok === true || d.decision === 'approve' || d.decision === '通过' ? '通过' : (d.ok === false || d.decision === 'reject' || d.decision === '拒绝' ? '驳回' : '?')) + '）',
    revokeApprove: '撤销已通过的申请（单号 ' + (d.no || '?') + '，将回滚库存/借还）',
    batchReject: '批量驳回（' + (d.nos ? d.nos.length : 0) + ' 单：' + (d.reason || '未填原因') + '）',
    addMaterial: '新增物料（' + (d.name || '?') + '）',
    stocktake: '库存盘点/期初建账（' + (d.items ? d.items.length + ' 条' : (d.type || '?')) + '）',
    borrow: '登记工具借出（' + (d.toolId || '?') + '）',
    returnTool: '登记工具归还（' + (d.toolId || '?') + '）',
    access: '登记门禁刷卡（' + (d.door || d.point || '?') + '）',
    reverseIO: '冲销流水（' + (d.no || d.id || '?') + '）',
    exportData: '导出数据（kind=' + (d.kind || 'materials') + '）',
    addLab: '新增实训室（' + (d.name || '?') + '）',
    updateLab: '修改实训室（' + (d.id || '?') + '）',
    deleteLab: '删除实训室（' + (d.id || '?') + '）',
    addRepair: '提交报修（' + (d.labName || d.labId || '?') + '：' + (d.title || '?') + '）',
    updateRepair: '更新报修（' + (d.id || '?') + '）',
    directBorrow: '教师直接借出工具（' + (d.toolId || '?') + ' 借给 ' + (d.borrower || '?') + '）',
    addInspection: '提交巡检（' + (d.labName || d.labId || '?') + '）',
    updateInspection: '更新巡检（' + (d.id || '?') + '）',
    adminUpsertUser: '新增/修改用户（' + (d.id || '?') + '，角色 ' + (d.role || '?') + '）',
    adminDeleteUser: '删除用户（' + (d.id || '?') + '）',
    adminUnbindUser: '解除微信绑定（' + (d.id || '?') + '）',
    migrate: '执行数据迁移（腾讯文档→云数据库）',
    clearAllData: '【高危·不可逆】清空全库业务数据（' + (d.includeUsers ? '含用户表，清完将无法登录！' : '保留用户表') + '）',
    importMaterials: '批量导入耗材清单（' + (d.rows ? d.rows.length : 0) + ' 条）',
    importTools: '批量导入工具清单（' + (d.rows ? d.rows.length : 0) + ' 条）'
  }
  const base = map[action] || ('执行写操作 ' + action)
  return '【' + who + '】将' + base + '。确认执行请回复「确认」。'
}
// 经可信机器通道的写操作集合（须二次确认）。读操作与密钥自管理不在其中，直接执行。
const ROBOT_WRITE = new Set([
  'requisition', 'toolRequisition', 'cancelReq', 'io', 'batchIo', 'approve', 'revokeApprove', 'batchReject', 'addMaterial',
  'stocktake', 'borrow', 'directBorrow', 'returnTool', 'access', 'reverseIO', 'exportData',
  'addLab', 'updateLab', 'deleteLab', 'addRepair', 'updateRepair',
  'addInspection', 'updateInspection', 'adminUpsertUser', 'adminDeleteUser', 'adminUnbindUser', 'migrate',
  'clearAllData', 'importMaterials', 'importTools'
])

function mat(id) { return DB.materials.find(m => ('' + m.id).trim().toUpperCase() === ('' + id).trim().toUpperCase()) }
// 演示流水单号：同一毫秒内连写多条时 'IO'+Date.now() 会撞号，撞号后「按单号冲销」
// 会命中错误的那一行——真机演示才暴露、本地很难复现，故用单调序号保证唯一。
let ioSeq = 0
function ioNo() { return 'IO' + Date.now() + '_' + (++ioSeq) }
// 演示数据的时间是北京时间字符串，筛选区间用的是毫秒时间戳，这里做一次性换算
function tsOf(s) { const n = Date.parse(('' + (s || '')).replace(' ', 'T') + '+08:00'); return Number.isFinite(n) ? n : 0 }
// 计划日期按北京时间当日 23:59:59 到期；直接 tsOf('YYYY-MM-DD') 会 NaN 导致逾期恒空。
function planEnd(s) { if (!s) return 0; const t = Date.parse(('' + s).slice(0, 10) + 'T23:59:59+08:00'); return Number.isFinite(t) ? t : 0 }
// 与生产 planDue(DEFAULT_LOAN_DAYS=7) 对齐：演示模式也要写「应归还日期」，
// 否则借用记录永远没有到期日，逾期清单恒为空——逾期提醒这个功能在演示时等于不存在。
function dueStr(days) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + (Math.min(90, Math.max(1, Number(days) || 7))) * 86400000)
  const p = n => ('' + n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

// WorkBuddy/机器通道的自然语言示例用 decision:"approve"|"reject"，而云函数后端只认 ok:true/false。
// 不归一化时 decision 被忽略 → 落入驳回分支 → 因缺 reason 返回 400，任何机器人审批都失败。
function normalizeApprove(d) {
  if (!d) return d
  const x = Object.assign({}, d)
  if (typeof x.ok !== 'boolean' && x.decision != null) {
    const v = ('' + x.decision).trim().toLowerCase()
    x.ok = ['approve', 'approved', 'pass', '通过', '同意', 'true', '1'].indexOf(v) >= 0
  }
  return x
}


// —— 与生产适配器同构的归一化（mock 直接吐原始行 → 与线上字段不一致，
//    表现为演示模式看不到效期提示、工具编号为空。这里补齐，契约与 clouddb 一致）——
// 效期转换（与生产适配器同口径）：'YYYY-MM-DD' → 该日 23:59:59（北京）epoch 毫秒
// 效期解析（与生产 expireTs 同款口径，演示与线上必须一致）：
// 支持 YYYY-MM-DD / YYYY/M/D / YYYY年M月D日 / YYYYMMDD（Excel 里常见 2026/3/5、20260305），
// 并校验真实日期 —— 2026-02-30 会被 Date.UTC 自动进位到 3-02，实际比用户填的晚 2 天。
function expireTsMock(v) {
  const s = ('' + (v || '')).trim()
  if (!s) return 0
  const mk = (y, mo, d) => {
    if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1) return 0
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate()   // 该月实际天数
    if (d > dim) return 0
    return Date.UTC(y, mo - 1, d, 15, 59, 59)              // 15:59:59 UTC == 23:59:59 +08:00
  }
  if (/^\d{8}$/.test(s)) return mk(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8))
  const m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/)
  if (m) return mk(+m[1], +m[2], +m[3])
  const n = Number(s)
  if (Number.isFinite(n) && n > 0) return n
  return 0
}


// 最后一个启用超管的保护（与生产同口径）：降级/停用/删除最后一个超管会让学生失去唯一管理入口
function lastSuperGuardMock(userObjs, targetId, nextRole, nextStatus) {
  const tid = ('' + (targetId || '')).trim().toUpperCase()
  const cur = (userObjs || []).find(u => ('' + (u.id || '')).trim().toUpperCase() === tid)
  if (!cur || cur.role !== 'super' || (cur.status || '启用') !== '启用') return null
  if (nextRole === 'super' && (nextStatus || '启用') === '启用') return null
  const others = (userObjs || []).filter(u =>
    ('' + (u.id || '')).trim().toUpperCase() !== tid &&
    u.role === 'super' && (u.status || '启用') === '启用')
  if (others.length) return null
  return { code: 400, data: { msg: '系统必须保留至少一名启用中的超级管理员，不能降级/停用/删除最后一个超管' } }
}

function normMatMock(f) {
  const expTs = Number(f.expire) || 0
  const ms = expTs ? (expTs - Date.now()) : null
  const DAYS = 86400000
  return {
    id: f.id, name: f.name, spec: f.spec || '', cat: f.cat || '', loc: f.loc || '',
    stock: Number(f.stock) || 0, unit: f.unit || '', safe: Number(f.safe) || 0,
    status: f.status || '',
    expire: expTs ? fmtTsMock(expTs) : '',
    expired: !!(expTs && ms < 0),
    expiring: !!(expTs && ms >= 0 && ms <= 30 * DAYS)
  }
}
function normToolMock(f) {
  return {
    id: f.id, name: f.name, spec: f.spec || f.sn || '', sn: f.sn || f.spec || '',
    loc: f.loc || '', status: f.status || '', borrower: f.borrower || '', outTime: f.outTime || ''
  }
}
function fmtTsMock(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n + 8 * 3600 * 1000)
  const p = x => ('' + x).padStart(2, '0')
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes())
}

function mockHandler(action, data) {
  switch (action) {
    case 'getItem': {
      const m = mat(data.id); const t = DB.tools.find(x => ('' + x.id).trim().toUpperCase() === ('' + data.id).trim().toUpperCase())
      if (m) return ok({ type: 'material', item: normMatMock(m) })
      if (t) return ok({ type: 'tool', item: normToolMock(t) })
      return { code: 404, data: {} }
    }
    case 'listMine': return ok({ requisitions: DB.requisitions.filter(r => r.user === data.user).map(flowCls), borrow: DB.borrow.filter(b => b.user === data.user).map(flowBorrow) })
    case 'pending': {
      // 与生产 listPending 同款名称映射：审批页要显示姓名与物品名，不是工号与物品ID
      const nameOf = {}
      ;(DB.materials || []).forEach(m => { nameOf['' + m.id] = m.name || '' })
      ;(DB.tools || []).forEach(t => { nameOf['' + t.id] = t.name || '' })
      const userOf = {}
      ;(DB.users || []).forEach(u => { userOf['' + u.id] = { name: u.name || '', cls: u.cls || '' } })
      return ok(DB.requisitions.filter(r => r.status === 'pending').map(r => {
        const u = userOf['' + r.user] || {}
        return Object.assign(flowCls(r), {
          itemName: nameOf['' + r.matId] || nameOf['' + r.toolId] || '',
          userName: u.name || '', userCls: u.cls || ''
        })
      }))
    }
    case 'listMaterials': return ok((DB.materials || []).map(normMatMock))
    case 'listTools': return ok((DB.tools || []).map(normToolMock))
    // 模糊搜索（演示模式）：按 id/名称/规格/编号/位置做不区分大小写的部分匹配，返回候选列表。
    // 与 prod 路径保持同一返回形状（type/id/name/sub/stock|status/score），前端无需分模式处理。
    case 'search': {
      const q = ('' + (data.kw || '')).trim().toLowerCase()
      if (!q) return ok([])
      const hit = (o, keys) => keys.some(k => ('' + (o[k] || '')).toLowerCase().includes(q))
      const mats = DB.materials
        .filter(m => hit(m, ['id', 'name', 'spec', 'cat', 'loc', 'unit']))
        .map(m => ({ type: 'material', id: m.id, name: m.name, sub: [m.spec, m.unit, m.loc].filter(Boolean).join(' · ') || '耗材', stock: Number(m.stock) || 0, score: 1 }))
      const tools = DB.tools
        .filter(t => hit(t, ['id', 'name', 'spec', 'sn', 'loc', 'status']))
        .map(t => ({ type: 'tool', id: t.id, name: t.name, sub: [t.spec, t.loc].filter(Boolean).join(' · ') || '工具', status: t.status, score: 1 }))
      return ok(mats.concat(tools).slice(0, 12))
    }
    case 'findUser': {
      const key = ('' + (data.id || '')).trim().toUpperCase()
      const u = DB.users.find(x => ('' + x.id).toUpperCase() === key)
      return u ? ok({ id: u.id, name: u.name, role: u.role, cls: u.cls || '' }) : { code: 404, data: { msg: '未找到该工号' } }
    }
    case 'listUsers': return ok(DB.users.map(u => ({ id: u.id, name: u.name, role: u.role, cls: u.cls || '' })))
    case 'whoami': return ok(null)  // mock 无 openid 概念，交由工号登录
    case 'bindLogin': {
      // mock 无持久 openid，仅校验 姓名+工号 是否匹配演示用户，命中即登录
      const id = ('' + (data.id || '')).trim().toUpperCase()
      const name = ('' + (data.name || '')).trim()
      const u = DB.users.find(x => ('' + x.id).toUpperCase() === id)
      if (!u) return { code: 404, data: { msg: '工号不存在（演示）' } }
      if (name !== ('' + (u.name || '')).trim()) return { code: 400, data: { msg: '姓名与工号不匹配（演示）' } }
      return ok({ id: u.id, name: u.name, role: u.role, cls: u.cls || '' })
    }
    // 机器通道身份自查（演示模式：以用户尝试绑定的身份回答，口径与生产一致）
    case 'robotIdentity': {
      const u = DB.users.find(x => ('' + x.id).toUpperCase() === ('' + (data.id || '')).trim().toUpperCase())
        || DB.users.find(x => x.role === (data.role || 'teacher'))
      if (!u) return { code: 401, data: { msg: '演示模式未找到对应身份，请在小程序内绑定' } }
      const sc = ds.scopeOf(u)
      return ok({
        id: u.id, name: u.name, role: u.role, channel: 'wechat', channelLabel: '演示模式（本地内存）',
        scopeFull: !!sc.full,
        scopeLabel: sc.full ? '全部班级（无行级过滤）' : '仅本班：' + (sc.classes.length ? sc.classes.join('、') : '（未配置带班）'),
        managedClasses: u.managedClasses || '', cls: u.cls || '',
        warning: '演示模式数据为本地内存，不代表线上真实权限。'
      })
    }
    // 个人机器人密钥：演示模式（USE_MOCK）无真实账号体系，密钥管理需在联网真实云函数下进行
    case 'robotKeyStatus': return ok({ hasKey: false })
    case 'genRobotKey': return ok({ token: 'DEMO_KEY_NOT_PERSISTED', note: '演示模式不写入真实账号，请联网后于小程序内生成正式密钥' })
    case 'revokeRobotKey': return ok({ revoked: true })
    case 'requisition': {
      // 与生产路径一致：数量/物品ID 服务端校验，不信客户端
      const matId = ('' + (data.matId || '')).trim()
      if (!matId) return { code: 400, data: { msg: '缺少物品ID，无法提交申请' } }
      const qty = parseQty(data.qty)
      if (qty === null) return { code: 400, data: { msg: '数量必须是 1 ~ 1000000 之间的整数' } }
      // 与生产 requisition 对齐：用途必填。演示模式放宽会让"线上提交不了、演示却能提交"
      if (!('' + (data.reason || '')).trim()) return { code: 400, data: { msg: '请填写用途说明' } }
      if (!mat(matId)) return { code: 400, data: { msg: '物品不存在：' + matId } }
      const no = 'R' + Date.now()
      DB.requisitions.push({ no, user: data.user, matId, qty, kind: 'material', status: 'pending', time: now(), reason: data.reason || '', reject: '' })
      DB.logs.push({ time: now(), actor: data.user, op: '提交领用申请', target: matId, result: '待审批' })
      return ok({ no })
    }
    case 'toolRequisition': {
      const toolId = ('' + (data.toolId || '')).trim()
      if (!toolId) return { code: 400, data: { msg: '缺少工具ID，无法提交申请' } }
      if (!('' + (data.reason || '')).trim()) return { code: 400, data: { msg: '请填写用途说明' } }
      if (!DB.tools.find(x => x.id === toolId)) return { code: 400, data: { msg: '工具不存在：' + toolId } }
      const no = 'R' + Date.now()
      // 借期：学生在申请时填的天数（1~90），审批通过后按它算应还日期
      const reqDays = Math.min(90, Math.max(1, parseInt(data.days, 10) || 7))
      DB.requisitions.push({ no, user: data.user, toolId, kind: 'tool', days: reqDays, status: 'pending', time: now(), reason: data.reason || '', reject: '' })
      DB.logs.push({ time: now(), actor: data.user, op: '提交工具借出申请', target: toolId, result: '待审批' })
      return ok({ no })
    }
    case 'approve': {
      const ap = normalizeApprove(data)
      const r = DB.requisitions.find(x => x.no === ap.no); if (!r) return { code: 404, data: {} }
      // 与生产 approve 同款守卫：已处理的单不能再审批（防重复点击二次扣库存/重复建借还记录）
      if (r.status !== 'pending') return { code: 400, data: { msg: '该申请已处理' } }
      if (!ap.ok) {
        const why = ('' + (ap.reason || '')).trim().slice(0, 60)
        if (!why) return { code: 400, data: { msg: '请填写驳回原因，便于申请人知晓（如：库存暂缺，请改用替代型号）' } }
        r.reject = why
      }
      if (ap.ok) {
        if (r.kind === 'tool') {
          const t = DB.tools.find(x => x.id === r.toolId)
          if (!t || t.status !== '在库') return { code: 400, data: { msg: '工具不在库' } }
          t.status = '借出'; t.borrower = r.user; t.outTime = now()
          DB.borrow.push({ id: 'B' + Date.now(), toolId: r.toolId, user: r.user, out: now(), plan: dueStr(ap.days || r.days), in: '', status: '借出中', note: (r.reason || '').trim().slice(0, 120) })
          DB.logs.push({ time: now(), actor: ap.actor || data.actor, op: '审批通过工具借出', target: r.toolId, result: '已通过' })
          r.status = 'approved'
        } else {
          const m = mat(r.matId); if (!m) return { code: 400, data: { msg: '物品不存在' } }; if (m.stock < r.qty) return { code: 400, data: { msg: '库存不足' } }
          // 与生产同款幂等闸门：本单若已出过库，绝不二次扣减库存（演示模式也不能与线上分叉）
          if (DB.stock_io.some(x => x.note === '领用申请 ' + r.no)) {
            r.status = 'approved'
            return ok({ idempotent: true, no: r.no, warn: '该申请此前已出库，本次未重复扣减库存' })
          }
          m.stock -= r.qty
          // 与生产对齐：审批通过必须写出库流水，否则演示模式库存少了、流水/报表却查不到
          DB.stock_io.push({ no: ioNo(), matId: r.matId, type: 'out', qty: r.qty, operator: ap.actor || data.actor || r.user || '', time: now(), note: '领用申请 ' + r.no, src: '领用出库', cls: r.cls || '' })
          DB.logs.push({ time: now(), actor: ap.actor || data.actor, op: '审批通过', target: r.matId, result: '已通过' })
          r.status = 'approved'
        }
      } else {
        r.status = 'rejected'
        DB.logs.push({ time: now(), actor: ap.actor || data.actor, op: '审批拒绝', target: r.no, result: '已拒绝' })
      }
      return ok({})
    }
    case 'batchReject': {
      const nos = Array.isArray(data.nos) ? data.nos.map(x => '' + x).filter(Boolean) : []
      if (!nos.length) return { code: 400, data: { msg: '请先选择要驳回的申请' } }
      const why = ('' + (data.reason || '')).trim().slice(0, 60)
      if (!why) return { code: 400, data: { msg: '请填写驳回原因' } }
      const okNos = [], skipped = []
      for (const no of nos) {
        const r = DB.requisitions.find(x => x.no === no)
        if (!r || r.status !== 'pending') { skipped.push({ no, reason: r ? '该申请已处理' : '申请不存在' }); continue }
        r.status = 'rejected'; r.reject = why
        DB.logs.push({ time: now(), actor: data.actor, op: '审批拒绝', target: no, result: '已拒绝：' + why, cls: r.cls || '' })
        okNos.push(no)
      }
      return ok({ ok: okNos.length, skipped, nos: okNos })
    }
    case 'revokeApprove': {
      const no = '' + (data.no || '')
      const r = DB.requisitions.find(x => x.no === no)
      if (!r) return { code: 404, data: { msg: '申请不存在：' + no } }
      if (r.status !== 'approved') return { code: 400, data: { msg: r.status === 'canceled' ? '该申请已撤销' : '只有「已通过」的申请可以撤销' } }
      const info = { no, kind: r.kind === 'tool' ? 'tool' : 'material', rolledBack: false }
      if (r.kind === 'tool') {
        const t = DB.tools.find(x => x.id === r.toolId)
        if (t && t.borrower === r.user) { t.status = '在库'; t.borrower = ''; t.outTime = ''; info.rolledBack = true }
        const bs = DB.borrow.filter(x => x.toolId === r.toolId && x.user === r.user && x.status === '借出中')
        bs.forEach(b => { b.status = '已归还'; b.in = now(); info.rolledBack = true })
        info.impact = info.rolledBack ? 'rolledBack' : 'none'
      } else {
        const m = mat(r.matId)
        // note 由审批写入，是可靠锚点；src 可能缺列（旧数据/手工表格），不能作为硬条件
        const out = DB.stock_io.find(x => x.note === '领用申请 ' + no && ('' + x.note).indexOf('[已冲销]') < 0 && x.src !== '冲销')
        if (out && m) {
          m.stock = (Number(m.stock) || 0) + (Number(out.qty) || 0)
          out.note = '[已冲销] ' + out.note
          DB.stock_io.push({ no: ioNo(), matId: r.matId, type: 'in', qty: out.qty, operator: data.actor, time: now(), note: '冲销流水 ' + out.no, src: '冲销', cls: out.cls || r.cls || '' })
          info.rolledBack = true; info.stock = m.stock; info.impact = 'rolledBack'
        } else {
          // 找不到账务影响不能当成「无需回滚」——否则库存没回来却看不出问题
          info.impact = 'missing'
          info.warn = '未找到该申请对应的出库流水，库存可能未回补，请人工核对库存'
        }
      }
      r.status = 'canceled'; r.reject = ('' + (data.reason || '')).trim().slice(0, 60) || '审批撤销'
      DB.logs.push({
        time: now(), actor: data.actor, op: '审批撤销', target: no,
        result: info.rolledBack ? '已撤销并回滚' : (info.impact === 'missing' ? '已撤销（未找到出库流水，库存未回补）' : '已撤销（无需回滚）'),
        cls: r.cls || ''
      })
      return ok(info)
    }
    case 'io': {
      const m = mat(data.matId); if (!m) return { code: 404, data: {} }
      if (data.type !== 'in' && data.type !== 'out') return { code: 400, data: { msg: '登记方向必须是 in / out' } }
      const qty = parseQty(data.qty)
      if (qty === null) return { code: 400, data: { msg: '数量必须是 1 ~ 1000000 之间的整数' } }
      if (data.type === 'out' && m.stock < qty) return { code: 400, data: { msg: '超库存' } }
      m.stock += data.type === 'in' ? qty : -qty
      // 与生产路径一致：登记必须落一条出入库流水，否则 mock 模式下流水账永远空
      DB.stock_io.push({ no: ioNo(), matId: data.matId, type: data.type, qty, operator: data.actor, time: now(), note: data.note || '', src: data.src || (data.type === 'in' ? '手动入库' : '手动出库') })
      DB.logs.push({ time: now(), actor: data.actor, op: data.type === 'in' ? '入库登记' : '出库登记', target: data.matId, result: (data.type === 'in' ? '+' : '-') + qty })
      return ok({})
    }
    case 'addMaterial': {
      // mock：建档 = 在 materials 里加一行，ID 沿用 M+序号
      const name = ('' + (data.name || '')).trim()
      if (!name) return { code: 400, data: { msg: '请填写物品名称' } }
      const qty = parseQty(data.qty, 0)
      if (qty === null) return { code: 400, data: { msg: '数量必须是 0 ~ 1000000 之间的整数' } }
      const dup = DB.materials.find(x => x.name === name)
      if (dup) return { code: 409, data: { msg: '该物品已存在：' + dup.id, matId: dup.id } }
      let max = 0
      DB.materials.forEach(x => { const m = /^\s*[Mm](\d+)\s*$/.exec('' + x.id); if (m) max = Math.max(max, parseInt(m[1], 10) || 0) })
      const newId = 'M' + String(max + 1).padStart(3, '0')
      DB.materials.push({
        id: newId, name, spec: data.spec || '', cat: data.cat || '电子元件',
        loc: data.loc || '', stock: qty, unit: data.unit || '个',
        safe: Number(data.safe) || 0, status: '正常',
        // 效期：与生产一致，建档时可录到期日（库存页据此提示已过期/临期）
        expire: expireTsMock(data.expire)
      })
      DB.stock_io.push({ no: ioNo(), matId: newId, type: 'in', qty, operator: data.actor, time: now(), note: '建档入库', src: '建档入库' })
      DB.logs.push({ time: now(), actor: data.actor, op: '新增耗材', target: newId, result: '建档成功' })
      return ok({ id: newId, name, stock: qty, unit: data.unit || '个' })
    }
    case 'listStockIO': {
      // 返回形状必须与生产 listStockIO 完全一致：{rows,total,offset,limit,hasMore,inQty,outQty}。
      // 旧版返回裸数组 → 前端分页（上拉加载）与筛选在演示模式下全部失效，且极难定位。
      const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
      const item = ('' + (data.item || '')).trim().toUpperCase()
      const dir = ('' + (data.dir || '')).trim()
      const op = ('' + (data.op || '')).trim().toUpperCase()
      const from = Number(data.from) || 0
      const to = Number(data.to) || 0
      let rows = (DB.stock_io || []).map(x => ({
        id: x.no || x.id || '', item: x.matId || '', dir: x.type === 'in' ? '入库' : '出库',
        qty: Number(x.qty) || 0, op: x.operator || x.op || '', time: x.time || '', note: x.note || '',
        src: x.src || '',
        // 原流水已冲销 + 冲销产生的反向流水都视为已结清，不可再冲销
        reversed: ('' + (x.note || '')).indexOf('[已冲销]') >= 0 || (x.src || '') === '冲销' || ('' + (x.note || '')).indexOf('冲销流水') >= 0,
        cls: x.cls || ''
      })).filter(x => x.item && x.dir)
      rows = rows.filter(x => {
        if (item && ('' + x.item).toUpperCase().indexOf(item) < 0) return false
        if (dir && x.dir !== dir) return false
        if (op && ('' + x.op).toUpperCase().indexOf(op) < 0) return false
        const t = tsOf(x.time)
        if (from && t && t < from) return false
        if (to && t && t > to) return false
        return true
      })
      rows.sort((a, b) => ('' + b.time).localeCompare('' + a.time))
      rows.forEach(r => { const m = mat(r.item); r.itemName = m ? m.name : r.item })
      const total = rows.length
      const offset = Math.max(0, Number(data.offset) || 0)
      const page = rows.slice(offset, offset + limit)
      return ok({
        rows: page, total, offset, limit,
        hasMore: offset + page.length < total,
        inQty: rows.filter(r => r.dir === '入库').reduce((s, r) => s + r.qty, 0),
        outQty: rows.filter(r => r.dir === '出库').reduce((s, r) => s + r.qty, 0)
      })
    }
    case 'addTool': {
      const nm = ('' + (data.name || '')).trim()
      if (!nm) return { code: 400, data: { msg: '请填写工具名称' } }
      const exist = (DB.tools || []).find(t => ('' + (t.name || '')).trim() === nm)
      if (exist) return { code: 409, data: { msg: '已有同名工具：' + ('' + (exist.id || '')) } }
      const id = ('' + (data.id || '')).trim() || ('T' + String((DB.tools || []).length + 1).padStart(3, '0'))
      DB.tools.push({ id, name: nm, spec: ('' + (data.spec || '')).trim(), loc: ('' + (data.loc || '')).trim(), status: '在库', borrower: '', holder: '' })
      return ok({ id, name: nm, status: '在库' })
    }
    case 'listDeliveries': {
      // 待交付清单（演示路径）：契约与生产一致 {rows,total}。
      // 演示库不造「已通过未交付」的单，避免老师对着假单子发料。
      return ok({ rows: [], total: 0 })
    }
    case 'confirmDelivery': {
      const no = '' + (data.no || '')
      if (!no) return { code: 400, data: { msg: '缺少申请单号' } }
      return ok({})
    }
    case 'listClaims': {
      // 教师端「领用记录」查询（演示路径）。返回形状必须与生产 listClaims 一致：
      // {rows,total,offset,limit,hasMore,byCls,classOptions}
      const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
      const offset = Math.max(0, Number(data.offset) || 0)
      const clsFilter = ('' + (data.cls || '')).trim()
      const itemKw = ('' + (data.item || '')).trim().toUpperCase()
      const userKw = ('' + (data.user || '')).trim().toUpperCase()
      const status = ('' + (data.status || '')).trim()
      // 前端筛选项用中文（与线上存储一致），mock 内部存英文状态，这里做别名映射，
      // 否则演示模式任何状态筛选都恒为空，验收现场会误判为功能坏了。
      const statusAlias = { '待审批': 'pending', '已通过': 'approved', '已拒绝': 'rejected', '已撤销': 'canceled', '已撤回': 'canceled' }
      const wantStatus = statusAlias[status] || status
      const from = Number(data.from) || 0
      const to = Number(data.to) || 0
      const uMap = {}
      ;(DB.users || []).forEach(u => { uMap[u.id] = u })
      let rows = (DB.requisitions || []).map(r => {
        const item = r.matId || r.toolId || ''
        const m = mat(item)
        const u = uMap[r.user] || {}
        const rc = r.cls || u.cls || ''
        return {
          no: r.no || '', item,
          itemName: (m && m.name) || item, unit: (m && m.unit) || '',
          qty: Number(r.qty) || 0,
          user: r.user || '', userName: u.name || r.user || '',
          cls: rc, reason: r.reason || '', reject: r.reject || '',
          approver: r.approver || '', status: r.status || '',
          time: r.time || ''
        }
      }).filter(r => {
        if (clsFilter && r.cls !== clsFilter) return false
        if (itemKw && ('' + r.item).toUpperCase().indexOf(itemKw) < 0 && ('' + r.itemName).toUpperCase().indexOf(itemKw) < 0) return false
        if (userKw && ('' + r.user).toUpperCase().indexOf(userKw) < 0 && ('' + r.userName).toUpperCase().indexOf(userKw) < 0) return false
        if (wantStatus && r.status !== wantStatus) return false
        const t = tsOf(r.time)
        if (from && t && t < from) return false
        if (to && t && t > to) return false
        return true
      })
      rows.sort((a, b) => ('' + b.time).localeCompare('' + a.time))
      const total = rows.length
      const byCls = {}
      rows.forEach(r => {
        const key = r.cls || '未标注班级'
        if (!byCls[key]) byCls[key] = { cls: key, qty: 0, count: 0 }
        byCls[key].qty += r.qty
        byCls[key].count += 1
      })
      return ok({
        rows: rows.slice(offset, offset + limit), total, offset, limit,
        hasMore: offset + Math.min(limit, Math.max(0, total - offset)) < total,
        byCls: Object.values(byCls).sort((a, b) => b.qty - a.qty),
        classOptions: Array.from(new Set(rows.map(r => r.cls).filter(Boolean))).sort()
      })
    }
    case 'borrow': {
      // 与生产路径一致：工具必须存在且在库，否则明确报错（旧版静默 ok({}) 会让前端以为借成功了）
      const t = DB.tools.find(x => x.id === data.toolId)
      if (!t) return { code: 404, data: { msg: '工具不存在：' + data.toolId } }
      if (t.status !== '在库') return { code: 400, data: { msg: '该工具不在库（当前：' + t.status + '）' } }
      t.status = '借出'; t.borrower = data.user; t.outTime = now()
      DB.borrow.push({ id: 'B' + Date.now(), toolId: data.toolId, user: data.user, out: now(), plan: dueStr(data.days), in: '', status: '借出中', note: (data.note || '').trim().slice(0, 120) })
      DB.logs.push({ time: now(), actor: data.actor || data.user, op: '借出工具', target: data.toolId, result: '借出中' })
      return ok({})
    }
    case 'directBorrow': {
      // 演示模式：按工号解析借用人，班级跟随借用人（与生产 directBorrow 同口径）
      const borrower = ('' + (data.borrower || '')).trim().toUpperCase()
      if (!borrower) return { code: 400, data: { msg: '请填写借用工号' } }
      const u = DB.users.find(x => ('' + x.id).trim().toUpperCase() === borrower)
      if (!u) return { code: 404, data: { msg: '借用人不存在或已停用：' + borrower } }
      const t = DB.tools.find(x => x.id === data.toolId)
      if (!t) return { code: 404, data: { msg: '工具不存在：' + data.toolId } }
      if (t.status !== '在库') return { code: 400, data: { msg: '该工具不在库（当前：' + t.status + '）' } }
      const cls = u.cls || ''
      t.status = '借出'; t.borrower = u.id; t.outTime = now()
      DB.borrow.push({ id: 'B' + Date.now(), toolId: data.toolId, user: u.id, out: now(), plan: dueStr(data.days), in: '', status: '借出中', cls, note: (data.note || '').trim().slice(0, 120) })
      DB.logs.push({ time: now(), actor: data.actor || u.id, op: '借出工具', target: data.toolId, result: '借出中', cls, note: '教师直接借出给 ' + u.id })
      return ok({ borrower: u.id, cls })
    }
    case 'returnTool': {
      // 与生产路径一致：结清借还记录 + 工具行回在库，避免 mock 模式下「我的借还」残留借出中
      const b = DB.borrow.find(x => x.toolId === data.toolId && x.status === '借出中')
      if (!b) return { code: 404, data: { msg: '没有可归还的记录（该工具当前不在借出中）' } }
      const t = DB.tools.find(x => x.id === data.toolId)
      b.status = '已归还'; b.in = now(); b.backNote = (data.note || '').trim().slice(0, 120)
      if (t) { t.status = '在库'; t.borrower = ''; t.outTime = '' }
      DB.logs.push({ time: now(), actor: data.actor, op: '归还工具', target: data.toolId, result: '已归还' + (b.backNote ? '：' + b.backNote : '') })
      return ok({})
    }
    case 'access': {
      // 生产路径有、mock 路径原先缺失 → 演示模式调用会 404（ESP32 阶段二会用到）
      const who = data.user || data.actor || ''
      DB.access.push({ id: 'A' + Date.now(), user: who, point: data.door || '实训室门', time: now(), result: data.result || '开门' })
      DB.logs.push({ time: now(), actor: who, op: '刷开门禁', target: data.door || '实训室门', result: data.result || '开门' })
      return ok({})
    }
    // 预警聚合（L2 主动服务数据源，mock 同构）：低库存 + 逾期巡检 + 待审批
    case 'alerts': {
      const lowStock = (DB.materials || [])
        .filter(m => (Number(m.safe) || 0) > 0 && (Number(m.stock) || 0) < (Number(m.safe) || 0))
        .map(m => ({ id: m.id, name: m.name, stock: Number(m.stock) || 0, safe: Number(m.safe) || 0, loc: m.loc || '' }))
      const overdueInspections = (DB.inspections || [])
        .filter(r => r.status === '待巡检' && planEnd(r.planDate) && Date.now() > planEnd(r.planDate))
        .map(x => ({ id: x.id, labId: x.labId, labName: x.labName, planDate: x.planDate }))
      const pendingApprovals = (DB.requisitions || []).filter(r => r.status === 'pending')
        .map(r => ({ no: r.no, user: r.user, item: r.matId || r.item, qty: r.qty, reason: r.reason }))
      return ok({
        lowStock, overdueInspections, pendingApprovals,
        counts: { lowStock: lowStock.length, overdue: overdueInspections.length, pending: pendingApprovals.length },
        generatedAt: now()
      })
    }
    case 'usage': {
      // 排行形状必须与生产 usage() 一致：{user:{id,name,role,cls}, n, last}。
      // 旧版返回 {id,n} 缺 user 对象 → 前端 usage.js 的 roleText/initial 全部落到 '?'，教师活跃度恒空。
      const acts = [...DB.logs.map(l => ({ actor: l.actor, op: l.op, time: l.time })), ...DB.access.map(a => ({ actor: a.actor, op: '刷开门禁', time: a.time }))]
      const byU = {}
      acts.forEach(a => {
        byU[a.actor] = byU[a.actor] || { n: 0, last: a.time }
        byU[a.actor].n++
        if (a.time && (!byU[a.actor].last || a.time > byU[a.actor].last)) byU[a.actor].last = a.time
      })
      const userOf = (id2) => {
        const u = DB.users.find(x => x.id === id2)
        return u ? { id: u.id, name: u.name, role: u.role, cls: u.cls || '' } : { id: id2, name: id2, role: '?', cls: '' }
      }
      const rank = Object.keys(byU).map(id2 => ({ user: userOf(id2), n: byU[id2].n, last: byU[id2].last })).sort((a, b) => b.n - a.n)
      const teachers = DB.users.filter(u => u.role === 'teacher')
      const activeTeachers = teachers.filter(t => byU[t.id])
      // —— 报表块必须与生产 usage 同构（趋势/Top10/周转/逾期/低库存/申请分布）——
      // 只返回 rank 的话，概况页新增的报表区在演示模式下整片空白，
      // 会被误判成"页面坏了"，实际只是 mock 少给了字段。
      const monthKey = (s) => ('' + (s || '')).slice(0, 7)
      const months = []
      const base = new Date(Date.now() + 8 * 3600 * 1000)
      base.setUTCDate(1); base.setUTCHours(0, 0, 0, 0)
      for (let i = 5; i >= 0; i--) {
        const d = new Date(base)
        d.setUTCMonth(d.getUTCMonth() - i)
        months.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'))
      }
      const tmap = {}
      months.forEach(m => { tmap[m] = { m, in: 0, out: 0 } })
      const topMap = {}
      for (const x of (DB.stock_io || [])) {
        // 冲销产生的两类流水都不计入：① 原流水（备注前缀 [已冲销]）；② 反向流水（src='冲销'）。
        // 只排除 ① 会漏算 ②，导致趋势图出现一笔虚假的入库/出库。
        const nx = '' + (x.note || '')
        if (nx.indexOf('[已冲销]') >= 0 || ('' + (x.src || '')) === '冲销' || nx.indexOf('冲销流水') >= 0) continue
        const k = monthKey(x.time)
        if (!k || !tmap[k]) continue
        const q = Number(x.qty) || 0
        if (x.type === 'out') {
          tmap[k].out += q
          topMap[x.matId] = topMap[x.matId] || { id: x.matId, name: (mat(x.matId) || {}).name || x.matId, qty: 0 }
          topMap[x.matId].qty += q
        } else tmap[k].in += q
      }
      const trend = months.map(m => tmap[m])
      const trendMax = Math.max(1, ...trend.map(x => Math.max(x.in, x.out)))
      const topMaterials = Object.values(topMap).sort((a, b) => b.qty - a.qty).slice(0, 10)
      const turnMap = {}
      for (const b of (DB.borrow || [])) {
        if (!b.toolId) continue
        const t = DB.tools.find(x => x.id === b.toolId)
        turnMap[b.toolId] = turnMap[b.toolId] || { id: b.toolId, name: t ? t.name : b.toolId, times: 0, returned: 0, out: 0 }
        turnMap[b.toolId].times++
        if (b.status === '已归还') turnMap[b.toolId].returned++
        else turnMap[b.toolId].out++
      }
      const toolTurnover = Object.values(turnMap).sort((a, b) => b.times - a.times).slice(0, 10)
      const borrowTotal = (DB.borrow || []).length
      const borrowOpen = (DB.borrow || []).filter(b => b.status !== '已归还').length
      const overdue = (DB.borrow || []).filter(b => b.status !== '已归还' && planEnd(b.plan) && Date.now() > planEnd(b.plan))
      const lowStock = (DB.materials || []).filter(m => (Number(m.safe) || 0) > 0 && (Number(m.stock) || 0) < (Number(m.safe) || 0))
        .sort((a, b) => (a.stock / Math.max(1, a.safe)) - (b.stock / Math.max(1, b.safe)))
        .map(m => ({ id: m.id, name: m.name, stock: Number(m.stock) || 0, safe: Number(m.safe) || 0, unit: m.unit || '' }))
      const reqStat = {}
      for (const r of (DB.requisitions || [])) reqStat[r.status || 'pending'] = (reqStat[r.status || 'pending'] || 0) + 1
      return ok({
        total: acts.length,
        activeUsers: Object.keys(byU).length,
        teacherActive: activeTeachers.length,
        teacherTotal: teachers.length,
        rank,
        trend, trendMax,
        topMaterials,
        toolTurnover,
        borrow: { total: borrowTotal, open: borrowOpen, returned: borrowTotal - borrowOpen },
        overdue,
        lowStock,
        reqStat
      })
    }
    // 强制刷新：本地 mock 无缓存，直接放行（与云端 fresh 语义一致；缺此 case 时下拉刷新会 404）
    case 'fresh': return ok({ cleared: true })
    case 'snapshot': {
      const us = DB.users.map(u => ({ rid: 'm_' + u.id, id: u.id, name: u.name, role: u.role, cls: u.cls || '', status: u.status || '启用', bound: false }))
      const byRole = us.reduce((a, u) => { a[u.role] = (a[u.role] || 0) + 1; return a }, {})
      const dump = JSON.parse(JSON.stringify(DB))
      dump.users = us
      dump.usersByRole = byRole
      return ok(dump)
    }
    // —— 用户与角色管理（演示模式不做写鉴权，仅维护本地 DB）——
    // 注意：mockHandler 运行在云函数内，拿不到微信 openid / prodHandler 的 me。
    // 此前这里直接引用 me 会抛 ReferenceError（演示模式点开「用户与角色」必 500）。
    // 演示身份只用于决定列表可见范围，默认按 super 展示全量；真实权限仍由前端按本地身份门控，
    // 线上路径一律走 prodHandler，不接受客户端传入的 role。
    case 'listStaff': {
      // 教职工名册（指派用）：只返回工号/姓名/角色，停用账号不返回
      const staff = DB.users
        .filter(u => u.role === 'teacher' || u.role === 'admin' || u.role === 'super')
        .filter(u => (u.status || '启用') !== '停用')
        .map(u => ({ id: u.id, name: u.name, role: u.role }))
      return ok(staff)
    }
    case 'adminListUsers': {
      const LV = { student: 0, teacher: 1, admin: 2, super: 3 }
      // 用调用者真实身份判定可见范围（与生产的层级过滤 + userVisible 同口径）。
      // 旧实现读前端传入的 data.role，且默认 'super' → 演示模式下教师能看到全校账号，
      // 与线上行为分叉（新增的「直接借出」候选名单会列出别的班学生）。
      const me = DB.users.find(u => ('' + (u.id || '')).trim().toUpperCase() === ('' + (data.actor || '')).trim().toUpperCase())
      const cl = me && LV[me.role] != null ? LV[me.role] : 3
      const all = DB.users.map(u => ({ rid: 'm_' + u.id, id: u.id, name: u.name, role: u.role, cls: u.cls || '', status: u.status || '启用', bound: false }))
      const filtered = cl >= 3 ? all : all.filter(u => (LV[u.role] != null ? LV[u.role] : 0) < cl)
      return ok(filtered)
    }
    case 'adminUpsertUser': {
      const id = ('' + (data.id || '')).trim().toUpperCase()
      const name = ('' + (data.name || '')).trim()
      const role = ('' + (data.role || '')).trim().toLowerCase()
      const cls = ('' + (data.cls || '')).trim()
      const status = ('' + (data.status || '')).trim() || '启用'
      if (!id || !name) return { code: 400, data: { msg: '工号和姓名必填' } }
      if (['student', 'teacher', 'admin', 'super'].indexOf(role) < 0) return { code: 400, data: { msg: '角色非法' } }
      if (status !== '启用' && status !== '停用') return { code: 400, data: { msg: '状态非法' } }
      const ex = DB.users.find(x => ('' + x.id).toUpperCase() === id)
      // 与生产路径一致：同工号多行（演示脏数据）时报错，而不是改错行
      if (DB.users.filter(x => ('' + x.id).toUpperCase() === id).length > 1) return { code: 409, data: { msg: '工号 ' + id + ' 存在多行（演示脏数据）' } }
      const g = lastSuperGuardMock(DB.users, id, role, status)
      if (g) return g
      if (ex) { ex.name = name; ex.role = role; ex.cls = cls; ex.status = status }
      else DB.users.push({ id, name, role, cls, status })
      return ok({ id })
    }
    case 'adminDeleteUser': {
      const id = ('' + (data.id || '')).trim().toUpperCase()
      const g0 = lastSuperGuardMock(DB.users, id, null, null)
      if (g0) return g0
      const idx = DB.users.findIndex(x => ('' + x.id).toUpperCase() === id)
      if (idx < 0) return { code: 404, data: { msg: '该工号不存在' } }
      // 与生产一致：已绑定微信的账号不能物理删除（否则同工号重建后绑定保护失效）
      if (DB.users[idx].openid) {
        return { code: 409, data: { msg: '该账号已绑定微信，不能直接删除：请改用「停用」（保留档案与绑定），或先「解绑」再删除' } }
      }
      DB.users.splice(idx, 1)
      return ok({ id })
    }
    case 'adminUnbindUser': {
      const id = ('' + (data.id || '')).trim().toUpperCase()
      const u = (DB.users || []).find(x => ('' + x.id).toUpperCase() === id)
      if (!u) return { code: 404, data: { msg: '该工号不存在' } }
      if (!u.openid) return { code: 400, data: { msg: '该账号尚未绑定微信，无需解绑' } }
      u.openid = ''
      persist()
      return ok({ id, unbound: true })
    }
    // 演示模式同步云侧的 P1 新增能力（exportData / stocktake / cancelReq）。
    // 不实现的话，演示模式（USE_MOCK=true）点导出/盘点/撤回会返回 unknown action，
    // 而生产正常——这类"只在一个分支错"的问题最容易漏到验收现场。
    case 'exportData': {
      const cell = (v) => {
        const s = v === null || v === undefined ? '' : '' + v
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
      }
      const lines = (header, rows) => [header.map(cell).join(',')].concat(rows.map(r => r.map(cell).join(','))).join('\r\n')
      const kind = '' + (data.kind || 'materials')
      if (kind === 'materials') {
        return ok({ filename: '耗材库存清单（演示）.csv', count: DB.materials.length,
          csv: '\uFEFF' + lines(['耗材ID', '名称', '规格', '类别', '存放位置', '当前库存', '单位', '预警线'],
            DB.materials.map(m => [m.id, m.name, m.spec || '', m.cat || '', m.loc || '', m.stock, m.unit || '', m.safe || 0])) })
      }
      if (kind === 'tools') {
        return ok({ filename: '工具台账（演示）.csv', count: DB.tools.length,
          csv: '\uFEFF' + lines(['工具ID', '名称', '规格', '存放位置', '状态', '当前持有人'],
            DB.tools.map(t => [t.id, t.name, t.sn || '', t.loc || '', t.status, t.borrower || ''])) })
      }
      // 其余 5 种与生产 exportData 同表头：演示模式导出「领用单/流水/借还/门禁/日志」
      // 若不支持，演示时点导出会直接 400，而线上正常——验收现场最难解释的一类差异。
      if (kind === 'stock_io') {
        return ok({ filename: '出入库流水（演示）.csv', count: DB.stock_io.length,
          csv: '\uFEFF' + lines(['流水ID', '物品ID', '方向', '数量', '操作人', '操作时间', '来源类型', '备注'],
            DB.stock_io.map(x => [x.no, x.matId, x.type === 'in' ? '入库' : '出库', x.qty, x.operator || '', x.time || '', x.src || '', x.note || ''])) })
      }
      if (kind === 'requisitions') {
        return ok({ filename: '领用申请单（演示）.csv', count: DB.requisitions.length,
          csv: '\uFEFF' + lines(['申请ID', '申请人ID', '物品ID', '类型', '数量', '用途说明', '状态', '申请时间', '驳回原因'],
            DB.requisitions.map(r => [r.no, r.user || '', r.matId || r.toolId || '', r.kind || '', r.qty || 0, r.reason || '', r.status || '', r.time || '', r.reject || ''])) })
      }
      if (kind === 'borrow') {
        return ok({ filename: '工具借用记录（演示）.csv', count: DB.borrow.length,
          csv: '\uFEFF' + lines(['借还ID', '借用人ID', '工具ID', '借出时间', '计划归还', '实际归还', '状态'],
            DB.borrow.map(b => [b.id, b.user || '', b.toolId || '', b.out || '', b.plan || '', b.in || '', b.status || ''])) })
      }
      if (kind === 'access') {
        return ok({ filename: '门禁记录（演示）.csv', count: DB.access.length,
          csv: '\uFEFF' + lines(['记录ID', '用户ID', '门禁点', '刷卡时间', '结果'],
            DB.access.map(a => [a.id, a.user || '', a.point || '', a.time || '', a.result || ''])) })
      }
      if (kind === 'logs') {
        return ok({ filename: '操作日志（演示）.csv', count: DB.logs.length,
          csv: '\uFEFF' + lines(['日志ID', '时间', '操作人', '操作类型', '对象', '结果'],
            DB.logs.map(l => [l.id || '', l.time || '', l.actor || '', l.op || '', l.target || '', l.result || ''])) })
      }
      return { code: 400, data: { msg: '演示模式不支持导出：' + kind } }
    }
    // 批量出入库（P2-⑯）：与生产 batchIo 同构——同物品合并累加、逐项写流水、逐项校验库存
    case 'batchIo': {
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
      const details = []
      let done = 0
      for (const [matId, qty] of merged) {
        const m = mat(matId)
        if (!m) { details.push({ matId, qty, err: '物品不存在' }); continue }
        const cur = Number(m.stock) || 0
        const next = cur + (type === 'in' ? 1 : -1) * qty
        if (next < 0) { details.push({ matId, qty, err: '库存不足（当前 ' + cur + '）' }); continue }
        m.stock = next
        DB.stock_io.push({ no: ioNo(), matId, type, qty, operator: data.actor || '', time: now(), note: data.note || '', src: data.src || '批量入库' })
        done++
        details.push({ matId, name: m.name, qty, stock: next })
      }
      DB.logs.push({ time: now(), actor: data.actor || '', op: type === 'in' ? '批量入库' : '批量出库', target: merged.size + ' 项', result: '成功 ' + done + ' 项' })
      return ok({ type, done, failed: details.filter(d => d.err).length, details })
    }
    // 冲销（P2-㉒）：与生产同规则——写反向流水把库存抵回，原流水加 [已冲销] 标记，不删除
    case 'reverseIO': {
      const no = '' + (data.no || '')
      if (!no) return { code: 400, data: { msg: '缺少流水号' } }
      const r = DB.stock_io.find(x => ('' + (x.no || x.id || '')) === no)
      if (!r) return { code: 404, data: { msg: '流水不存在：' + no } }
      if (('' + (r.note || '')).indexOf('[已冲销]') >= 0 || (r.src || '') === '冲销' || ('' + (r.note || '')).indexOf('冲销流水') >= 0) {
        return { code: 400, data: { msg: '该流水已冲销或本身就是冲销产生的反向流水，不可再次冲销' } }
      }
      const m = mat(r.matId)
      if (!m) return { code: 400, data: { msg: '关联物品不存在：' + r.matId } }
      const qty = Number(r.qty) || 0
      const backType = r.type === 'in' ? 'out' : 'in'
      const next = (Number(m.stock) || 0) + (r.type === 'in' ? -qty : qty)
      if (next < 0) return { code: 400, data: { msg: '冲销后库存为负（当前 ' + m.stock + '，需退回 ' + qty + '）' } }
      m.stock = next
      r.note = '[已冲销] ' + (r.note || '')
      DB.stock_io.push({ no: ioNo(), matId: r.matId, type: backType, qty, operator: data.actor || '', time: now(), note: '冲销流水 ' + no, src: '冲销', cls: r.cls || '' })
      DB.logs.push({ time: now(), actor: data.actor || '', op: '冲销出入库流水', target: no, result: '已冲销' })
      return ok({ no, item: r.matId, dir: backType === 'in' ? '入库' : '出库', qty, stock: next })
    }
    // 操作日志 / 门禁记录（P2-㉑㉑）：与生产 listLogs / listAccess 同返回形状（含分页元信息）
    case 'listLogs': {
      const actor = ('' + (data.actor || '')).trim().toUpperCase()
      const op = ('' + (data.op || '')).trim()
      const target = ('' + (data.target || '')).trim().toUpperCase()
      const from = Number(data.from) || 0
      const to = Number(data.to) || 0
      let rows = (DB.logs || []).map((l, i) => ({
        id: l.id || 'L' + i, time: l.time || '', actor: l.actor || '', op: l.op || '', target: l.target || '', result: l.result || '', cls: l.cls || ''
      })).filter(l => {
        if (actor && ('' + l.actor).toUpperCase().indexOf(actor) < 0) return false
        if (op && l.op !== op) return false
        if (target && ('' + l.target).toUpperCase().indexOf(target) < 0) return false
        const t = tsOf(l.time)
        if (from && t && t < from) return false
        if (to && t && t > to) return false
        return true
      })
      rows.sort((a, b) => ('' + b.time).localeCompare('' + a.time))
      const total = rows.length
      const offset = Math.max(0, Number(data.offset) || 0)
      const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
      const page = rows.slice(offset, offset + limit)
      return ok({ rows: page, total, offset, limit, hasMore: offset + page.length < total })
    }
    case 'listAccess': {
      const user = ('' + (data.user || '')).trim().toUpperCase()
      const point = ('' + (data.point || '')).trim()
      const from = Number(data.from) || 0
      const to = Number(data.to) || 0
      const rows = (DB.access || []).map(a => ({
        id: a.id || '', time: a.time || '', user: a.user || '', point: a.point || '', result: a.result || ''
      })).filter(a => {
        if (user && ('' + a.user).toUpperCase().indexOf(user) < 0) return false
        if (point && a.point !== point) return false
        const t = tsOf(a.time)
        if (from && t && t < from) return false
        if (to && t && t > to) return false
        return true
      })
      rows.sort((a, b) => ('' + b.time).localeCompare('' + a.time))
      const total = rows.length
      const offset = Math.max(0, Number(data.offset) || 0)
      const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
      const page = rows.slice(offset, offset + limit)
      return ok({ rows: page, total, offset, limit, hasMore: offset + page.length < total })
    }
    case 'stocktake': {
      const items = Array.isArray(data.items) ? data.items : []
      if (!items.length) return { code: 400, data: { msg: '没有需要处理的物品' } }
      const opening = data.mode === 'opening'
      const details = []
      let adjusted = 0, unchanged = 0
      for (const it of items) {
        const m = DB.materials.find(x => x.id === it.matId)
        if (!m) { details.push({ matId: it.matId, err: '物品不存在' }); continue }
        const book = Number(m.stock) || 0
        // 与生产 stocktake 对齐：实盘数必须是非负整数。旧版 Math.max(0,...) 会把
        // 误填的负数悄悄当成 0 去"调整"，等于凭空出库一笔，演示时解释不清。
        const real = parseQty(it.real, 0)
        if (real === null) return { code: 400, data: { msg: '实盘数量必须是 0 ~ 1000000 之间的整数：' + it.matId } }
        // 期初建账与盘点统一收敛到「实盘数」：diff=实盘-账面，m.stock=实盘（而非 book+diff）。
        // 旧版期初用 diff=real 再 m.stock=book+real 会翻倍（book 非空时 102+80→182）。
        const diff = real - book
        if (diff === 0) { unchanged++; details.push({ matId: it.matId, book, real, diff: 0 }); continue }
        m.stock = real
        DB.stock_io.push({ no: ioNo(), matId: it.matId, type: diff > 0 ? 'in' : 'out',
          qty: Math.abs(diff), operator: data.actor || '', time: now(),
          note: (opening ? '期初建账 ' : '盘点调整 ') + it.matId,
          src: opening ? '期初建账' : '盘点调整' })
        adjusted++
        details.push({ matId: it.matId, book, real, diff })
      }
      return ok({ mode: opening ? 'opening' : 'stocktake', adjusted, unchanged, details })
    }
    case 'cancelReq': {
      const no = '' + (data.no || '')
      const r = DB.requisitions.find(x => x.no === no)
      if (!r) return { code: 404, data: { msg: '申请不存在：' + no } }
      if (r.status !== 'pending') return { code: 400, data: { msg: '仅待审批的申请可撤销' } }
      r.status = 'canceled'
      return ok({})
    }
    // 迁移是真实后端能力，演示模式无真实数据，给出明确提示而非 unknown action
    case 'migrate': return { code: 400, data: { msg: '演示模式不支持数据迁移；请切换到真实后端（DATA_BACKEND=tencent）后由超级管理员执行' } }
    // 清库（演示模式：直接清空内存 DB，不做鉴权——与演示模式惯例一致；默认保留 users）
    case 'clearAllData': {
      const includeUsers = !!(data && data.includeUsers)
      const tables = ['requisitions', 'borrow', 'stock_io', 'access', 'logs', 'repairs', 'inspections', 'labs', 'tools', 'materials']
      if (includeUsers) tables.push('users')
      const cleared = {}
      let total = 0
      tables.forEach(t => { const n = (DB[t] || []).length; DB[t] = []; cleared[t] = n; total += n })
      return ok({ cleared, skipped: includeUsers ? [] : ['users'], errors: [], total, includeUsers })
    }
    // 批量建档（演示模式）：此前云 mockHandler 漏了这两个 case，USE_MOCK 演示现场
    // 点「批量建档」落到 default 返回 404，而前端带 noFallback 不会回退补救。
    case 'importMaterials': {
      const rows = Array.isArray(data.rows) ? data.rows : []
      if (!rows.length) return { code: 400, data: { msg: '清单为空（rows 为空）' } }
      const byId = new Map(), byName = new Map()
      DB.materials.forEach(x => { byId.set('' + x.id, x); byName.set(('' + x.name).trim(), x) })
      let max = 0
      DB.materials.forEach(x => { const m = /^\s*[Mm](\d+)\s*$/.exec('' + x.id); if (m) max = Math.max(max, parseInt(m[1], 10) || 0) })
      let created = 0, updated = 0, skipped = 0
      for (let i = 0; i < rows.length; i++) {
        const raw = rows[i] || {}
        const name = ('' + (raw.name || '')).trim()
        if (!name) { skipped++; continue }
        const id = ('' + (raw.id || '')).trim()
        const existing = (id && byId.get(id)) || byName.get(name)
        if (existing) {
          existing.name = name
          existing.spec = ('' + (raw.spec || '')).trim()
          existing.cat = ('' + (raw.cat || '')).trim() || existing.cat || '电子元件'
          existing.loc = ('' + (raw.loc || '')).trim()
          const expTs = expireTsMock(raw.expire)
          if (expTs) existing.expire = expTs
          if (('' + (raw.stock ?? '')).trim() !== '') existing.stock = Number(raw.stock) || 0
          updated++
        } else {
          max++
          const newId = id || ('M' + String(max).padStart(3, '0'))
          DB.materials.push({ id: newId, name, spec: ('' + (raw.spec || '')).trim(), cat: ('' + (raw.cat || '')).trim() || '电子元件', loc: ('' + (raw.loc || '')).trim(), stock: Number(raw.stock) || 0, unit: ('' + (raw.unit || '')).trim() || '个', safe: Number(raw.safe) || 0, status: '正常', expire: expireTsMock(raw.expire) })
          created++
        }
      }
      return ok({ created, updated, skipped })
    }
    case 'importTools': {
      const rows = Array.isArray(data.rows) ? data.rows : []
      if (!rows.length) return { code: 400, data: { msg: '清单为空（rows 为空）' } }
      const byId = new Map(), byName = new Map()
      DB.tools.forEach(x => { byId.set('' + x.id, x); byName.set(('' + x.name).trim(), x) })
      let max = 0
      DB.tools.forEach(x => { const m = /^\s*[Tt](\d+)\s*$/.exec('' + x.id); if (m) max = Math.max(max, parseInt(m[1], 10) || 0) })
      let created = 0, updated = 0, skipped = 0
      for (let i = 0; i < rows.length; i++) {
        const raw = rows[i] || {}
        const name = ('' + (raw.name || '')).trim()
        if (!name) { skipped++; continue }
        const id = ('' + (raw.id || '')).trim()
        const status = ('' + (raw.status || '')).trim() || '在库'
        const existing = (id && byId.get(id)) || byName.get(name)
        if (existing) { existing.spec = ('' + (raw.spec || '')).trim(); existing.loc = ('' + (raw.loc || '')).trim(); existing.status = status; existing.holder = ('' + (raw.holder || '')).trim(); updated++ }
        else {
          max++
          const newId = id || ('T' + String(max).padStart(3, '0'))
          DB.tools.push({ id: newId, name, spec: ('' + (raw.spec || '')).trim(), loc: ('' + (raw.loc || '')).trim(), status, holder: ('' + (raw.holder || '')).trim() })
          created++
        }
      }
      return ok({ created, updated, skipped })
    }

    // —— 实训室归属管理体系（演示模式：直接操作 DB，与生产 listLabs/addLab/... 同形状）——
    case 'listLabs': return ok(DB.labs)
    case 'getLab': {
      const k = ('' + (data.id || '')).trim().toUpperCase()
      const l = DB.labs.find(x => ('' + x.id).toUpperCase() === k)
      return l ? ok({ ...l }) : { code: 404, data: { msg: '未找到该实训室' } }
    }
    case 'labOverview': {
      const k = ('' + (data.labId || '')).trim().toUpperCase()
      const lab = DB.labs.find(x => ('' + x.id).toUpperCase() === k)
      if (!lab) return { code: 404, data: { msg: '未找到该实训室' } }
      return ok({
        lab: { ...lab },
        repairs: DB.repairs.filter(r => ('' + r.labId).toUpperCase() === k),
        inspections: DB.inspections.filter(r => ('' + r.labId).toUpperCase() === k)
      })
    }
    case 'addLab': {
      const name = ('' + (data.name || '')).trim()
      if (!name) return { code: 400, data: { msg: '请填写实训室名称' } }
      if (DB.labs.find(x => x.name === name)) return { code: 409, data: { msg: '该实训室已存在' } }
      let max = 0
      DB.labs.forEach(x => { const m = /^\s*[Ll](\d+)\s*$/.exec('' + x.id); if (m) max = Math.max(max, parseInt(m[1], 10) || 0) })
      const newId = 'L' + String(max + 1).padStart(3, '0')
      const t = now()
      DB.labs.push({ id: newId, name, campus: data.campus || '', building: data.building || '', floor: data.floor || '', roomNo: data.roomNo || '', address: data.address || '', lng: Number(data.lng) || 0, lat: Number(data.lat) || 0, managerId: data.managerId || '', managerName: data.managerName || '', status: data.status || '启用', note: data.note || '', createdAt: t, updatedAt: t })
      return ok({ id: newId, name })
    }
    case 'updateLab': {
      const k = ('' + (data.id || '')).trim().toUpperCase()
      const l = DB.labs.find(x => ('' + x.id).toUpperCase() === k)
      if (!l) return { code: 404, data: { msg: '未找到该实训室' } }
      const set = (key, v) => { if (v !== undefined && v !== null) l[key] = ('' + v).trim() }
      set('name', data.name); set('campus', data.campus); set('building', data.building)
      set('floor', data.floor); set('roomNo', data.roomNo); set('address', data.address)
      if (data.lng !== undefined) l.lng = Number(data.lng) || 0
      if (data.lat !== undefined) l.lat = Number(data.lat) || 0
      set('managerId', data.managerId); set('managerName', data.managerName)
      set('status', data.status); set('note', data.note)
      l.updatedAt = now()
      return ok({ id: l.id, updated: true })
    }
    case 'deleteLab': {
      const k = ('' + (data.id || '')).trim().toUpperCase()
      const i = DB.labs.findIndex(x => ('' + x.id).toUpperCase() === k)
      if (i < 0) return { code: 404, data: { msg: '未找到该实训室' } }
      DB.labs.splice(i, 1)
      return ok({ id: k, deleted: true })
    }
    case 'listRepairs': {
      const f = data || {}
      const list = DB.repairs.filter(r => {
        if (f.labId && ('' + r.labId).trim().toUpperCase() !== ('' + f.labId).trim().toUpperCase()) return false
        if (f.status && ('' + r.status) !== ('' + f.status)) return false
        return true
      }).sort((a, b) => (tsOf(b.createdAt) || 0) - (tsOf(a.createdAt) || 0))
      return ok(list.map(flowCls))
    }
    case 'addRepair': {
      const title = ('' + (data.title || '')).trim()
      const labId = ('' + (data.labId || '')).trim().toUpperCase()
      if (!title) return { code: 400, data: { msg: '请填写报修内容' } }
      if (!labId) return { code: 400, data: { msg: '请选择归属实训室' } }
      const lab = DB.labs.find(x => ('' + x.id).toUpperCase() === labId)
      if (!lab) return { code: 404, data: { msg: '归属实训室不存在' } }
      const newId = 'R' + Date.now() + Math.floor(Math.random() * 90 + 10)
      const t = now()
      DB.repairs.push({ id: newId, labId, labName: lab.name, title, category: data.category || '设备故障', desc: data.desc || '', reporterId: data.actor || '', reporterName: data.reporterName || data.actor || '', status: '待处理', priority: data.priority || '一般', handlerId: '', handlerName: '', resolvedNote: '', createdAt: t, updatedAt: t })
      return ok({ id: newId, labId, labName: lab.name, title })
    }
    case 'updateRepair': {
      const r = DB.repairs.find(x => ('' + x.id) === ('' + (data.id || '')))
      if (!r) return { code: 404, data: { msg: '未找到该报修单' } }
      const set = (key, v) => { if (v !== undefined) r[key] = ('' + v).trim() }
      set('status', data.status); set('handlerId', data.handlerId); set('handlerName', data.handlerName)
      set('priority', data.priority); set('resolvedNote', data.resolvedNote)
      r.updatedAt = now()
      return ok({ id: r.id, updated: true })
    }
    case 'listInspections': {
      const f = data || {}
      // 与前端演示 mock / 生产适配器对齐：「已逾期」是派生状态，不是存储值。
      let list = DB.inspections.map(r => ({ ...r, overdue: r.status === '待巡检' && !!r.planDate && Date.now() > planEnd(r.planDate) }))
      list = list.filter(r => {
        if (f.labId && ('' + r.labId).trim().toUpperCase() !== ('' + f.labId).trim().toUpperCase()) return false
        if (f.status === '已逾期') return !!r.overdue
        if (f.status && ('' + r.status) !== ('' + f.status)) return false
        return true
      }).sort((a, b) => (tsOf(b.createdAt) || 0) - (tsOf(a.createdAt) || 0))
      return ok(list.map(flowCls))
    }
    case 'addInspection': {
      const title = ('' + (data.title || '')).trim()
      const labId = ('' + (data.labId || '')).trim().toUpperCase()
      if (!title) return { code: 400, data: { msg: '请填写巡检任务名称' } }
      if (!labId) return { code: 400, data: { msg: '请选择归属实训室' } }
      const lab = DB.labs.find(x => ('' + x.id).toUpperCase() === labId)
      if (!lab) return { code: 404, data: { msg: '归属实训室不存在' } }
      const newId = 'I' + Date.now() + Math.floor(Math.random() * 90 + 10)
      const t = now()
      DB.inspections.push({ id: newId, labId, labName: lab.name, title, planDate: data.planDate || '', executorId: data.actor || '', executorName: data.executorName || data.actor || '', status: '待巡检', result: '', createdAt: t, doneAt: '' })
      return ok({ id: newId, labId, labName: lab.name, title })
    }
    case 'updateInspection': {
      const r = DB.inspections.find(x => ('' + x.id) === ('' + (data.id || '')))
      if (!r) return { code: 404, data: { msg: '未找到该巡检单' } }
      const set = (key, v) => { if (v !== undefined) r[key] = ('' + v).trim() }
      set('status', data.status); set('result', data.result); set('planDate', data.planDate)
      if (data.status === '已完成') r.doneAt = now()
      r.updatedAt = now()
      return ok({ id: r.id, updated: true })
    }

    default: return { code: 404, data: { msg: 'unknown action' } }
  }
}

/* ===================== 生产路径：腾讯文档 ===================== */
async function prodHandler(action, data, openid, tdModule, robotMode, robotPayload) {
  // 每个请求绑定自己后端的 td 引用（并发安全：不依赖模块级可变 td）。
  const td = tdModule
  // 预热字段映射（仅冷启动有真实成本，之后命中缓存≈0），并让首条请求顺带把各表 fieldId 缓存好，
  // 后续写操作不再逐个串行拉字段，显著缩短审批/出入库等写请求的耗时。
  await td.warmFieldMaps()

  // ============ 服务端身份与权限（修复：前端越权 / IDOR）============
  // 所有写操作与敏感读操作强制以"云函数推导的真实身份"为准，不再信任客户端传入的 role / user。
  // 微信端从 openid 推导；机器通道（robotMode 非空）从预置账号或机器人密钥反查的工号推导，二者互斥。
  let me = await td.whoami(openid)              // {id,name,role,cls} 或 null（微信端）
  if (!me && robotMode === 'super') {          // 管理员应急超级通道
    try { const fu = await td.findUser(robotPayload); if (fu && fu.user) me = fu.user } catch (_) {}
  }
  if (!me && robotMode === 'key') {            // 教师个人密钥通道：按哈希反查其本人工号
    try { const fu = await td.findUserByRobotKey(robotPayload); if (fu && fu.user) me = fu.user } catch (_) {}
  }

  // ===== 机器通道 fail-closed（防越权核心闸）=====
  // 只要带了 robotKey 就进入机器通道（robotMode 非空），此时**必须**解析出真实用户身份。
  // 否则 me=null 会让 scopeOf(null) 返回 full=true（未登录全通），
  // 任何持无效/编造/已吊销密钥的外部调用都能借「未登录」身份拉全库、绕开班级隔离。
  // 微信端（openid 存在、robotMode 为空）不受影响，保持原有行为。
  if (robotMode && !me) {
    console.warn('[docsProxy] 机器通道密钥无效或已吊销，拒绝执行 ' + action)
    return {
      code: 401,
      data: {
        msg: robotMode === 'super'
          ? '超级管理员身份解析失败：ROBOT_ACTOR_ID 对应的账号不存在或已停用'
          : '机器人密钥无效或已吊销，请在小程序「我的」页重新生成个人密钥后更新 WorkBuddy 配置'
      }
    }
  }

  // ===== 数据域（班级）行级隔离 =====
  // 整个请求在独立的 AsyncLocalStorage 上下文中执行：适配器底层的
  // getRecords / addRecord / updateRecord 从 currentScope() 读取当前身份，
  // 业务函数无需传参、签名零改动，云函数并发请求之间互不串味。
  // super / admin / 未登录 → scope.full=true，行为与改造前完全一致。
  const scope = ds.scopeOf(me)
  return ds.runWithScope(scope, () => prodDispatch(action, data, openid, td, robotMode, robotPayload, me))
}

// 内层分发：me 已由外层解析，其余逻辑保持原样（契约零漂移）。
async function prodDispatch(action, data, openid, td, robotMode, robotPayload, me) {
  const role = me ? me.role : null
  const isSuper = role === 'super'
  const isStaff = role === 'teacher' || role === 'admin' || isSuper
  const isAdmin = role === 'admin' || isSuper
  // 防 IDOR：listMine / requisition / toolRequisition 必须先登录，
  // 且用服务端推导的 me.id 覆盖客户端可能伪造的 user 字段。
  if (action === 'listMine' || action === 'requisition' || action === 'toolRequisition') {
    if (!me) return { code: 401, data: { msg: '请先登录' } }
    if (data) data.user = me.id
  }
  // 角色拦截：返回非 null 即拒绝（401 未登录 / 403 角色不足）
  const deny = (needAdmin) => {
    if (!me) return { code: 401, data: { msg: '请先登录' } }
    if (needAdmin && !isAdmin) return { code: 403, data: { msg: '仅管理员可操作' } }
    if (!needAdmin && !isStaff) return { code: 403, data: { msg: '权限不足（需教师 / 管理员）' } }
    return null
  }
  const gStaff = () => deny(false)
  const gAdmin = () => deny(true)
  // 超级管理员专属门：清库/迁移等不可逆高危操作仅 super 可用（admin 不行）。
  const gSuper = () => {
    if (!me) return { code: 401, data: { msg: '请先登录' } }
    if (!isSuper) return { code: 403, data: { msg: '仅超级管理员可执行此高危操作' } }
    return null
  }
  // 仅要求登录（师生皆可查，但不接受公网匿名读取校内实训室/报修/巡检数据）
  const gLogin = () => (me ? null : { code: 401, data: { msg: '请先登录' } })

  // 可信机器通道写操作二次确认（L1）：写类 action 经 robot 通道时，先返回操作摘要+确认令牌，
  // 不真正执行；用户确认后携令牌二次调用，后端重算比对通过才执行。fail-closed：令牌不符即拒绝。
  if (robotMode && ROBOT_WRITE.has(action)) {
    const incoming = data && data.__confirm
    // 计算令牌时排除 __confirm 自身，保证首次下发与二次确认的参数一致（否则令牌永不匹配）
    const cleanParams = Object.assign({}, data)
    delete cleanParams.__confirm
    if (incoming) {
      const expect = makeConfirmToken(robotPayload, action, cleanParams)
      if (incoming === expect) { delete data.__confirm }
      else return { code: 403, data: { msg: '确认令牌无效或已过期，写操作未执行' } }
    } else {
      return { code: 0, confirm: true, token: makeConfirmToken(robotPayload, action, cleanParams), summary: describeRobotWrite(action, data, me), action, params: data }
    }
  }

  // 强制刷新：清掉进程内读缓存（20s TTL）。下拉刷新时调用，保证看到的是最新数据，
  // 而不是缓存里别的设备/自己几秒前写入的旧值。仅清缓存、无副作用，需已登录。
  if (action === 'fresh') {
    if (!me) return { code: 401, data: { msg: '请先登录' } }
    td.invalidateCache()
    return ok({ cleared: true })
  }

  // run：业务函数成功时返回纯数据（无 code）→ 用 ok 包成 {code:0,data}；
  //      业务函数主动返回 {code:4xx,data}（如脏数据/库存不足）→ 原样返回，前端拿到明确错误而非 500。
  const run = async (fn) => {
    let r
    try {
      r = await fn()   // 注意：fn 是 thunk（() => td.xxx()），必须调用；否则 r 会变成函数本身而非执行结果
    } catch (e) {
      // 数据域裁决拒绝：原地返回 403。绝不能让异常冒泡到 main 的回退链——
      // 否则会切到备用后端重试，可能绕过班级隔离写入成功。
      if (e && (e.name === 'ScopeDeniedError' || e instanceof ds.ScopeDeniedError)) {
        return { code: 403, data: { msg: e.message || '无权操作其他班级的数据' } }
      }
      throw e
    }
    if (r && typeof r === 'object' && r.code) return r
    return ok(r)
  }

  // 机器通道的 whoami：直接回显当前机器人身份（与微信端行为一致，me 已就绪）
  if (action === 'whoami' && me) return ok(me)

  switch (action) {
    // —— 已登录即可调用（不依赖角色）——
    // ⚠ 安全：这五个接口此前【没有登录闸】。云函数对 HTTP 触发是公开的（openid 为空），
    //   匿名调用者可直接拉走全校耗材/工具台账（工具还带「当前持有人」= 个人信息），
    //   并用 findUser 枚举全部工号→姓名/角色/班级/带班班级（全校账号名册）。
    //   与 listLabs/listRepairs/listInspections 的既有口径对齐（那三个早已加 gLogin 门），
    //   避免「实训室加了登录门、耗材台账却敞着」的防护缺口。
    case 'getItem': { const g = gLogin(); if (g) return g; return run(() => td.getItem(data.id)) }
    case 'listMaterials': { const g = gLogin(); if (g) return g; return run(() => td.listMaterials()) }
    case 'listTools': { const g = gLogin(); if (g) return g; return run(() => td.listTools()) }
    case 'search': { const g = gLogin(); if (g) return g; return run(() => td.search(data.kw)) }
    case 'listMine': return run(() => td.listMine(data.user))
    case 'requisition': return run(() => td.requisition(data))
    case 'toolRequisition': return run(() => td.toolRequisition(data))
    case 'findUser': {
      // ⚠ 需登录：findUser 会按工号返回该账号的姓名/角色/班级/带班班级。
      //   此前是公开接口 → 匿名调用者可用连续工号枚举全校账号名册（工号可猜、姓名在通讯录）。
      //   前端登录改走 bindLogin（工号+姓名双向校验），登录前不再需要本接口。
      const g = gLogin(); if (g) return g
      const found = await td.findUser(data.id)
      if (!found) return { code: 404, data: { msg: '未找到该工号或账号未启用' } }
      // ⚠ 安全：此处曾顺带把当前 openid 绑定到该工号行（用于「首次用工号登录后免输工号」）。
      //   但 findUser 属于公开接口、无需登录、且只需工号即可调用 → 任意微信用户都能把自己的
      //   openid 写进他人「尚未绑定」的工号行，随后 whoami 即以该工号身份登录 → 冒用教师/管理员。
      //   绑定只允许走 bindLogin（工号+姓名校验 + openid 1:1 双向唯一 + 409 冲突保护），
      //   免输工号自动登录（whoami → findUserByOpenId）不受影响。
      return ok(found.user)
    }
    // 撤销申请：申请人自助通道，仅登录用户可用；data.user 由服务端覆盖，防冒名撤销他人单据
    case 'cancelReq': {
      if (!me) return { code: 401, data: { msg: '请先登录' } }
      if (data) data.user = me.id
      return run(() => td.cancelReq(data))
    }
    case 'whoami': return run(() => td.whoami(openid))
    case 'bindLogin': return await td.bindLogin(data, openid)

    // —— 机器通道身份自查（老师核对「我以谁的身份在操作」）——
    // 只读，任何通道可用。返回服务端推导的真实身份 + 数据域范围，不信任客户端传参。
    // 老师绑定 WorkBuddy 后第一件事应调用本动作：确认角色=teacher、带班=本人班级，
    // 而非误用了全局超级钥匙（super 全库）或已吊销密钥。
    case 'robotIdentity': {
      if (!me) return { code: 401, data: { msg: '请先登录或提供有效的机器人密钥' } }
      const sc = ds.scopeOf(me)
      return ok({
        id: me.id,
        name: me.name,
        role: me.role,
        // 通道：super=全局超级钥匙（全校）；key=个人密钥（本人）；''=微信端
        channel: robotMode || 'wechat',
        channelLabel: robotMode === 'super' ? '全局超级钥匙（全校权限）'
          : robotMode === 'key' ? '个人机器人密钥（本人权限）' : '微信小程序登录',
        // 数据域：full=true 表示不做班级过滤
        scopeFull: !!sc.full,
        scopeLabel: sc.full ? '全部班级（无行级过滤）'
          : '仅本班：' + (sc.classes.length ? sc.classes.join('、') : '（未配置带班，将看不到任何班级流水）'),
        managedClasses: me.managedClasses || '',
        cls: me.cls || '',
        // 醒目提示：老师若看到 super 通道，说明误用了管理员钥匙，应立即改用个人密钥
        warning: (me.role === 'super' || robotMode === 'super')
          ? '当前为超级管理员通道，可读写全校数据。若你不是管理员，请立即停止操作并向管理员索取正确的个人密钥。'
          : (me.role === 'teacher' && !sc.classes.length)
            ? '你的账号未配置带班班级，将无法查看任何班级流水，请联系管理员补充「带班班级」。'
            : ''
      })
    }

    // —— 个人机器人密钥（可信机器通道自服务，仅小程序内已登录会话可操作）——
    // 密钥生命周期严格绑定微信登录态：机器人通道（robotMode）被禁止，防密钥在机器通道被远程改写。
    case 'robotKeyStatus': {
      if (!me) return { code: 401, data: { msg: '请先登录' } }
      if (robotMode) return { code: 403, data: { msg: '密钥管理仅限在小程序内登录后操作' } }
      const fu = await td.findUser(me.id)
      return ok({ hasKey: !!(fu && fu.robotKeyHash) })
    }
    case 'genRobotKey': {
      if (!me) return { code: 401, data: { msg: '请先登录' } }
      if (robotMode) return { code: 403, data: { msg: '密钥管理仅限在小程序内登录后操作' } }
      const token = crypto.randomBytes(24).toString('hex')
      const setRes = await td.setRobotKey(me.id, hashRobotKey(token))
      if (!setRes || setRes.code) return { code: 500, data: { msg: '密钥写入失败' } }
      return ok({
        token,
        note: '已生成你的个人机器人密钥（明文仅显示这一次，请立即复制保存）。把它填到 WorkBuddy 的 DOCS_PROXY_ROBOT_KEY，即可用自然语言操作本系统；泄露可在「我的」页重置或吊销。'
      })
    }
    case 'revokeRobotKey': {
      if (!me) return { code: 401, data: { msg: '请先登录' } }
      if (robotMode) return { code: 403, data: { msg: '密钥管理仅限在小程序内登录后操作' } }
      await td.setRobotKey(me.id, '')
      return ok({ revoked: true })
    }

    // —— 仅教师 / 管理员 ——
    // 审计完整性：写操作的「操作人/申请人/持卡人」一律以服务端从 openid 推导的 me.id 覆盖，
    // 不信任客户端传入的 actor/user（否则可伪造他人名义登记、审批、归还、刷卡）。
    case 'pending': { const g = gStaff(); if (g) return g; return run(() => td.listPending()) }
    // 导出：只读不写，但涉及全量业务数据，限定教职工，避免人人可拉全表。
    // ⚠ 按 kind 分级：操作日志 / 门禁记录属管理员专属（与 listLogs / listAccess 同口径）。
    //   此前这里一律用 gStaff，教师可借 exportData(kind='logs'|'access') 绕过 gAdmin 闸门，
    //   批量导出全员操作留痕与门禁刷卡明细（属敏感个人信息），绕过管理员审计边界。
    case 'exportData': {
      const kind = ('' + (data.kind || 'materials')).trim()
      const adminOnly = (kind === 'logs' || kind === 'access')
      const g = adminOnly ? gAdmin() : gStaff()
      if (g) return g
      return run(() => td.exportData(data))
    }
    // 操作日志：涉及全员行为记录，仅管理员可查
    case 'listLogs': { const g = gAdmin(); if (g) return g; return run(() => td.listLogs(data)) }
    case 'listAccess': { const g = gAdmin(); if (g) return g; return run(() => td.listAccess(data)) }
    // 冲销：会直接回滚库存，是最高风险的写操作，限定管理员
    case 'reverseIO': { const g = gAdmin(); if (g) return g; if (data) data.actor = me.id; return run(() => td.reverseIO(data)) }
    // 批量出入库：连续扫码批量登记，权限同手动出入库
    case 'batchIo': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.batchIo(data)) }
    case 'approve': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.approve(data)) }
    // 批量驳回：与单条审批同权限；统一原因，服务端逐单校验状态，不走前端伪造
    case 'batchReject': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.batchReject(data)) }
    // 审批撤销会回补库存/结清借还，是高风险回滚，限定管理员（与冲销同级）
    case 'revokeApprove': {
      const g = gAdmin(); if (g) return g
      if (data) data.actor = me.id
      // 归属班级跟随申请单（适配器内已 overrideOwnerCls）；此处仅做服务端身份注入
      return run(() => td.revokeApprove(data))
    }
    case 'io': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.io(data)) }
    case 'addMaterial': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.addMaterial(data)) }
    // 单件工具建档：与耗材建档同权限（教师可建）；批量导入 importTools 仍是管理员专属
    case 'addTool': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.addTool(data)) }
    // 批量导入耗材清单（设备清单）：管理员专属——一次性把 Excel 解析后的多行写入 materials。
    case 'importMaterials': { const g = gAdmin(); if (g) return g; if (data) data.actor = me.id; return run(() => td.importMaterials(data)) }
    case 'importTools': { const g = gAdmin(); if (g) return g; if (data) data.actor = me.id; return run(() => td.importTools(data)) }
    // 库存盘点 / 期初建账：会直接改库存基准，权限同手动出入库（教师及以上）。
    // ⚠ 此前只实现了 tencentdocs.stocktake 与 mockHandler 侧，prodHandler 漏了本路由 →
    //   生产环境点「库存盘点」会落到 default 分支返回 {code:404,msg:'unknown action'}，
    //   整个盘点/期初建账功能在生产不可用。此处补齐，并按写操作口径覆盖 actor。
    case 'stocktake': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.stocktake(data)) }
    case 'listStockIO': { const g = gStaff(); if (g) return g; return run(() => td.listStockIO(data)) }
    // 教师端「领用记录」查询：老师/管理员可查学生领用了什么耗材。
    // 行级隔离自动生效（getRecords 注入 scope 过滤），老师只看本班 + 公共。
    case 'listClaims': { const g = gStaff(); if (g) return g; return run(() => td.listClaims(data)) }
    // 待交付清单：审批已通过但实物还没确认交到学生手里的单子（教师/管理员照单发料）
    case 'listDeliveries': { const g = gStaff(); if (g) return g; return run(() => td.listDeliveries(data)) }
    // 确认交付：只留痕「实物已发出」，不再动库存（审批时已扣），防二次扣减
    case 'confirmDelivery': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.confirmDelivery(data)) }
    case 'borrow': { const g = gStaff(); if (g) return g; if (data) data.user = me.id; return run(() => td.borrow(data)) }
    // 教师直接借出工具（无需学生申请）：借用人由服务端按工号解析，归属班级跟随借用人。
    // 教师只能借给本班学生；管理员/超管可借给任意启用账号。借用者工号必填，不接受客户端传班级。
    case 'directBorrow': {
      const g = gStaff(); if (g) return g
      const borrower = '' + ((data && data.borrower) || '').trim()
      if (!borrower) return { code: 400, data: { msg: '请填写借用工号' } }
      const fu = await td.findUser(borrower)
      if (!fu || !fu.user) return { code: 404, data: { msg: '借用人不存在或已停用：' + borrower } }
      const sc = ds.scopeOf(me)
      if (!ds.userVisible(sc, { id: fu.user.id, cls: fu.user.cls })) {
        return { code: 403, data: { msg: '只能把工具借给本班学生（借用人不在你的带班范围内）' } }
      }
      if (data) data.actor = me.id
      return run(() => td.directBorrow(data))
    }
    // 归还放开给借用本人（P1-⑤）：教师/管理员可代确认，借用者本人可自助归还。
    // 边界收紧到"只认这条借还记录的借用人"，他人工具一律拒绝，不破坏 IDOR 防线。
    case 'returnTool': {
      if (!me) return { code: 401, data: { msg: '请先登录' } }
      if (data) data.actor = me.id
      if (!isStaff) {
        const rows = await td.getRecords('borrow', r =>
          ('' + r.fields[td.COL.borrow.tool]) === ('' + data.toolId) &&
          ('' + r.fields[td.COL.borrow.status]) === '借出中')
        const owner = rows[0] ? ('' + (rows[0].fields[td.COL.borrow.user] || '')).trim().toUpperCase() : ''
        if (!owner || owner !== ('' + me.id).trim().toUpperCase()) {
          return { code: 403, data: { msg: '只有借用本人或教师 / 管理员可归还该工具' } }
        }
      }
      return run(() => td.returnTool(data))
    }
    // access 门禁：学生也会扫码开门 → 放宽到「已登录即可」（其余 staff 操作仍受 gStaff 约束）。
    // 但持卡人同样强制取 me.id：否则可拿别人工号刷开门禁记录。
    case 'access': { if (!me) return { code: 401, data: { msg: '未登录' } }; if (data) { data.user = me.id; data.actor = me.id }; return run(() => td.access(data)) }
    case 'usage': { const g = gStaff(); if (g) return g; return run(() => td.usage()) }
    // 预警聚合（L2 主动服务数据源）：低库存物料 + 逾期巡检 + 待审批，一次拉齐，
    // 供 WorkBuddy 每日推送简报，避免逐表查询。只读、gStaff 级，教师与管理员均可用。
    case 'alerts': {
      const g = gStaff(); if (g) return g
      const [mats, insps, pend] = await Promise.all([
        td.listMaterials(),
        td.listInspections({ status: '已逾期' }),
        td.listPending()
      ])
      const lowStock = (Array.isArray(mats) ? mats : [])
        .filter(m => (Number(m.safe) || 0) > 0 && (Number(m.stock) || 0) < (Number(m.safe) || 0))
        .map(m => ({ id: m.id, name: m.name, stock: Number(m.stock) || 0, safe: Number(m.safe) || 0, loc: m.loc || '' }))
      const overdueInspections = (Array.isArray(insps) ? insps : [])
        .filter(x => x.overdue || x.status === '待巡检')
        .map(x => ({ id: x.id, labId: x.labId, labName: x.labName, planDate: x.planDate }))
      const pendingApprovals = (Array.isArray(pend) ? pend : [])
        .map(r => ({ no: r.no || r.id, user: r.user, item: r.item || r.matId, qty: r.qty, reason: r.reason }))
      return ok({
        lowStock, overdueInspections, pendingApprovals,
        counts: { lowStock: lowStock.length, overdue: overdueInspections.length, pending: pendingApprovals.length },
        generatedAt: now()
      })
    }

    // —— 仅管理员 ——
    case 'listUsers': { const g = gAdmin(); if (g) return g; return run(() => td.listUsers()) }
    case 'snapshot': { const g = gAdmin(); if (g) return g; return run(() => td.snapshot()) }
    // 用户与角色管理（教师及以上）：列表/新增改/删除
    // 具体可创建/管理/删除的角色由 decideUserWrite/decideUserDelete 按调用者层级裁决（super 任意；admin 仅教师/学生；teacher 仅学生）
    case 'adminListUsers': { const g = gStaff(); if (g) return g; return run(() => td.adminListUsers(me)) }
    // 教职工名册（指派执行人/处理人）：教师及以上可读，只返回工号/姓名/角色
    case 'listStaff': { const g = gStaff(); if (g) return g; return run(() => td.listStaff()) }
    case 'adminUpsertUser': { const g = gStaff(); if (g) return g; return run(() => td.adminUpsertUser(data, me)) }
    case 'adminDeleteUser': { const g = gStaff(); if (g) return g; return run(() => td.adminDeleteUser(data, me)) }
    // 解除微信绑定：清空该工号的 openid，使其可重新绑定。
    // 这是「工号↔openid 一对一」能被纠错的前提 —— 没有它，换绑就是死路。
    // 闸门与 adminUpsertUser / adminDeleteUser 同为 gStaff：细分由适配器内的层级裁决 + 数据域裁决负责
    // （super 任意；admin 教师/学生；teacher 仅本班学生）。
    case 'adminUnbindUser': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.adminUnbindUser(data, me)) }

    // —— 一次性数据迁移（仅超级管理员）：腾讯文档 → 云数据库 ——
    // 不改业务/前端：用源适配器（恒为腾讯文档）读 8 表全量（中文 fields），逐行把中文列名
    // 重命名为英文 key，经云库适配器写入对应集合；源数据保留不删（可回滚：切回 DATA_BACKEND=tencent）。
    // 身份校验刻意走「源（腾讯文档）」账号体系——避免「切到 cloud 模式后用户表为空、谁都登录不上、
    // 迁移反而被自己的权限闸挡住」的鸡生蛋问题。迁移应在切云库前、仍以腾讯文档为主后端时执行。
    case 'migrate': {
      // 源恒为腾讯文档适配器：显式 require，不依赖当前 DATA_BACKEND，
      // 避免「切到 cloud 后 td 变 clouddb 自身、从空云库读导致零迁移」的陷阱。
      const srcTd = require('./tencentdocs.js')
      // ⚠ 凭证缺失时 whoami 会抛错（缺 FILE_ID/TOKEN）→ 异常冒泡到回退链 → 最终返回 500
      //   并把「缺少 TENCENT_DOCS_FILE_ID 环境变量」这类内部配置原文透给调用方。
      //   这里就地转成明确的业务错误：未改动任何数据 + 提示如何处理。
      let srcMe = null
      try {
        srcMe = await srcTd.whoami(openid)
      } catch (e) {
        console.error('[docsProxy] migrate 源后端（腾讯文档）不可用：', e && e.message)
        return { code: 503, data: { msg: '迁移需要腾讯文档源库凭证，当前未配置或已过期，未改动任何数据。请检查云函数环境变量后再执行' } }
      }
      if (!srcMe) return { code: 401, data: { msg: '请先登录（腾讯文档账号）后再执行迁移' } }
      if (srcMe.role !== 'super') return { code: 403, data: { msg: '仅超级管理员可执行数据迁移' } }
      const dstTd = require('./clouddb.js')         // 云库适配器（本地无 wx-server-sdk 会降级，运行时已就绪）
      const info = dstTd.runtimeInfo ? dstTd.runtimeInfo() : null
      if (!info || !info.dbReady) {
        return { code: 500, data: { msg: '云数据库未就绪（请确认云函数已部署到 CloudBase 且环境正常），迁移已中止，未改动任何数据' } }
      }
      try {
        const rep = await (require('./migrate.js')).migrateTencentToCloud(srcTd, dstTd)
        return ok(rep)
      } catch (e) {
        console.error('[docsProxy] migrate 失败：', e && e.message)
        // 错误信息可能含内部配置名（FILE_ID/TOKEN/环境变量名），对外只给可操作的中文提示
        const raw = (e && e.message) || ''
        const leaky = /TENCENT_DOCS|FILE_ID|CLIENT_ID|ACCESS_TOKEN|OPEN_ID|环境变量|node_modules/i.test(raw)
        return { code: 500, data: { msg: '迁移失败' + (leaky ? '（源库凭证不可用）' : '：' + raw) + '（已部分写入，可重新执行以幂等补齐）' } }
      }
    }

    // 清空全库（super 专属，高危不可逆）：
    //   ① gSuper 门：仅超级管理员；
    //   ② 仅允许机器人超级通道（ROBOT_KEY + super 身份）触发——确保必经上方的 L1 二次确认令牌，
    //      杜绝微信端误触绕过确认；
    //   ③ 默认保留 users（执行者自身账号），除非显式 includeUsers=true。
    case 'clearAllData': {
      const gs = gSuper(); if (gs) return gs
      if (robotMode !== 'super') return { code: 403, data: { msg: '清库为高危操作，仅允许通过 WorkBuddy/脚本的机器人超级通道执行（须二次确认）' } }
      const rep = await td.clearAllData({ includeUsers: !!(data && data.includeUsers) })
      console.error('[docsProxy] ⚠ 清库执行：', JSON.stringify(rep))
      return ok(rep)
    }

    // —— 实训室归属管理体系 ——
    // 实训室本体：增/改/删仅管理员（gAdmin）；查看任意已登录用户可用
    case 'listLabs': { const g = gLogin(); if (g) return g; return run(() => td.listLabs()) }
    case 'getLab': { const g = gLogin(); if (g) return g; return run(() => td.getLab(data.id)) }
    case 'labOverview': { const g = gLogin(); if (g) return g; return run(() => td.labOverview(data.labId)) }
    case 'addLab': { const g = gAdmin(); if (g) return g; if (data) data.actor = me.id; return run(() => td.addLab(data)) }
    case 'updateLab': { const g = gAdmin(); if (g) return g; if (data) data.actor = me.id; return run(() => td.updateLab(data)) }
    case 'deleteLab': { const g = gAdmin(); if (g) return g; if (data) data.actor = me.id; return run(() => td.deleteLab(data)) }
    // 报修：教师发起与处理（gStaff）
    case 'listRepairs': { const g = gLogin(); if (g) return g; return run(() => td.listRepairs(data || {})) }
    case 'addRepair': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.addRepair(data)) }
    case 'updateRepair': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.updateRepair(data)) }
    // 巡检：教师执行（gStaff）
    case 'listInspections': { const g = gLogin(); if (g) return g; return run(() => td.listInspections(data || {})) }
    case 'addInspection': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.addInspection(data)) }
    case 'updateInspection': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.updateInspection(data)) }

    default: return { code: 404, data: { msg: 'unknown action' } }
  }
}

// 测试钩子：把演示内存库整体替换掉（供 tools/test_parity.js 与生产适配器做同数据对拍）
exports.__setDbForTest = (d) => { DB = d || JSON.parse(JSON.stringify(seed)) }

exports.main = async (event) => {
  // 当前调用者的微信 openid（云函数由小程序 wx.cloud.callFunction 触发时自动带）。
  // 本地 node 脚本/HTTP 触发拿不到，置空即可，不影响其它 action。
  let openid = ''
  try { openid = (cloud.getWXContext() || {}).OPENID || '' } catch (e) { openid = '' }

  // 同时兼容两种调用方式：
  //   ① 微信小程序 wx.cloud.callFunction → event 直接是 {action,...data}
  //   ② CloudBase HTTP 触发 → event.body 为 JSON 字符串（H5 页面 fetch 走这条）
  let evt = event
  if (event && typeof event.body === 'string') {
    try { evt = JSON.parse(event.body) } catch (_) { /* 保留原 event */ }
  }
  const { action, ...data } = evt || {}

  // HTTP 触发（CloudBase HTTP trigger）检测：此类 event 带 httpMethod，外部分发器
  // 要求返回 {statusCode,headers,body} 才能被正确回传；微信 wx.cloud.callFunction 触发的
  // event 无 httpMethod，按原信封 {code,data,...} 返回即可。两者共用同一份业务逻辑。
  const isHttpTrigger = !!(event && event.httpMethod)
  const finish = (r) => isHttpTrigger
    ? { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) }
    : r

  // 可信机器通道（WorkBuddy 自然语言操作）：
  //   • 外部 HTTP 调用（openid 为空）且 body 携带 robotKey 时启用；微信端调用走 openid，互不影响。
  //   • robotKey 命中全局 ROBOT_KEY → 管理员应急超级通道（robotMode='super'，身份=ROBOT_ACTOR_ID）。
  //   • 否则把 robotKey 哈希后，由后端按 users.robotKeyHash 反查该教师工号（robotMode='key'），
  //     以该教师本人身份执行，权限与其微信端完全一致。
  //   • ROBOT_KEY 未配置且无合法 key → 通道关闭（fail-closed）。
  //   • 写操作经此通道时须二次确认（见 prodHandler 内 ROBOT_WRITE 闸门），防误改。
  let robotMode = ''        // '' | 'super' | 'key'
  let robotPayload = ''     // super 模式=工号；key 模式=robotKey 哈希
  if (!openid && ENV.ROBOT_KEY) {
    const rk = (evt && evt.robotKey) || (event && event.headers && event.headers['x-robot-key'])
    if (rk) {
      if (rk === ENV.ROBOT_KEY) { robotMode = 'super'; robotPayload = ENV.ROBOT_ACTOR_ID || 'T001' }
      else { robotMode = 'key'; robotPayload = hashRobotKey(rk) }
    }
  }

  // ===== 自检接口：不走 mock/prod 分支，直接回云端真实运行态 ====
  // 用途：前端「我的」页一键显示"到底跑的是 mock 还是真后端（腾讯文档/云数据库）"，不用再翻云端日志。
  // 若当前是生产模式，还会真实读一次 materials 表，验证凭证/表格是否真的通。
  if (action === 'diag') {
    // ⚠ 安全：diag 限定为已登录用户（见下），生产态会真实打一次主后端 API + 回显指纹。
    //   非管理员不返回 fileId 与物料样例，避免开放「配额耗尽型」入口。
    const primaryTd = CHAIN[0] ? CHAIN[0].td : null
    let diagMe = null
    try { diagMe = primaryTd ? await primaryTd.whoami(openid) : null } catch (e) { diagMe = null }
    if (!diagMe && robotMode === 'super') {
      try { const fu = await primaryTd.findUser(robotPayload); if (fu && fu.user) diagMe = fu.user } catch (_) {}
    }
    if (!diagMe && robotMode === 'key') {
      try { const fu = await primaryTd.findUserByRobotKey(robotPayload); if (fu && fu.user) diagMe = fu.user } catch (_) {}
    }
    if (!diagMe) return finish({ code: 401, data: { msg: '请先登录' } })
    const diagAdmin = diagMe.role === 'admin' || diagMe.role === 'super'
    const info = Object.assign({
      backend: PRIMARY,
      chain: CHAIN_KINDS,
      autoFallback: ENV.AUTO_FALLBACK,
      dataBackend: ENV.RAW_DATA_BACKEND,
      useMock: USE_MOCK,
      rawUseMock: (ENV.RAW_USE_MOCK === undefined || String(ENV.RAW_USE_MOCK).trim() === '')
        ? '(未设置→自动)' : String(ENV.RAW_USE_MOCK),
      hasCredential: ENV.HAS_CREDENTIAL
    }, (primaryTd && primaryTd.runtimeInfo) ? primaryTd.runtimeInfo() : {})
    // fileId 是数据底座的直连坐标（配合 token 即等同读写权限），只给管理员。
    if (!diagAdmin && info.fileId) info.fileId = '(仅管理员可见)'
    if (!USE_MOCK && primaryTd) {
      try {
        const ms = await primaryTd.listMaterials()
        info.ping = 'ok'
        info.materialCount = Array.isArray(ms) ? ms.length : 0
        // 物料名与库存属于业务数据，只给管理员；普通教师只需知道「连上了、读了多少条」。
        if (diagAdmin) {
          info.materialSample = (Array.isArray(ms) ? ms.slice(0, 3) : []).map(m => m.id + '/' + m.name + ' 库存' + m.stock)
        }
        // 缓存观测：用于判断 API 配额压力（腾讯文档限 150 次/分钟/fileID）
        const cs = primaryTd.cacheStats ? primaryTd.cacheStats() : null
        if (cs) info.cache = { hit: cs.hit, miss: cs.miss, tables: (cs.cachedTables || []).length, ttl: cs.ttl }
      } catch (e) {
        info.ping = 'fail'
        info.pingError = e.message
      }
    } else {
      info.ping = 'skipped(当前是mock模式，未尝试连后端)'
    }
    // ===== 账号配置体检 =====
    // 把"权限/隔离配错"这类静默失效提前暴露出来：
    //   · 教师没有带班班级 → 看不到本班任何申请与流水（现场只表现为"看不到数据"）；
    //   · 学生没有归属班级 → 任何老师都看不到他的领用记录；
    //   · 工号重复 → 登录与审批会串号；
    //   · 账号被停用 → 登不进去但列表里还在。
    // 管理员看全库汇总，教师只看自己（解决"部署后必须人工核对 18+ 账号带班完整"这件事）。
    try {
      if (primaryTd && !USE_MOCK) {
        const allUsers = await primaryTd.listAllUsersForAudit ? primaryTd.listAllUsersForAudit() : null
        if (Array.isArray(allUsers)) {
          const teacherNoScope = allUsers.filter(u => u.role === 'teacher' && !u.managedClasses)
          const studentNoCls = allUsers.filter(u => u.role === 'student' && !u.cls)
          const disabled = allUsers.filter(u => u.status && u.status !== '启用')
          const idCount = {}
          allUsers.forEach(u => { idCount['' + u.id] = (idCount['' + u.id] || 0) + 1 })
          const dupIds = Object.keys(idCount).filter(k => idCount[k] > 1)
          const scope = ds.scopeOf(diagMe)
          const visible = diagAdmin ? allUsers : allUsers.filter(u => ds.userVisible(scope, u))
          info.accountAudit = {
            total: allUsers.length,
            // 仅管理员看全库问题清单；教师只知道自己这一条
            teachersWithoutScope: diagAdmin ? teacherNoScope.map(u => u.id) : undefined,
            studentsWithoutCls: diagAdmin ? studentNoCls.map(u => u.id) : undefined,
            duplicateIds: diagAdmin ? dupIds : undefined,
            disabledCount: diagAdmin ? disabled.length : undefined,
            // 当前用户自己的配置体检（所有人都能看到与自己相关的部分）
            me: {
              role: diagMe.role,
              cls: diagMe.cls || '',
              managedClasses: diagMe.managedClasses || '',
              warning: diagMe.role === 'teacher' && !diagMe.managedClasses
                ? '当前教师账号未配置带班班级，将看不到本班任何申请与流水，请联系管理员配置。'
                : ''
            }
          }
        }
      }
    } catch (e) {
      info.accountAudit = { error: (e && e.message) || '账号体检失败' }
    }

    // ===== 账实核对（仅管理员）：账面库存 vs 流水重算值 =====
    //  背景：历史遗留的期初基线错误（例如某耗材期初建账少了 13 卷）会让账面与流水长期对不上，
    //  而系统内没有任何入口能回答「到底哪一项对不上、差多少」→ 只能靠人工逐项盘点，事后也没人知道。
    //  这里把「有几条对不上」变成「是哪几条、差多少」，可直接指引老师去库存页执行盘点。
    //  口径与账实自检一致：库存 = Σ入库流水 - Σ出库流水（冲销的一对自然抵消，不额外排除）。
    if (diagAdmin && primaryTd && !USE_MOCK) {
      try {
        const mats = await primaryTd.listMaterials()
        const ios = await primaryTd.getRecords('stock_io')
        const derived = {}
        for (const r of (Array.isArray(ios) ? ios : [])) {
          const f = r.fields || {}
          const id = '' + (f.item || '')
          if (!id) continue
          const dir = '' + (f.dir || '')
          const q = Number(f.qty) || 0
          if (dir === '入库') derived[id] = (derived[id] || 0) + q
          else if (dir === '出库') derived[id] = (derived[id] || 0) - q
        }
        const mismatched = []
        for (const m of (Array.isArray(mats) ? mats : [])) {
          const book = Number(m.stock) || 0
          const calc = derived['' + m.id] || 0
          if (book !== calc) {
            mismatched.push({ id: m.id, name: m.name || '', book, calc, diff: book - calc })
          }
        }
        mismatched.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
        // 非整数库存：建档/批量导入此前允许小数数量（生产侧用 Number(x)||0 根本不取整，
        // 演示 mock 却会截断 → 生产与演示口径分叉），线上可能已存在 12.5 这类库存。
        // 影响面：库存不足的判断、报表求和、Excel 导出（15 位有效数字）都会失真。
        // 写入侧现已统一为严格整数，这里把存量脏数据单独列出来，供管理员盘点重置基线。
        const fractional = []
        for (const m of (Array.isArray(mats) ? mats : [])) {
          const st = Number(m.stock)
          if (Number.isFinite(st) && !Number.isInteger(st)) {
            fractional.push({ id: m.id, name: m.name || '', stock: st })
          }
        }
        info.stockAudit = {
          total: (Array.isArray(mats) ? mats : []).length,
          mismatched: mismatched.length,
          hint: mismatched.length
            ? '这些物品的账面库存与出入库流水重算值不一致（多为历史遗留的期初基线错误），请到库存页执行盘点核对后重建基线'
            : '账面库存与流水重算值一致',
          items: mismatched.slice(0, 30),
          fractional: fractional.length,
          fractionalHint: fractional.length
            ? '有 ' + fractional.length + ' 项库存是小数（历史遗留），系统现按整数计量，请盘点后重置基线'
            : '',
          fractionalItems: fractional.slice(0, 30)
        }
      } catch (e) {
        info.stockAudit = { error: (e && e.message) || '账实核对失败' }
      }
    }
    console.log('[docsProxy] diag →', JSON.stringify(info))
    return finish({ code: 0, src: USE_MOCK ? 'mock' : 'cloud', backend: PRIMARY, data: info })
  }

  // ===== 冗余分发：按回退链依次尝试，任一后端抛异常即切下一个，避免程序崩溃 =====
  // ⚠ 写操作禁止降级到非主后端（见 backend-switch.isWriteAction）：跨后端写会双库分裂，
  // 降级到 mock 则数据静默丢失（实例回收即蒸发）。读操作可正常回退（仅显示陈旧/空数据，无写入风险）。
  let lastErr = null
  for (let i = 0; i < CHAIN.length; i++) {
    const bk = CHAIN[i]
    if (bs.isWriteAction(action) && i > 0) {
      console.error('[docsProxy] 写操作 ' + action + ' 在主后端失败，已拒绝回退到 ' + bk.kind
        + '（避免脏写 / 数据丢失）；直接返回错误')
      break
    }
    try {
      const r = bk.kind === 'mock'
        ? mockHandler(action, data)
        : await prodHandler(action, data, openid, bk.td, robotMode, robotPayload)
      if (r && typeof r === 'object') {
        r.src = bk.src                    // 前端契约不变：'mock' | 'cloud'
        r.backend = bk.kind              // 冗余诊断：tencent | cloud | mock
        if (i > 0) r.fallback = true     // 由非主后端兜底提供
      }
      console.log('[docsProxy] action=' + action + ' → backend=' + bk.kind
        + (i > 0 ? ' (回退)' : '') + ' src=' + (r.src || '?'))
      return finish(r)
    } catch (e) {
      lastErr = e
      // 数据域裁决拒绝是「业务拒绝」，不是「后端故障」：直接返回 403，禁止回退重试绕过隔离。
      if (e && (e.name === 'ScopeDeniedError' || e instanceof ds.ScopeDeniedError)) {
        return finish({ code: 403, data: { msg: e.message || '无权操作其他班级的数据' }, backend: bk.kind })
      }
      console.error('[docsProxy] backend=' + bk.kind + ' 处理 action=' + action + ' 抛错：'
        + (e && e.message) + (i < CHAIN.length - 1 ? '；尝试下一个后端' : '；已是链尾'))
      if (i >= CHAIN.length - 1) break
    }
  }
  // 所有后端均失败（或写操作被禁止回退）：返回结构化错误，进程不崩
  return finish({ code: 500, data: { msg: (lastErr && lastErr.message) || '数据后端暂不可用，写操作未执行（已避免脏写）' }, src: 'mock', backend: 'none', fallback: true })
}
