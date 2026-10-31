// 云函数 docsProxy —— 中继层
// 职责：持有腾讯文档密钥（仅服务端）、封装文档 API、写操作串行化、权限校验、留痕。
// 部署：微信开发者工具右键 cloudfunctions/docsProxy → 上传并部署（云端安装依赖）。

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const crypto = require('crypto')

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
   真实鉴权仅在 prodHandler 中生效，详见切换处 USE_MOCK 三元判断。 */
const seed = {
  // 演示账号已清空：仅 USE_MOCK 模式使用，不应内置真实工号+姓名（与真实 users 表同名同号，泄露风险）。
  // 生产走真实腾讯文档；纯 mock 模式登录将无可用账号（仅演示回退用，可接受）。
  users: [],
  materials: [
    { id: 'M001', name: '电阻包(1kΩ)', cat: '电子耗材', unit: '包', safe: 10, stock: 25, loc: 'A柜1层' },
    { id: 'M002', name: '面包板', cat: '电子耗材', unit: '块', safe: 5, stock: 3, loc: 'A柜2层' },
    { id: 'M003', name: '杜邦线(公对母)', cat: '电子耗材', unit: '扎', safe: 20, stock: 40, loc: 'B柜1层' },
    { id: 'M004', name: '焊锡丝', cat: '焊接耗材', unit: '卷', safe: 3, stock: 1, loc: 'C柜' }
  ],
  tools: [
    { id: 'T001', name: '万用表 FLUKE-17', sn: 'FL-17001', status: '在库', borrower: '', outTime: '' },
    { id: 'T002', name: '电烙铁 60W', sn: 'LT-2002', status: '借出', borrower: 'S002', outTime: '' },
    { id: 'T003', name: '示波器 SDS1104', sn: 'OS-1104', status: '在库', borrower: '', outTime: '' }
  ],
  requisitions: [{ no: 'R20261001', user: 'S002', matId: 'M003', qty: 2, kind: 'material', status: 'pending', time: '2026-10-22 09:30' }],
  borrow: [],
  stock_io: [],
  access: [],
  logs: [],
  // 实训室归属管理体系（演示数据；生产由云函数读写云数据库 labs/repairs/inspections 集合）
  labs: [
    { id: 'L001', name: '物联网综合实训室', campus: '主校区', building: '实训楼A', floor: '3', roomNo: '301', address: '实训楼A 3楼东', lng: 0, lat: 0, managerId: 'T001', managerName: '邓磊', status: '启用', note: '', createdAt: '2026-09-01 09:00', updatedAt: '2026-09-01 09:00' }
  ],
  repairs: [
    { id: 'R1', labId: 'L001', labName: '物联网综合实训室', title: '示波器通道故障', category: '设备故障', desc: 'CH1 无波形', reporterId: 'T001', reporterName: '邓磊', status: '待处理', priority: '紧急', handlerId: '', handlerName: '', resolvedNote: '', createdAt: '2026-10-20 10:00', updatedAt: '2026-10-20 10:00' }
  ],
  inspections: [
    { id: 'I1', labId: 'L001', labName: '物联网综合实训室', title: '月度安全巡检', planDate: '2026-11-01', executorId: 'T001', executorName: '邓磊', status: '待巡检', result: '', createdAt: '2026-10-20 10:00', doneAt: '' }
  ]
}
let DB = JSON.parse(JSON.stringify(seed))
// 与 tencentdocs.now() 一致按北京时间（UTC+8）格式化：云函数容器 TZ=UTC，
// 直接用本地时间会让演示数据的时间比用户感知慢 8 小时。
function now() { const d = new Date(Date.now() + 8 * 3600 * 1000); const p = n => ('' + n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` }
function ok(d) { return { code: 0, data: d } }

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
    io: '库存出入库（' + (d.dir || '?') + ' ' + (d.matId || '?') + ' ×' + (d.qty || '?') + '）',
    batchIo: '批量出入库（' + (d.rows ? d.rows.length : 0) + ' 条）',
    approve: '审批单据（单号 ' + (d.no || '?') + ' → ' + (d.decision || '?') + '）',
    addMaterial: '新增物料（' + (d.name || '?') + '）',
    stocktake: '库存盘点/期初建账（' + (d.id || '?') + '）',
    borrow: '登记工具借出（' + (d.toolId || '?') + '）',
    returnTool: '登记工具归还（' + (d.toolId || '?') + '）',
    access: '登记门禁刷卡（' + (d.point || '?') + '）',
    reverseIO: '冲销流水（' + (d.id || '?') + '）',
    exportData: '导出数据（kind=' + (d.kind || 'materials') + '）',
    addLab: '新增实训室（' + (d.name || '?') + '）',
    updateLab: '修改实训室（' + (d.id || '?') + '）',
    deleteLab: '删除实训室（' + (d.id || '?') + '）',
    addRepair: '提交报修（' + (d.labName || d.labId || '?') + '：' + (d.title || '?') + '）',
    updateRepair: '更新报修（' + (d.id || '?') + '）',
    addInspection: '提交巡检（' + (d.labName || d.labId || '?') + '）',
    updateInspection: '更新巡检（' + (d.id || '?') + '）',
    adminUpsertUser: '新增/修改用户（' + (d.id || '?') + '，角色 ' + (d.role || '?') + '）',
    adminDeleteUser: '删除用户（' + (d.id || '?') + '）',
    migrate: '执行数据迁移（腾讯文档→云数据库）'
  }
  const base = map[action] || ('执行写操作 ' + action)
  return '【' + who + '】将' + base + '。确认执行请回复「确认」。'
}
// 经可信机器通道的写操作集合（须二次确认）。读操作与密钥自管理不在其中，直接执行。
const ROBOT_WRITE = new Set([
  'requisition', 'toolRequisition', 'cancelReq', 'io', 'batchIo', 'approve', 'addMaterial',
  'stocktake', 'borrow', 'returnTool', 'access', 'reverseIO', 'exportData',
  'addLab', 'updateLab', 'deleteLab', 'addRepair', 'updateRepair',
  'addInspection', 'updateInspection', 'adminUpsertUser', 'adminDeleteUser', 'migrate'
])

function mat(id) { return DB.materials.find(m => m.id === id) }
// 演示流水单号：同一毫秒内连写多条时 'IO'+Date.now() 会撞号，撞号后「按单号冲销」
// 会命中错误的那一行——真机演示才暴露、本地很难复现，故用单调序号保证唯一。
let ioSeq = 0
function ioNo() { return 'IO' + Date.now() + '_' + (++ioSeq) }
// 演示数据的时间是北京时间字符串，筛选区间用的是毫秒时间戳，这里做一次性换算
function tsOf(s) { const n = Date.parse(('' + (s || '')).replace(' ', 'T') + '+08:00'); return Number.isFinite(n) ? n : 0 }
// 与生产 planDue(DEFAULT_LOAN_DAYS=7) 对齐：演示模式也要写「应归还日期」，
// 否则借用记录永远没有到期日，逾期清单恒为空——逾期提醒这个功能在演示时等于不存在。
function dueStr(days) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + (Math.min(90, Math.max(1, Number(days) || 7))) * 86400000)
  const p = n => ('' + n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

function mockHandler(action, data) {
  switch (action) {
    case 'getItem': {
      const m = mat(data.id); const t = DB.tools.find(x => x.id === data.id)
      if (m) return ok({ type: 'material', item: m })
      if (t) return ok({ type: 'tool', item: t })
      return { code: 404, data: {} }
    }
    case 'listMine': return ok({ requisitions: DB.requisitions.filter(r => r.user === data.user), borrow: DB.borrow.filter(b => b.user === data.user) })
    case 'pending': return ok(DB.requisitions.filter(r => r.status === 'pending'))
    case 'listMaterials': return ok(DB.materials)
    case 'listTools': return ok(DB.tools)
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
    // 个人机器人密钥：演示模式（USE_MOCK）无真实账号体系，密钥管理需在联网真实云函数下进行
    case 'robotKeyStatus': return ok({ hasKey: false })
    case 'genRobotKey': return ok({ token: 'DEMO_KEY_NOT_PERSISTED', note: '演示模式不写入真实账号，请联网后于小程序内生成正式密钥' })
    case 'revokeRobotKey': return ok({ revoked: true })
    case 'requisition': {
      // 与生产路径一致：数量/物品ID 服务端校验，不信客户端
      const matId = ('' + (data.matId || '')).trim()
      if (!matId) return { code: 400, data: { msg: '缺少物品ID，无法提交申请' } }
      const qty = Math.floor(Number(data.qty) || 0)
      if (qty < 1) return { code: 400, data: { msg: '数量必须是大于 0 的整数' } }
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
      DB.requisitions.push({ no, user: data.user, toolId, kind: 'tool', status: 'pending', time: now(), reason: data.reason || '', reject: '' })
      DB.logs.push({ time: now(), actor: data.user, op: '提交工具借出申请', target: toolId, result: '待审批' })
      return ok({ no })
    }
    case 'approve': {
      const r = DB.requisitions.find(x => x.no === data.no); if (!r) return { code: 404, data: {} }
      // 与生产 approve 同款守卫：已处理的单不能再审批（防重复点击二次扣库存/重复建借还记录）
      if (r.status !== 'pending') return { code: 400, data: { msg: '该申请已处理' } }
      if (data.ok) {
        if (r.kind === 'tool') {
          const t = DB.tools.find(x => x.id === r.toolId)
          if (!t || t.status !== '在库') return { code: 400, data: { msg: '工具不在库' } }
          t.status = '借出'; t.borrower = r.user; t.outTime = now()
          DB.borrow.push({ id: 'B' + Date.now(), toolId: r.toolId, user: r.user, out: now(), plan: dueStr(data.days), in: '', status: '借出中' })
          DB.logs.push({ time: now(), actor: data.actor, op: '审批通过工具借出', target: r.toolId, result: '已通过' })
          r.status = 'approved'
        } else {
          const m = mat(r.matId); if (!m) return { code: 400, data: { msg: '物品不存在' } }; if (m.stock < r.qty) return { code: 400, data: { msg: '库存不足' } }; m.stock -= r.qty
          DB.logs.push({ time: now(), actor: data.actor, op: '审批通过领用', target: r.matId, result: '已通过' })
          r.status = 'approved'
        }
      } else {
        r.status = 'rejected'
        DB.logs.push({ time: now(), actor: data.actor, op: '审批拒绝', target: r.no, result: '已拒绝' })
      }
      return ok({})
    }
    case 'io': {
      const m = mat(data.matId); if (!m) return { code: 404, data: {} }
      if (data.type !== 'in' && data.type !== 'out') return { code: 400, data: { msg: '登记方向必须是 in / out' } }
      const qty = Math.floor(Number(data.qty) || 0)
      if (qty < 1) return { code: 400, data: { msg: '数量必须是大于 0 的整数' } }
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
      const qty = Math.floor(Number(data.qty) || 0)
      if (qty < 0) return { code: 400, data: { msg: '数量不能为负数' } }
      const dup = DB.materials.find(x => x.name === name)
      if (dup) return { code: 409, data: { msg: '该物品已存在：' + dup.id, matId: dup.id } }
      let max = 0
      DB.materials.forEach(x => { const m = /^\s*[Mm](\d+)\s*$/.exec('' + x.id); if (m) max = Math.max(max, parseInt(m[1], 10) || 0) })
      const newId = 'M' + String(max + 1).padStart(3, '0')
      DB.materials.push({
        id: newId, name, spec: data.spec || '', cat: data.cat || '电子元件',
        loc: data.loc || '', stock: qty, unit: data.unit || '个',
        safe: Number(data.safe) || 0, status: '正常'
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
        src: x.src || '', reversed: ('' + (x.note || '')).indexOf('[已冲销]') >= 0
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
    case 'borrow': {
      // 与生产路径一致：工具必须存在且在库，否则明确报错（旧版静默 ok({}) 会让前端以为借成功了）
      const t = DB.tools.find(x => x.id === data.toolId)
      if (!t) return { code: 404, data: { msg: '工具不存在：' + data.toolId } }
      if (t.status !== '在库') return { code: 400, data: { msg: '该工具不在库（当前：' + t.status + '）' } }
      t.status = '借出'; t.borrower = data.user; t.outTime = now()
      DB.borrow.push({ id: 'B' + Date.now(), toolId: data.toolId, user: data.user, out: now(), plan: dueStr(data.days), in: '', status: '借出中' })
      DB.logs.push({ time: now(), actor: data.user, op: '借出工具', target: data.toolId, result: '借出中' })
      return ok({})
    }
    case 'returnTool': {
      // 与生产路径一致：结清借还记录 + 工具行回在库，避免 mock 模式下「我的借还」残留借出中
      const b = DB.borrow.find(x => x.toolId === data.toolId && x.status === '借出中')
      const t = DB.tools.find(x => x.id === data.toolId)
      if (b) { b.status = '已归还'; b.in = now() }
      if (t) { t.status = '在库'; t.borrower = ''; t.outTime = '' }
      DB.logs.push({ time: now(), actor: data.actor, op: '归还工具', target: data.toolId, result: '已归还' })
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
        .filter(m => (Number(m.safe) || 0) > 0 && (Number(m.stock) || 0) <= (Number(m.safe) || 0))
        .map(m => ({ id: m.id, name: m.name, stock: Number(m.stock) || 0, safe: Number(m.safe) || 0, loc: m.loc || '' }))
      const overdueInspections = (DB.inspections || [])
        .filter(r => r.status === '待巡检' && !!r.planDate && Date.parse(('' + r.planDate).replace(/-/g, '/')) < Date.now())
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
      const overdue = (DB.borrow || []).filter(b => b.status !== '已归还' && b.plan && tsOf(b.plan) && Date.now() > tsOf(b.plan))
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
    // —— 用户与角色管理（演示模式不做鉴权，仅维护本地 DB）——
    case 'adminListUsers': return ok(DB.users.map(u => ({ rid: 'm_' + u.id, id: u.id, name: u.name, role: u.role, cls: u.cls || '', status: u.status || '启用', bound: false })))
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
      if (ex) { ex.name = name; ex.role = role; ex.cls = cls; ex.status = status }
      else DB.users.push({ id, name, role, cls, status })
      return ok({ id })
    }
    case 'adminDeleteUser': {
      const id = ('' + (data.id || '')).trim().toUpperCase()
      const idx = DB.users.findIndex(x => ('' + x.id).toUpperCase() === id)
      if (idx < 0) return { code: 404, data: { msg: '该工号不存在' } }
      DB.users.splice(idx, 1)
      return ok({ id })
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
        const qty = Math.floor(Number(it.qty) || 0)
        if (qty < 1) return { code: 400, data: { msg: '数量必须是大于 0 的整数：' + matId } }
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
      if (('' + (r.note || '')).indexOf('[已冲销]') >= 0) return { code: 400, data: { msg: '该流水已冲销过，不可重复冲销' } }
      const m = mat(r.matId)
      if (!m) return { code: 400, data: { msg: '关联物品不存在：' + r.matId } }
      const qty = Number(r.qty) || 0
      const backType = r.type === 'in' ? 'out' : 'in'
      const next = (Number(m.stock) || 0) + (r.type === 'in' ? -qty : qty)
      if (next < 0) return { code: 400, data: { msg: '冲销后库存为负（当前 ' + m.stock + '，需退回 ' + qty + '）' } }
      m.stock = next
      r.note = '[已冲销] ' + (r.note || '')
      DB.stock_io.push({ no: ioNo(), matId: r.matId, type: backType, qty, operator: data.actor || '', time: now(), note: '冲销流水 ' + no, src: '冲销' })
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
        id: l.id || 'L' + i, time: l.time || '', actor: l.actor || '', op: l.op || '', target: l.target || '', result: l.result || ''
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
        const real = Math.floor(Number(it.real))
        if (!Number.isFinite(real) || real < 0) return { code: 400, data: { msg: '实盘数量必须是不小于 0 的整数：' + it.matId } }
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
      return ok(list)
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
      const list = DB.inspections.filter(r => {
        if (f.labId && ('' + r.labId).trim().toUpperCase() !== ('' + f.labId).trim().toUpperCase()) return false
        if (f.status && ('' + r.status) !== ('' + f.status)) return false
        return true
      }).sort((a, b) => (tsOf(b.createdAt) || 0) - (tsOf(a.createdAt) || 0))
      return ok(list)
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
    const r = await fn()   // 注意：fn 是 thunk（() => td.xxx()），必须调用；否则 r 会变成函数本身而非执行结果
    if (r && typeof r === 'object' && r.code) return r
    return ok(r)
  }

  // 机器通道的 whoami：直接回显当前机器人身份（与微信端行为一致，me 已就绪）
  if (action === 'whoami' && me) return ok(me)

  switch (action) {
    // —— 公开接口：任意已登录用户可调用，不依赖角色 ——
    case 'getItem': return run(() => td.getItem(data.id))
    case 'listMaterials': return run(() => td.listMaterials())
    case 'listTools': return run(() => td.listTools())
    case 'search': return run(() => td.search(data.kw))
    case 'listMine': return run(() => td.listMine(data.user))
    case 'requisition': return run(() => td.requisition(data))
    case 'toolRequisition': return run(() => td.toolRequisition(data))
    case 'findUser': {
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
    case 'io': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.io(data)) }
    case 'addMaterial': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.addMaterial(data)) }
    // 库存盘点 / 期初建账：会直接改库存基准，权限同手动出入库（教师及以上）。
    // ⚠ 此前只实现了 tencentdocs.stocktake 与 mockHandler 侧，prodHandler 漏了本路由 →
    //   生产环境点「库存盘点」会落到 default 分支返回 {code:404,msg:'unknown action'}，
    //   整个盘点/期初建账功能在生产不可用。此处补齐，并按写操作口径覆盖 actor。
    case 'stocktake': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.stocktake(data)) }
    case 'listStockIO': { const g = gStaff(); if (g) return g; return run(() => td.listStockIO(data)) }
    case 'borrow': { const g = gStaff(); if (g) return g; if (data) data.user = me.id; return run(() => td.borrow(data)) }
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
        .filter(m => (Number(m.safe) || 0) > 0 && (Number(m.stock) || 0) <= (Number(m.safe) || 0))
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
    // 用户与角色管理（仅管理员）：列表/新增改/删除
    case 'adminListUsers': { const g = gAdmin(); if (g) return g; return run(() => td.adminListUsers()) }
    case 'adminUpsertUser': { const g = gAdmin(); if (g) return g; return run(() => td.adminUpsertUser(data, me)) }
    case 'adminDeleteUser': { const g = gAdmin(); if (g) return g; return run(() => td.adminDeleteUser(data, me)) }

    // —— 一次性数据迁移（仅超级管理员）：腾讯文档 → 云数据库 ——
    // 不改业务/前端：用源适配器（恒为腾讯文档）读 8 表全量（中文 fields），逐行把中文列名
    // 重命名为英文 key，经云库适配器写入对应集合；源数据保留不删（可回滚：切回 DATA_BACKEND=tencent）。
    // 身份校验刻意走「源（腾讯文档）」账号体系——避免「切到 cloud 模式后用户表为空、谁都登录不上、
    // 迁移反而被自己的权限闸挡住」的鸡生蛋问题。迁移应在切云库前、仍以腾讯文档为主后端时执行。
    case 'migrate': {
      // 源恒为腾讯文档适配器：显式 require，不依赖当前 DATA_BACKEND，
      // 避免「切到 cloud 后 td 变 clouddb 自身、从空云库读导致零迁移」的陷阱。
      const srcTd = require('./tencentdocs.js')
      const srcMe = await srcTd.whoami(openid)
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
        return { code: 500, data: { msg: '迁移失败：' + ((e && e.message) || e) + '（已部分写入，可重新执行以幂等补齐）' } }
      }
    }

    // —— 实训室归属管理体系 ——
    // 实训室本体：增/改/删仅管理员（gAdmin）；查看任意已登录用户可用
    case 'listLabs': return run(() => td.listLabs())
    case 'getLab': return run(() => td.getLab(data.id))
    case 'labOverview': return run(() => td.labOverview(data.labId))
    case 'addLab': { const g = gAdmin(); if (g) return g; if (data) data.actor = me.id; return run(() => td.addLab(data)) }
    case 'updateLab': { const g = gAdmin(); if (g) return g; if (data) data.actor = me.id; return run(() => td.updateLab(data)) }
    case 'deleteLab': { const g = gAdmin(); if (g) return g; if (data) data.actor = me.id; return run(() => td.deleteLab(data)) }
    // 报修：教师发起与处理（gStaff）
    case 'listRepairs': return run(() => td.listRepairs(data || {}))
    case 'addRepair': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.addRepair(data)) }
    case 'updateRepair': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.updateRepair(data)) }
    // 巡检：教师执行（gStaff）
    case 'listInspections': return run(() => td.listInspections(data || {}))
    case 'addInspection': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.addInspection(data)) }
    case 'updateInspection': { const g = gStaff(); if (g) return g; if (data) data.actor = me.id; return run(() => td.updateInspection(data)) }

    default: return { code: 404, data: { msg: 'unknown action' } }
  }
}

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
  // 用途：前端「我的」页一键显示"到底跑的是 mock 还是真腾讯文档"，不用再翻云端日志。
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
    if (!diagMe) return { code: 401, data: { msg: '请先登录' } }
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
    console.log('[docsProxy] diag →', JSON.stringify(info))
    return { code: 0, src: USE_MOCK ? 'mock' : 'cloud', backend: PRIMARY, data: info }
  }

  // ===== 冗余分发：按回退链依次尝试，任一后端抛异常即切下一个，避免程序崩溃 =====
  let lastErr = null
  for (let i = 0; i < CHAIN.length; i++) {
    const bk = CHAIN[i]
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
      return r
    } catch (e) {
      lastErr = e
      console.error('[docsProxy] backend=' + bk.kind + ' 处理 action=' + action + ' 抛错：'
        + (e && e.message) + (i < CHAIN.length - 1 ? '；尝试下一个后端' : '；已是链尾'))
      if (i >= CHAIN.length - 1) break
    }
  }
  // 所有后端均失败：返回结构化错误，进程不崩
  return { code: 500, data: { msg: (lastErr && lastErr.message) || '所有数据后端均不可用' }, src: 'mock', backend: 'none', fallback: true }
}
