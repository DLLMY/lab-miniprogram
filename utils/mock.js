// utils/mock.js
// 本地演示数据（结构对齐生产 8 张表：腾讯文档或微信云数据库）。
// 仅作为「云函数不可用时」的回退，保证导入即跑。生产由云函数 docsProxy 读写真实后端（腾讯文档或微信云数据库）。
//
// 【数据域隔离说明 · 有意例外】
// 小程序端无法 require 云函数目录的 data-scope.js，且本演示模式刻意不做服务端鉴权
// （见下方 dispatch 注释）、seed 全表为空、不接触任何真实账号与业务流水，
// 因此这里不实现班级行级隔离。真实数据路径（cloud / tencent 两套适配器 + prodHandler）
// 已完整隔离，详见 cloudfunctions/docsProxy/data-scope.js 与 docs/数据域隔离设计.md。
// 若将来演示模式也要演示多班级场景，需把 data-scope.js 的纯函数副本移植到本文件并在
// dispatch 统一出口注入过滤；当前不做是刻意的设计取舍，避免演示数据「莫名消失」被误判为故障。

function clone(o) { return JSON.parse(JSON.stringify(o)) }

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

const seed = {
  // 测试数据已全部清空（2026-11-15）：准备录入真实数据。
  // 仅作为「云函数不可用时」的回退；生产由云函数 docsProxy 读写真实后端。
  users: [],
  materials: [],
  tools: [],
  requisitions: [],
  borrow: [],
  stock_io: [],
  access: [],
  logs: [],
  // 实训室归属管理体系：前端回退演示数据已清空（结构与云库一致）
  labs: [],
  repairs: [],
  inspections: []
}

// 数据版本戳：seed 结构/内容变更（如 2026-11-15 清空全部演示数据）后必须让旧本地缓存失效，
// 否则老用户设备上残留的 lab_mock 会优先于新 seed 被读出，演示数据"复活"。版本不一致即重置。
const DATA_VERSION = 'v2-clean-20261115'
let DB
try {
  const cached = wx.getStorageSync('lab_mock')
  const cachedVer = wx.getStorageSync('lab_mock_ver')
  if (cached && cachedVer === DATA_VERSION) {
    DB = cached
  } else {
    DB = clone(seed)
    wx.setStorageSync('lab_mock_ver', DATA_VERSION)
    wx.setStorageSync('lab_mock', DB)
  }
} catch (e) {
  DB = clone(seed)
}
// 持久化带配额保护：小程序存储上限 10MB，演示模式长时间使用后 logs/stock_io 会膨胀，
// wx.setStorageSync 超限会 throw——原来直接抛出，被上层 catch 成"操作失败"但看不出原因。
// 现在：失败 → 裁掉最旧的 logs/stock_io 各 50 条重试一次；仍失败 → 只告警不抛出
// （演示数据丢了不致命，但不能让一次存储失败把整个写操作搞成假失败）。
function persist() {
  try {
    wx.setStorageSync('lab_mock', DB)
  } catch (e) {
    console.warn('[mock] 存储失败（可能超 10MB 配额），裁剪旧流水后重试：' + (e && e.message))
    const trim = (arr) => { if (Array.isArray(arr) && arr.length > 50) arr.splice(0, 50) }
    trim(DB.logs); trim(DB.stock_io); trim(DB.access)
    try {
      wx.setStorageSync('lab_mock', DB)
    } catch (e2) {
      console.error('[mock] 裁剪后仍无法持久化，本次修改仅存在于内存：' + (e2 && e2.message))
    }
  }
}

// 迁移：早期版本的 lab_mock 里 users 表可能缺 role、或把教师存成 student。
// 这会让 T001 登录后被判定为学生、进而进不去「待审批/出入库/使用概况」。users 表以种子为准，逐条校正。
function migrateUsers() {
  let changed = false
  if (!DB.users || !Array.isArray(DB.users)) {
    DB.users = clone(seed.users)
    changed = true
  } else {
    const byId = {}
    DB.users.forEach(u => { if (u && u.id) byId[u.id] = u })
    seed.users.forEach(s => {
      const old = byId[s.id]
      if (!old) {
        DB.users.push(clone(s))
        changed = true
      } else {
        if (old.role !== s.role) { old.role = s.role; changed = true }
        if (!old.name) { old.name = s.name; changed = true }
        if (old.cls === undefined) { old.cls = s.cls; changed = true }
      }
    })
  }
  if (changed) {
    persist()
    console.log('[mock] users 表已按种子校正（教师/管理员角色修复）')
  }
}
migrateUsers()
function now() {
  // 与云函数/两套适配器一致固定 UTC+8 墙钟：非北京时间设备上用本地时区会与 tsOf 的 +08:00 解析错配。
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const p = n => ('' + n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}
function ok(data) { return { code: 0, data } }
// 演示模式流水记录也带 cls 字段（恒为空），保持与生产返回契约同形。
function flowCls(x) { return Object.assign({}, x, { cls: x.cls || '' }) }
function mat(id) { return DB.materials.find(m => m.id === id) }
// 与云函数同款：机器通道 decision:"approve"|"reject" 归一为 ok:true/false，
// 并对驳回强制原因（与生产一致，避免演示环境与线上规则漂移）。
function normalizeApprove(d) {
  if (!d) return d
  const x = Object.assign({}, d)
  if (typeof x.ok !== 'boolean' && x.decision != null) {
    const v = ('' + x.decision).trim().toLowerCase()
    x.ok = ['approve', 'approved', 'pass', '通过', '同意', 'true', '1'].indexOf(v) >= 0
  }
  return x
}
// 演示流水单号：同一毫秒内连写多条会撞号，撞号后「按单号冲销」会命中错误的那一行
let ioSeq = 0
function ioNo() { return 'IO' + Date.now() + '_' + (++ioSeq) }
// 演示时间是北京时间字符串，筛选区间用毫秒时间戳，这里做一次性换算
function tsOf(s) { const n = Date.parse(('' + (s || '')).replace(' ', 'T') + '+08:00'); return Number.isFinite(n) ? n : 0 }
// 计划日期是 YYYY-MM-DD 的「日」粒度，按北京时间当日 23:59:59 到期。
// 直接 tsOf('2026-11-22') 会得到 NaN（缺时间部分），使逾期清单永远为空。
function planEnd(s) { if (!s) return 0; const t = Date.parse(('' + s).slice(0, 10) + 'T23:59:59+08:00'); return Number.isFinite(t) ? t : 0 }
// 与生产 planDue(DEFAULT_LOAN_DAYS=7) 对齐：演示模式也要写「应归还日期」，否则逾期恒为空
function dueStr(days) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + (Math.min(90, Math.max(1, Number(days) || 7))) * 86400000)
  const p = n => ('' + n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}
// 大小写/空格归一：与生产 findUser 对齐（lab_mock 里的工号可能被手输成 't001'）
function user(id) {
  const k = ('' + (id || '')).trim().toUpperCase()
  return DB.users.find(u => ('' + (u.id || '')).trim().toUpperCase() === k) || null
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

function dispatch(action, data) {
  switch (action) {
    case 'getItem': {
      // 与生产 getItem 一致：trim + 大写归一（prod 侧已按此规范，mock 不能大小写敏感）
      const key = ('' + (data.id || '')).trim().toUpperCase()
      const m = DB.materials.find(x => ('' + x.id).toUpperCase() === key)
      const t = DB.tools.find(x => ('' + x.id).toUpperCase() === key)
      if (m) return ok({ type: 'material', item: normMatMock(m) })
      if (t) return ok({ type: 'tool', item: normToolMock(t) })
      return { code: 404, data: { msg: '未找到物品' } }
    }
    case 'listMine': {
      const rs = DB.requisitions.filter(r => r.user === data.user)
      const bs = DB.borrow.filter(b => b.user === data.user)
      return ok({ requisitions: rs.map(flowCls), borrow: bs.map(flowCls) })
    }
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
    case 'listMaterials': {
      return ok((DB.materials || []).map(normMatMock))
    }
    // 与云侧 mockHandler / prodHandler 对齐：缺失时回退 mock 会掉进 default 404，
    // 前端 tools 恒为空（库存页「在册工具」0 条、工作台工具数 0）——静默且难查
    case 'listTools': {
      return ok((DB.tools || []).map(normToolMock))
    }
    // 模糊搜索（前端本地回退）：与云侧 mockHandler 同一返回形状，演示模式也能搜
    case 'search': {
      const q = ('' + (data.kw || '')).trim().toLowerCase()
      if (!q) return ok([])
      const hit = (o, keys) => keys.some(k => ('' + (o[k] || '')).toLowerCase().includes(q))
      const mats = (DB.materials || [])
        .filter(m => hit(m, ['id', 'name', 'spec', 'cat', 'loc', 'unit']))
        .map(m => ({ type: 'material', id: m.id, name: m.name, sub: [m.spec, m.unit, m.loc].filter(Boolean).join(' · ') || '耗材', stock: Number(m.stock) || 0, score: 1 }))
      const tools = (DB.tools || [])
        .filter(t => hit(t, ['id', 'name', 'spec', 'sn', 'loc', 'status']))
        .map(t => ({ type: 'tool', id: t.id, name: t.name, sub: [t.spec, t.loc].filter(Boolean).join(' · ') || '工具', status: t.status, score: 1 }))
      return ok(mats.concat(tools).slice(0, 12))
    }
    case 'listStockIO': {
      // 与生产 listStockIO 同形状：{rows,total,offset,limit,hasMore,inQty,outQty}。
      // 旧版返回裸数组 → 出入库页的筛选与上拉加载在回退模式下全部失效。
      const nameMap = {}
      for (const m of DB.materials) nameMap[m.id] = m.name
      const item = ('' + (data.item || '')).trim().toUpperCase()
      const dir = ('' + (data.dir || '')).trim()
      const op = ('' + (data.op || '')).trim().toUpperCase()
      const from = Number(data.from) || 0
      const to = Number(data.to) || 0
      let rows = DB.stock_io.map(r => ({
        id: r.no || '',
        item: r.matId || '',
        dir: (r.type === 'out' ? '出库' : '入库'),
        qty: Number(r.qty) || 0,
        op: r.operator || '',
        time: r.time || '',
        note: r.note || '',
        src: r.src || '',
        reversed: ('' + (r.note || '')).indexOf('[已冲销]') >= 0 || (r.src || '') === '冲销' || ('' + (r.note || '')).indexOf('冲销流水') >= 0,
        itemName: nameMap[r.matId] || r.matId || '',
        cls: r.cls || ''
      })).filter(r => r.item && r.dir)
      rows = rows.filter(r => {
        if (item && ('' + r.item).toUpperCase().indexOf(item) < 0) return false
        if (dir && r.dir !== dir) return false
        if (op && ('' + r.op).toUpperCase().indexOf(op) < 0) return false
        const t = tsOf(r.time)
        if (from && t && t < from) return false
        if (to && t && t > to) return false
        return true
      })
      rows.sort((a, b) => ('' + b.time).localeCompare('' + a.time))
      const total = rows.length
      const offset = Math.max(0, Number(data.offset) || 0)
      const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
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
      // 教师端「领用记录」查询。与生产 listClaims 同形状：
      // {rows,total,offset,limit,hasMore,byCls,classOptions}
      const nameMap = {}
      const unitMap = {}
      for (const m of DB.materials) { nameMap[m.id] = m.name; unitMap[m.id] = m.unit || '' }
      const uMap = {}
      for (const u of DB.users) uMap[u.id] = u
      const clsFilter = ('' + (data.cls || '')).trim()
      const itemKw = ('' + (data.item || '')).trim().toUpperCase()
      const userKw = ('' + (data.user || '')).trim().toUpperCase()
      const status = ('' + (data.status || '')).trim()
      // 前端传中文状态（线上存储口径），mock 存英文，需别名映射否则演示筛选恒空
      const statusAlias = { '待审批': 'pending', '已通过': 'approved', '已拒绝': 'rejected', '已撤销': 'canceled', '已撤回': 'canceled' }
      const wantStatus = statusAlias[status] || status
      const from = Number(data.from) || 0
      const to = Number(data.to) || 0
      let rows = (DB.requisitions || []).map(r => {
        const item = r.matId || r.toolId || ''
        const u = uMap[r.user] || {}
        return {
          no: r.no || '', item,
          itemName: nameMap[item] || item, unit: unitMap[item] || '',
          qty: Number(r.qty) || 0,
          user: r.user || '', userName: u.name || r.user || '',
          cls: r.cls || u.cls || '',
          reason: r.reason || '', reject: r.reject || '',
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
      const offset = Math.max(0, Number(data.offset) || 0)
      const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
      const page = rows.slice(offset, offset + limit)
      const byCls = {}
      rows.forEach(r => {
        const key = r.cls || '未标注班级'
        if (!byCls[key]) byCls[key] = { cls: key, qty: 0, count: 0 }
        byCls[key].qty += r.qty
        byCls[key].count += 1
      })
      return ok({
        rows: page, total, offset, limit,
        hasMore: offset + page.length < total,
        byCls: Object.values(byCls).sort((a, b) => b.qty - a.qty),
        classOptions: Array.from(new Set(rows.map(r => r.cls).filter(Boolean))).sort()
      })
    }
    // 以下 4 个 case 是前端会调到、但原先缺失的 action：缺失时云函数不可用会回退到这里，
    // 然后落到 default 的 404，用户看到的是 "unknown action" 这种无语义错误。
    // 撤回申请（P1-⑨）：仅待审批可撤。演示数据如果不实现，演示时点撤回会 404，
    // 而线上正常——这类演示/生产不一致最难查，故显式对齐。
    case 'cancelReq': {
      const no = '' + (data.no || '')
      const r = DB.requisitions.find(x => '' + x.no === no)
      if (!r) return { code: 404, data: { msg: '申请不存在：' + no } }
      if (r.status !== 'pending') return { code: 400, data: { msg: '仅待审批的申请可撤销' } }
      r.status = 'canceled'
      return ok({})
    }
    // 导出（P1-⑩）：演示模式下也要能演示"导出一份看效果"，返回最小可用 CSV
    case 'exportData': {
      const kind = '' + (data.kind || 'materials')
      const cell = (v) => {
        const s = v === null || v === undefined ? '' : '' + v
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
      }
      const lines = (header, rows) => [header.map(cell).join(',')].concat(rows.map(r => r.map(cell).join(','))).join('\r\n')
      let header = [], rows = [], name = kind
      if (kind === 'materials') {
        header = ['耗材ID', '名称', '规格', '类别', '存放位置', '当前库存', '单位', '预警线']
        rows = (DB.materials || []).map(m => [m.id, m.name, m.spec || '', m.cat || '', m.loc || '', m.stock, m.unit || '', m.safe || 0])
        name = '耗材库存清单'
      } else if (kind === 'tools') {
        header = ['工具ID', '名称', '规格', '存放位置', '状态', '当前持有人']
        rows = (DB.tools || []).map(t => [t.id, t.name, t.spec || t.sn || '', t.loc || '', t.status, t.borrower || ''])
        name = '工具台账'
      } else if (kind === 'stock_io') {
        header = ['流水ID', '物品ID', '方向', '数量', '操作人', '时间', '来源类型', '备注']
        rows = (DB.stock_io || []).map(r => [r.no, r.matId, r.type === 'out' ? '出库' : '入库', r.qty, r.operator, r.time, r.src || '', r.note || ''])
        name = '出入库流水'
      } else if (kind === 'requisitions') {
        header = ['申请ID', '申请人ID', '物品ID', '类型', '数量', '用途说明', '状态', '申请时间', '驳回原因']
        rows = (DB.requisitions || []).map(r => [r.no, r.user || '', r.matId || r.toolId || '', r.kind || '', r.qty || 0, r.reason || '', r.status || '', r.time || '', r.reject || ''])
        name = '领用申请单'
      } else if (kind === 'borrow') {
        header = ['借还ID', '借用人ID', '工具ID', '借出时间', '计划归还', '实际归还', '状态']
        rows = (DB.borrow || []).map(b => [b.id, b.user || '', b.toolId || '', b.out || '', b.plan || '', b.in || '', b.status || ''])
        name = '工具借用记录'
      } else if (kind === 'access') {
        header = ['记录ID', '用户ID', '门禁点', '刷卡时间', '结果']
        rows = (DB.access || []).map(a => [a.id || '', a.actor || a.user || '', a.door || a.point || '', a.time || '', a.result || ''])
        name = '门禁记录'
      } else if (kind === 'logs') {
        header = ['日志ID', '时间', '操作人', '操作类型', '对象', '结果']
        rows = (DB.logs || []).map(l => [l.id || '', l.time || '', l.actor || '', l.op || '', l.target || '', l.result || ''])
        name = '操作日志'
      } else {
        return { code: 400, data: { msg: '演示模式不支持导出：' + kind } }
      }
      return ok({ filename: name + '（演示）.csv', count: rows.length, csv: '\uFEFF' + lines(header, rows) })
    }
    // 盘点 / 期初（P1-⑪⑫）：演示模式下按同一套规则改库存，并记演示流水
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
        // 与生产 stocktake 对齐：实盘数必须是不小于 0 的整数（旧版 Math.max(0,…) 会把
        // 误填的负数当成 0 去调整，等于凭空出一笔库）
        const real = parseQty(it.real, 0)
        if (real === null) return { code: 400, data: { msg: '实盘数量必须是 0 ~ 1000000 之间的整数：' + it.matId } }
        // 期初建账与盘点统一收敛到「实盘数」：diff=实盘-账面，m.stock=实盘（而非 book+diff）。
        // 旧版期初用 diff=real 再 m.stock=book+real 会翻倍（book 非空时 102+80→182）。
        const diff = real - book
        if (diff === 0) { unchanged++; details.push({ matId: it.matId, book, real, diff: 0 }); continue }
        m.stock = real
        DB.stock_io.push({
          no: ioNo(), matId: it.matId, type: diff > 0 ? 'in' : 'out',
          qty: Math.abs(diff), operator: data.actor || '',
          time: now(), note: (opening ? '期初建账 ' : '盘点调整 ') + it.matId,
          src: opening ? '期初建账' : '盘点调整'
        })
        adjusted++
        details.push({ matId: it.matId, book, real, diff })
      }
      persist()
      return ok({ mode: opening ? 'opening' : 'stocktake', adjusted, unchanged, details })
    }
    // 批量出入库（P2-⑯）：与生产 batchIo 同构——同物品合并累加、逐项写流水、库存不足该项跳过
    case 'batchIo': {
      const type = data.type === 'out' ? 'out' : 'in'
      const items = Array.isArray(data.items) ? data.items : []
      if (!items.length) return { code: 400, data: { msg: '没有需要登记的物品' } }
      const merged = {}
      for (const it of items) {
        const matId = ('' + (it.matId || '')).trim()
        if (!matId) continue
        const qty = parseQty(it.qty)
        if (qty === null) return { code: 400, data: { msg: '数量必须是 1 ~ 1000000 之间的整数：' + matId } }
        merged[matId] = (merged[matId] || 0) + qty
      }
      const keys = Object.keys(merged)
      if (!keys.length) return { code: 400, data: { msg: '没有有效的登记数据' } }
      const details = []
      let done = 0
      for (const matId of keys) {
        const qty = merged[matId]
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
      DB.logs.push({ time: now(), actor: data.actor || '', op: type === 'in' ? '批量入库' : '批量出库', target: keys.length + ' 项', result: '成功 ' + done + ' 项' })
      persist()
      return ok({ type, done, failed: details.filter(d => d.err).length, details })
    }
    // 冲销（P2-㉒）：写反向流水把库存抵回，原流水加 [已冲销] 标记，不删除
    case 'reverseIO': {
      const no = '' + (data.no || '')
      if (!no) return { code: 400, data: { msg: '缺少流水号' } }
      const r = (DB.stock_io || []).find(x => ('' + (x.no || x.id || '')) === no)
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
      persist()
      return ok({ no, item: r.matId, dir: backType === 'in' ? '入库' : '出库', qty, stock: next })
    }
    // 操作日志（P2-㉑）：与生产 listLogs 同返回形状，供「操作日志」页在回退模式下也能用
    case 'listLogs': {
      const actor = ('' + (data.actor || '')).trim().toUpperCase()
      const op = ('' + (data.op || '')).trim()
      const target = ('' + (data.target || '')).trim().toUpperCase()
      const from = Number(data.from) || 0
      const to = Number(data.to) || 0
      const rows = (DB.logs || []).map((l, i) => ({
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
    // 门禁记录（P3-㉑）：access 表此前"有写入、无查询"，这里补齐读取侧
    case 'listAccess': {
      const who = ('' + (data.user || '')).trim().toUpperCase()
      const point = ('' + (data.point || '')).trim()
      const from = Number(data.from) || 0
      const to = Number(data.to) || 0
      const rows = (DB.access || []).map((a, i) => ({
        id: a.id || 'A' + i, time: a.time || '', user: a.actor || a.user || '', point: a.door || a.point || '', result: a.result || ''
      })).filter(a => {
        if (who && ('' + a.user).toUpperCase().indexOf(who) < 0) return false
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
    // 云端自检：如实报告本地演示，避免把「没连上云函数」误显示成「云端是旧版代码」
    case 'diag': return ok({
      useMock: true, hasCredential: false, rawUseMock: '(未连接云函数，走本地演示数据)',
      ping: 'skipped(前端本地mock，未尝试连云端)'
    })
    // 登录绑定：mock 无 openid 概念，仅校验姓名+工号是否命中本地 users 表
    // whoami（openid→身份）：本地 mock 没有 openid 概念，与云侧 mockHandler 语义一致——
    // 恒返回 null（code 0, data null），让 login.js 的 bootstrap 落到「姓名+工号」表单。
    // 缺失时会掉进 default 404，虽最终行为相同，但契约不对齐，故显式声明。
    case 'whoami': return ok(null)
    case 'bindLogin': {
      const key = ('' + (data.id || '')).trim().toUpperCase()
      const name = ('' + (data.name || '')).trim()
      const u = DB.users.find(x => ('' + x.id).toUpperCase() === key)
      if (!u) return { code: 404, data: { msg: '工号不存在（本地演示）' } }
      if (name !== ('' + (u.name || '')).trim()) return { code: 400, data: { msg: '姓名与工号不匹配（本地演示）' } }
      if (u.status && u.status !== '启用') return { code: 400, data: { msg: '该账号未启用（本地演示）' } }
      return ok({ id: u.id, name: u.name, role: u.role, cls: u.cls || '' })
    }
    case 'findUser': {
      const key = ('' + (data.id || '')).trim().toUpperCase()
      const u = DB.users.find(x => ('' + x.id).toUpperCase() === key)
      return u ? ok({ id: u.id, name: u.name, role: u.role, cls: u.cls || '' }) : { code: 404, data: { msg: '未找到该工号' } }
    }
    // 机器通道身份自查（离线演示）
    case 'robotIdentity': {
      const u = DB.users.find(x => ('' + x.id).toUpperCase() === ('' + (data.id || '')).trim().toUpperCase())
        || DB.users.find(x => x.role === (data.role || 'teacher'))
      if (!u) return { code: 401, data: { msg: '离线演示未找到对应身份' } }
      return ok({
        id: u.id, name: u.name, role: u.role, channel: 'wechat', channelLabel: '离线演示（本地内存）',
        scopeFull: true, scopeLabel: '全部班级（演示模式不隔离）',
        managedClasses: u.managedClasses || '', cls: u.cls || '',
        warning: '离线演示不隔离数据，不代表线上真实权限。'
      })
    }
    // 个人机器人密钥：本地演示无云端身份体系，密钥管理必须在联网（真实云函数）下进行
    case 'robotKeyStatus': return ok({ hasKey: false })
    case 'genRobotKey': return { code: 400, data: { msg: '离线演示模式不支持生成密钥，请联网并在小程序内登录后操作' } }
    case 'revokeRobotKey': return { code: 400, data: { msg: '离线演示模式不支持吊销密钥，请联网后在小程序内操作' } }
    case 'addMaterial': {
      const name = ('' + (data.name || '')).trim()
      if (!name) return { code: 400, data: { msg: '请填写物品名称' } }
      const qty = parseQty(data.qty, 0)
      if (qty === null) return { code: 400, data: { msg: '数量必须是 0 ~ 1000000 之间的整数' } }
      const dup = DB.materials.find(x => x.name === name)
      if (dup) return { code: 409, data: { msg: '该物品已存在：' + dup.id, matId: dup.id } }
      let max = 0
      DB.materials.forEach(x => { const m = /^\s*[Mm](\d+)\s*$/.exec('' + x.id); if (m) max = Math.max(max, parseInt(m[1], 10) || 0) })
      const newId = 'M' + String(max + 1).padStart(3, '0')
      DB.materials.push({ id: newId, name, spec: data.spec || '', cat: data.cat || '电子元件', loc: data.loc || '', stock: qty, unit: data.unit || '个', safe: Number(data.safe) || 0, status: '正常', expire: expireTsMock(data.expire) })
      DB.stock_io.push({ no: ioNo(), matId: newId, type: 'in', qty, operator: data.actor, time: now(), note: '建档入库', src: '建档入库' })
      DB.logs.push({ time: now(), actor: data.actor, op: '新增耗材', target: newId, result: '建档成功' })
      persist()
      return ok({ id: newId, name, stock: qty, unit: data.unit || '个' })
    }
    case 'importMaterials': {
      const rows = Array.isArray(data.rows) ? data.rows : []
      if (!rows.length) return { code: 400, data: { msg: '清单为空（rows 为空）' } }
      const byId = new Map(), byName = new Map()
      DB.materials.forEach(x => { byId.set('' + x.id, x); byName.set(('' + x.name).trim(), x) })
      let max = 0
      DB.materials.forEach(x => { const m = /^\s*[Mm](\d+)\s*$/.exec('' + x.id); if (m) max = Math.max(max, parseInt(m[1], 10) || 0) })
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
        const stockNum = setStock ? (Number(raw.stock) || 0) : 0
        const existing = (id && byId.get(id)) || byName.get(name)
        if (existing) {
          existing.spec = spec; existing.cat = cat; existing.loc = loc; existing.unit = unit; existing.safe = safe
          const expTs = expireTsMock(raw.expire)
          if (expTs) existing.expire = expTs
          if (setStock) existing.stock = stockNum
          updated.push({ id: existing.id, name })
        } else {
          max += 1
          const newId = id || ('M' + String(max).padStart(3, '0'))
          // expire 必须来自本行的 raw.expire：此前新建行根本没写 expire → 导入带效期的耗材时效期丢失
          DB.materials.push({ id: newId, name, spec, cat, loc, stock: stockNum, unit, safe, status: '正常', expire: expireTsMock(raw.expire) })
          if (stockNum > 0) DB.stock_io.push({ no: ioNo(), matId: newId, type: 'in', qty: stockNum, operator: data.actor, time: now(), note: '清单导入·建档入库', src: '清单导入' })
          created.push({ id: newId, name, stock: stockNum })
        }
      }
      persist()
      return ok({ created: created.length, updated: updated.length, skipped: skipped.length })
    }
    case 'importTools': {
      const rows = Array.isArray(data.rows) ? data.rows : []
      if (!rows.length) return { code: 400, data: { msg: '清单为空（rows 为空）' } }
      const byId = new Map(), byName = new Map()
      DB.tools.forEach(x => { byId.set('' + x.id, x); byName.set(('' + x.name).trim(), x) })
      let max = 0
      DB.tools.forEach(x => { const m = /^\s*[Tt](\d+)\s*$/.exec('' + x.id); if (m) max = Math.max(max, parseInt(m[1], 10) || 0) })
      const created = [], updated = [], skipped = []
      for (let i = 0; i < rows.length; i++) {
        const raw = rows[i] || {}
        const name = ('' + (raw.name || '')).trim()
        if (!name) { skipped.push({ idx: i + 1, reason: '缺名称，跳过' }); continue }
        const id = ('' + (raw.id || '')).trim()
        const spec = ('' + (raw.spec || '')).trim()
        const loc = ('' + (raw.loc || '')).trim()
        const status = ('' + (raw.status || '')).trim() || '在库'
        const holder = ('' + (raw.holder || '')).trim()
        const existing = (id && byId.get(id)) || byName.get(name)
        if (existing) {
          existing.spec = spec; existing.loc = loc; existing.status = status; existing.holder = holder
          updated.push({ id: existing.id, name })
        } else {
          max += 1
          const newId = id || ('T' + String(max).padStart(3, '0'))
          DB.tools.push({ id: newId, name, spec, loc, status, holder })
          created.push({ id: newId, name })
        }
      }
      persist()
      return ok({ created: created.length, updated: updated.length, skipped: skipped.length })
    }
    case 'access': {
      const who = data.user || data.actor || ''
      DB.access.push({ time: now(), actor: who, door: data.door || '实训室门', result: data.result || '开门' })
      persist()
      return ok({})
    }
    // 强制刷新：本地 mock 无缓存，直接放行（与云端 fresh 语义一致）
    case 'fresh': return ok({ cleared: true })
    // 全库快照（离线演示）：与云函数 snapshot 同形状，供「数据备份」页在无云环境时也能导出。
    case 'snapshot': {
      const users = (DB.users || []).map(u => ({ rid: 'm_' + u.id, id: u.id, name: u.name, role: u.role, cls: u.cls || '', managedClasses: u.managedClasses || '', status: u.status || '启用', bound: false }))
      const byRole = users.reduce((a, u) => { a[u.role] = (a[u.role] || 0) + 1; return a }, {})
      const dump = JSON.parse(JSON.stringify(DB))
      dump.users = users
      dump.usersByRole = byRole
      return ok(dump)
    }
    case 'requisition': {
      // 与生产路径一致：数量/物品ID 校验，不信客户端
      const matId = ('' + (data.matId || '')).trim()
      if (!matId) return { code: 400, data: { msg: '缺少物品ID，无法提交申请' } }
      const qty = parseQty(data.qty)
      if (qty === null) return { code: 400, data: { msg: '数量必须是 1 ~ 1000000 之间的整数' } }
      // 与生产 requisition 对齐：用途必填，否则演示能提交、线上被拒
      if (!('' + (data.reason || '')).trim()) return { code: 400, data: { msg: '请填写用途说明' } }
      if (!mat(matId)) return { code: 400, data: { msg: '物品不存在：' + matId } }
      const no = 'R' + Date.now()
      DB.requisitions.push({ no, user: data.user, matId, qty, kind: 'material', status: 'pending', time: now(), reason: data.reason || '', reject: '' })
      DB.logs.push({ time: now(), actor: data.user, op: '提交领用申请', target: matId, result: '待审批' })
      persist()
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
      persist()
      return ok({ no })
    }
    case 'approve': {
      const ap = normalizeApprove(data)
      const r = DB.requisitions.find(x => x.no === ap.no)
      if (!r) return { code: 404, data: {} }
      // 与生产 approve 同款守卫：已处理（approved/rejected）的单不能再审批。
      // 缺这个守卫时，重复点击/两个审批人同时点通过 → 二次扣库存、重复建借还记录。
      if (r.status !== 'pending') return { code: 400, data: { msg: '该申请已处理' } }
      if (!ap.ok) {
        const why = ('' + (ap.reason || '')).trim().slice(0, 60)
        if (!why) return { code: 400, data: { msg: '请填写驳回原因，便于申请人知晓（如：库存暂缺，请改用替代型号）' } }
        r.reject = why
      }
      if (ap.ok) {
        if (r.kind === 'tool') {
          const t = DB.tools.find(x => x.id === r.toolId)
          if (!t) return { code: 404, data: { msg: '工具不存在' } }
          if (t.status !== '在库') return { code: 400, data: { msg: '该工具不在库' } }
          DB.borrow.push({ id: 'B' + Date.now(), toolId: r.toolId, user: r.user, out: now(), plan: dueStr(ap.days || r.days), in: '', status: '借出', note: (r.reason || '').trim().slice(0, 120) })
          t.status = '借出'; t.borrower = r.user; t.outTime = now()
          DB.logs.push({ time: now(), actor: ap.actor || data.actor, op: '审批通过工具借出', target: r.toolId, result: '已通过' })
        } else {
          const m = mat(r.matId)
          if (m.stock < r.qty) return { code: 400, data: { msg: '库存不足' } }
          // 与生产同款幂等闸门：本单若已出过库，绝不二次扣减库存
          if (DB.stock_io.some(x => x.note === '领用申请 ' + r.no)) {
            r.status = 'approved'
            return ok({ idempotent: true, no: r.no, warn: '该申请此前已出库，本次未重复扣减库存' })
          }
          m.stock -= r.qty
          // 与生产同构：审批通过同步写出库流水，避免演示模式库存与流水对不上
          DB.stock_io.push({ no: ioNo(), matId: r.matId, type: 'out', qty: r.qty, operator: ap.actor || data.actor || r.user || '', time: now(), note: '领用申请 ' + r.no, src: '领用出库', cls: r.cls || '' })
          DB.logs.push({ time: now(), actor: ap.actor || data.actor, op: '审批通过', target: r.matId, result: '已通过' })
        }
        r.status = 'approved'
      } else {
        r.status = 'rejected'
        DB.logs.push({ time: now(), actor: ap.actor || data.actor, op: '审批拒绝', target: r.no, result: '已拒绝' })
      }
      persist()
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
      persist()
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
        const bs = DB.borrow.filter(x => x.toolId === r.toolId && x.user === r.user && x.status === '借出')
        bs.forEach(b => { b.status = '已还'; b.in = now(); info.rolledBack = true })
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
      persist()
      return ok(info)
    }
    case 'io': {
      const m = mat(data.matId)
      if (!m) return { code: 404, data: {} }
      if (data.type !== 'in' && data.type !== 'out') return { code: 400, data: { msg: '登记方向必须是 in / out' } }
      const qty = parseQty(data.qty)
      if (qty === null) return { code: 400, data: { msg: '数量必须是 1 ~ 1000000 之间的整数' } }
      if (data.type === 'out' && m.stock < qty) return { code: 400, data: { msg: '出库超库存' } }
      m.stock += data.type === 'in' ? qty : -qty
      DB.stock_io.push({ no: ioNo(), matId: data.matId, type: data.type, qty, operator: data.actor, time: now(), src: data.src || (data.type === 'in' ? '手动入库' : '手动出库') })
      DB.logs.push({ time: now(), actor: data.actor, op: '出入库登记', target: data.matId, result: (data.type === 'in' ? '+' : '-') + qty })
      persist()
      return ok({})
    }
    case 'borrow': {
      const t = DB.tools.find(x => ('' + x.id).toUpperCase() === ('' + (data.toolId || '')).trim().toUpperCase())
      if (!t) return { code: 404, data: {} }
      if (t.status !== '在库') return { code: 400, data: { msg: '该工具不在库' } }
      // 注意：mock DB 存的是「前端契约值」——生产路径 normBorrow 会把表里的「借出中」翻成
      // 「借出」、「已归还」翻成「已还」，mine.wxml 按 item.status==='借出' 渲染。
      // mock 不过 normBorrow，所以这里必须直接存契约值，不能存中文表值。
      DB.borrow.push({ id: 'B' + Date.now(), toolId: data.toolId, user: data.user, out: now(), plan: dueStr(data.days), in: '', status: '借出', note: (data.note || '').trim().slice(0, 120) })
      t.status = '借出'; t.borrower = data.user; t.outTime = now()
      DB.logs.push({ time: now(), actor: data.actor || data.user, op: '借出工具', target: data.toolId, result: '借出' })
      persist()
      return ok({})
    }
    case 'directBorrow': {
      const borrower = ('' + (data.borrower || '')).trim().toUpperCase()
      if (!borrower) return { code: 400, data: { msg: '请填写借用工号' } }
      const u = DB.users.find(x => ('' + x.id).trim().toUpperCase() === borrower)
      if (!u) return { code: 404, data: { msg: '借用人不存在或已停用：' + borrower } }
      const t = DB.tools.find(x => ('' + x.id).toUpperCase() === ('' + (data.toolId || '')).trim().toUpperCase())
      if (!t) return { code: 404, data: {} }
      if (t.status !== '在库') return { code: 400, data: { msg: '该工具不在库' } }
      const cls = u.cls || ''
      DB.borrow.push({ id: 'B' + Date.now(), toolId: data.toolId, user: u.id, out: now(), plan: dueStr(data.days), in: '', status: '借出', cls, note: (data.note || '').trim().slice(0, 120) })
      t.status = '借出'; t.borrower = u.id; t.outTime = now()
      DB.logs.push({ time: now(), actor: data.actor || u.id, op: '借出工具', target: data.toolId, result: '借出', cls, note: '教师直接借出给 ' + u.id })
      persist()
      return ok({ borrower: u.id, cls })
    }
    case 'returnTool': {
      const b = DB.borrow.find(x => x.toolId === data.toolId && x.status === '借出')
      if (!b) return { code: 404, data: { msg: '没有可归还的记录（该工具当前不在借出中）' } }
      const t = DB.tools.find(x => x.id === data.toolId)
      b.status = '已还'; b.in = now(); b.backNote = (data.note || '').trim().slice(0, 120)
      if (t) { t.status = '在库'; t.borrower = ''; t.outTime = '' }
      DB.logs.push({ time: now(), actor: data.actor, op: '归还工具', target: data.toolId, result: '已还' + (b.backNote ? '：' + b.backNote : '') })
      persist()
      return ok({})
    }
    // 预警聚合（L2 主动服务数据源，离线演示同构）：低库存 + 逾期巡检 + 待审批
    case 'alerts': {
      const lowStock = (DB.materials || [])
        .filter(m => (Number(m.safe) || 0) > 0 && (Number(m.stock) || 0) < (Number(m.safe) || 0))
        .map(m => ({ id: m.id, name: m.name, stock: Number(m.stock) || 0, safe: Number(m.safe) || 0, loc: m.loc || '' }))
      const overdueInspections = (DB.inspections || [])
        .map(r => ({ ...r, overdue: r.status === '待巡检' && !!r.planDate && Date.now() > planEnd(r.planDate) }))
        .filter(x => x.overdue)
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
      const acts = [
        ...DB.logs.map(l => ({ actor: l.actor, op: l.op, time: l.time })),
        ...DB.access.map(a => ({ actor: a.actor, op: '刷开门禁', time: a.time }))
      ]
      const byUser = {}
      acts.forEach(a => {
        byUser[a.actor] = byUser[a.actor] || { n: 0, last: a.time }
        byUser[a.actor].n++
        // 与生产一致取最大时间（acts 是 logs+access 拼接，非时间序，不能简单赋值最后一条）
        if (a.time && (!byUser[a.actor].last || a.time > byUser[a.actor].last)) byUser[a.actor].last = a.time
      })
      const rank = Object.keys(byUser).map(id => {
        // 与生产 usage() 一致：用户不存在时兜底 {id,name:id,role:'?'}，避免 user 为 undefined
        const u = user(id)
        return { user: u ? { id: u.id, name: u.name, role: u.role, cls: u.cls || '' } : { id, name: id, role: '?', cls: '' }, ...byUser[id] }
      }).sort((a, b) => b.n - a.n)
      const teachers = DB.users.filter(u => u.role === 'teacher')
      const activeTeachers = teachers.filter(t => byUser[t.id])
      // —— 报表块与生产 usage 同构（趋势/Top10/周转/逾期/低库存/申请分布）——
      // 缺这些字段时概况页的报表区整片空白，容易被误判成"页面坏了"。
      const months = []
      // 库存流水时间存的是北京时间字符串（now()），月桶必须也按北京历法倒推，
      // 否则运行环境若非北京时区（如服务器 UTC），边界月份流水 slice(0,7) 的 Beijing 月键
      // 会匹配不到本地构造的月桶而被丢弃、趋势图缺一段。
      const nowBJ = new Date(Date.now() + 8 * 3600 * 1000)
      for (let i = 5; i >= 0; i--) {
        const d = new Date(Date.UTC(nowBJ.getUTCFullYear(), nowBJ.getUTCMonth() - i, 1))
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
        const k = ('' + (x.time || '')).slice(0, 7)
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
      const topMaterials = Object.keys(topMap).map(k => topMap[k]).sort((a, b) => b.qty - a.qty).slice(0, 10)
      const turnMap = {}
      for (const b of (DB.borrow || [])) {
        if (!b.toolId) continue
        const t = DB.tools.find(x => x.id === b.toolId)
        turnMap[b.toolId] = turnMap[b.toolId] || { id: b.toolId, name: t ? t.name : b.toolId, times: 0, returned: 0, out: 0 }
        turnMap[b.toolId].times++
        if (b.status === '已还') turnMap[b.toolId].returned++
        else turnMap[b.toolId].out++
      }
      const toolTurnover = Object.keys(turnMap).map(k => turnMap[k]).sort((a, b) => b.times - a.times).slice(0, 10)
      const borrowTotal = (DB.borrow || []).length
      const borrowOpen = (DB.borrow || []).filter(b => b.status !== '已还').length
      const overdue = (DB.borrow || []).filter(b => b.status !== '已还' && planEnd(b.plan) && Date.now() > planEnd(b.plan))
      const lowStock = (DB.materials || []).filter(m => (Number(m.safe) || 0) > 0 && (Number(m.stock) || 0) < (Number(m.safe) || 0))
        .sort((a, b) => (a.stock / Math.max(1, a.safe)) - (b.stock / Math.max(1, b.safe)))
        .map(m => ({ id: m.id, name: m.name, stock: Number(m.stock) || 0, safe: Number(m.safe) || 0, unit: m.unit || '' }))
      const reqStat = {}
      for (const r of (DB.requisitions || [])) reqStat[r.status || 'pending'] = (reqStat[r.status || 'pending'] || 0) + 1
      return ok({
        total: acts.length,
        activeUsers: Object.keys(byUser).length,
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
    case 'listStaff': {
      // 教职工名册（指派用）：只返回工号/姓名/角色，停用账号不返回
      const staff = (DB.users || [])
        .filter(u => u.role === 'teacher' || u.role === 'admin' || u.role === 'super')
        .filter(u => (u.status || '启用') !== '停用')
        .map(u => ({ id: u.id, name: u.name, role: u.role }))
      return ok(staff)
    }
    case 'adminListUsers': {
      // 按调用者层级过滤（与生产一致：super 全量，admin 见教师/学生，teacher 仅见学生）
      const LV = { student: 0, teacher: 1, admin: 2, super: 3 }
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
      const g = lastSuperGuardMock(DB.users, id, role, status)
      if (g) return g
      if (ex) { ex.name = name; ex.role = role; ex.cls = cls; ex.status = status }
      else DB.users.push({ id, name, role, cls, status })
      persist()
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
    case 'adminDeleteUser': {
      const id = ('' + (data.id || '')).trim().toUpperCase()
      const idx = DB.users.findIndex(x => ('' + x.id).toUpperCase() === id)
      if (idx < 0) return { code: 404, data: { msg: '该工号不存在' } }
      // 与生产一致：已绑定微信的账号不能物理删除（否则同工号重建后绑定保护失效）
      if (DB.users[idx].openid) {
        return { code: 409, data: { msg: '该账号已绑定微信，不能直接删除：请改用「停用」（保留档案与绑定），或先「解绑」再删除' } }
      }
      const g = lastSuperGuardMock(DB.users, id, null, null)
      if (g) return g
      DB.users.splice(idx, 1)
      persist()
      return ok({ id })
    }

    // —— 实训室归属管理体系（前端回退：直接操作 DB，与生产同形状）——
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
      persist()
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
      persist()
      return ok({ id: l.id, updated: true })
    }
    case 'deleteLab': {
      const k = ('' + (data.id || '')).trim().toUpperCase()
      const i = DB.labs.findIndex(x => ('' + x.id).toUpperCase() === k)
      if (i < 0) return { code: 404, data: { msg: '未找到该实训室' } }
      DB.labs.splice(i, 1)
      persist()
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
      persist()
      return ok({ id: newId, labId, labName: lab.name, title })
    }
    case 'updateRepair': {
      const r = DB.repairs.find(x => ('' + x.id) === ('' + (data.id || '')))
      if (!r) return { code: 404, data: { msg: '未找到该报修单' } }
      const set = (key, v) => { if (v !== undefined) r[key] = ('' + v).trim() }
      set('status', data.status); set('handlerId', data.handlerId); set('handlerName', data.handlerName)
      set('priority', data.priority); set('resolvedNote', data.resolvedNote)
      r.updatedAt = now()
      persist()
      return ok({ id: r.id, updated: true })
    }
    case 'listInspections': {
      const f = data || {}
      let list = DB.inspections.map(r => ({ ...r, overdue: r.status === '待巡检' && !!r.planDate && Date.now() > planEnd(r.planDate) }))
      list = list.filter(r => {
        if (f.labId && ('' + r.labId).trim().toUpperCase() !== ('' + f.labId).trim().toUpperCase()) return false
        if (f.status === '已逾期') return r.status === '待巡检' && r.overdue
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
      persist()
      return ok({ id: newId, labId, labName: lab.name, title })
    }
    case 'updateInspection': {
      const r = DB.inspections.find(x => ('' + x.id) === ('' + (data.id || '')))
      if (!r) return { code: 404, data: { msg: '未找到该巡检单' } }
      const set = (key, v) => { if (v !== undefined) r[key] = ('' + v).trim() }
      set('status', data.status); set('result', data.result); set('planDate', data.planDate)
      set('executorId', data.executorId); set('executorName', data.executorName)
      if (data.status === '已完成') r.doneAt = now()
      r.updatedAt = now()
      persist()
      return ok({ id: r.id, updated: true })
    }
    default:
      return { code: 404, data: { msg: 'unknown action' } }
  }
}

module.exports = {
  dispatch,
  // 测试钩子：把内存库整体替换掉（供 tools/test_parity.js 与生产适配器做同数据对拍）
  __setDbForTest: (d) => { DB = d || clone(seed) },
  reset: () => { DB = clone(seed); persist() },
  getUser: (id) => user((id || '').trim().toUpperCase()) || null,
  listUsers: () => clone(DB.users)
}
