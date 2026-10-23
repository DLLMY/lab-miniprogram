// 云函数 docsProxy —— 中继层
// 职责：持有腾讯文档密钥（仅服务端）、封装文档 API、写操作串行化、权限校验、留痕。
// 部署：微信开发者工具右键 cloudfunctions/docsProxy → 上传并部署（云端安装依赖）。

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const td = require('./tencentdocs.js')

// 演示开关 USE_MOCK 的决策规则（避免"控制台没存进去就永远走 mock"这个坑）：
//   ① 显式设了 USE_MOCK → 完全听它的（'true'/'TRUE' 都认），便于回退排障；
//   ② 没设（含空串）→ 看凭证是否齐全：齐了就走真实腾讯文档，缺了才降级内存 mock。
// 这样即使控制台「保存」按钮转圈、环境变量没落库，只要凭证由 env.local.js 补进来，就自动走真数据。
const RAW_USE_MOCK = process.env.USE_MOCK
const HAS_CREDENTIAL = !!(process.env.TENCENT_DOCS_FILE_ID &&
  process.env.TENCENT_DOCS_CLIENT_ID &&
  process.env.TENCENT_DOCS_ACCESS_TOKEN &&
  process.env.TENCENT_DOCS_OPEN_ID)
const USE_MOCK = (RAW_USE_MOCK === undefined || String(RAW_USE_MOCK).trim() === '')
  ? !HAS_CREDENTIAL
  : String(RAW_USE_MOCK).trim().toLowerCase() === 'true'
console.log('[docsProxy] 启动：USE_MOCK=' + USE_MOCK
  + ' (原始值=' + (RAW_USE_MOCK === undefined ? '(未设置)' : RAW_USE_MOCK) + ')'
  + ' 凭证=' + (HAS_CREDENTIAL ? '4项齐全' : '缺失(将走mock)'))

/* ===================== 内存 mock（演示用，不持久） ===================== */
const seed = {
  users: [
    { id: 'S001', name: '张三', role: 'student' },
    { id: 'T001', name: '邓老师', role: 'teacher' },
    { id: 'A001', name: '王管理员', role: 'admin' }
  ],
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
  logs: []
}
let DB = JSON.parse(JSON.stringify(seed))
function now() { const d = new Date(); const p = n => ('' + n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }
function ok(d) { return { code: 0, data: d } }
function mat(id) { return DB.materials.find(m => m.id === id) }

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
    case 'requisition': {
      const no = 'R' + Date.now()
      DB.requisitions.push({ no, user: data.user, matId: data.matId, qty: data.qty, kind: 'material', status: 'pending', time: now() })
      return ok({ no })
    }
    case 'toolRequisition': {
      const no = 'R' + Date.now()
      DB.requisitions.push({ no, user: data.user, toolId: data.toolId, kind: 'tool', status: 'pending', time: now() })
      return ok({ no })
    }
    case 'approve': {
      const r = DB.requisitions.find(x => x.no === data.no); if (!r) return { code: 404, data: {} }
      if (data.ok) {
        if (r.kind === 'tool') {
          const t = DB.tools.find(x => x.id === r.toolId)
          if (!t || t.status !== '在库') return { code: 400, data: { msg: '工具不在库' } }
          t.status = '借出'; t.borrower = r.user
          DB.borrow.push({ id: 'B' + Date.now(), toolId: r.toolId, user: r.user, out: now(), in: '', status: '借出' })
          r.status = 'approved'
        } else {
          const m = mat(r.matId); if (m.stock < r.qty) return { code: 400, data: { msg: '库存不足' } }; m.stock -= r.qty; r.status = 'approved'
        }
      } else { r.status = 'rejected' }
      return ok({})
    }
    case 'io': {
      const m = mat(data.matId); if (!m) return { code: 404, data: {} }
      if (data.type === 'out' && m.stock < data.qty) return { code: 400, data: { msg: '超库存' } }
      m.stock += data.type === 'in' ? data.qty : -data.qty
      return ok({})
    }
    case 'addMaterial': {
      // mock：建档 = 在 materials 里加一行，ID 沿用 M+序号
      const name = ('' + (data.name || '')).trim()
      if (!name) return { code: 400, data: { msg: '请填写物品名称' } }
      const dup = DB.materials.find(x => x.name === name)
      if (dup) return { code: 409, data: { msg: '该物品已存在：' + dup.id, matId: dup.id } }
      let max = 0
      DB.materials.forEach(x => { const m = /^\s*[Mm](\d+)\s*$/.exec('' + x.id); if (m) max = Math.max(max, parseInt(m[1], 10) || 0) })
      const newId = 'M' + String(max + 1).padStart(3, '0')
      DB.materials.push({
        id: newId, name, spec: data.spec || '', cat: data.cat || '电子元件',
        loc: data.loc || '', stock: Number(data.qty) || 0, unit: data.unit || '个',
        safe: Number(data.safe) || 0, status: '正常'
      })
      DB.stock_io.push({ no: 'IO' + Date.now(), matId: newId, type: 'in', qty: Number(data.qty) || 0, operator: data.actor, time: now(), note: '建档入库' })
      return ok({ id: newId, name, stock: Number(data.qty) || 0, unit: data.unit || '个' })
    }
    case 'listStockIO': {
      const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
      const rows = (DB.stock_io || []).map(x => ({
        id: x.no || x.id || '', item: x.matId || '', dir: x.type === 'in' ? '入库' : '出库',
        qty: Number(x.qty) || 0, op: x.operator || x.op || '', time: x.time || '', note: x.note || ''
      })).filter(x => x.item && x.dir).sort((a, b) => ('' + b.time).localeCompare('' + a.time))
      rows.forEach(r => { const m = mat(r.item); r.itemName = m ? m.name : r.item })
      return ok(rows.slice(0, limit))
    }
    case 'borrow': {
      const t = DB.tools.find(x => x.id === data.toolId)
      if (t && t.status === '在库') { t.status = '借出'; t.borrower = data.user; DB.borrow.push({ id: 'B' + Date.now(), toolId: data.toolId, user: data.user, out: now(), in: '', status: '借出' }) }
      return ok({})
    }
    case 'returnTool': {
      const t = DB.tools.find(x => x.id === data.toolId)
      if (t) { t.status = '在库'; t.borrower = '' }
      return ok({})
    }
    case 'usage': {
      const acts = [...DB.logs.map(l => ({ actor: l.actor, op: l.op, time: l.time })), ...DB.access.map(a => ({ actor: a.actor, op: '刷开门禁', time: a.time }))]
      const byU = {}; acts.forEach(a => { byU[a.actor] = byU[a.actor] || { n: 0 }; byU[a.actor].n++ })
      const rank = Object.keys(byU).map(id => ({ id, ...byU[id] })).sort((a, b) => b.n - a.n)
      return ok({ total: acts.length, activeUsers: Object.keys(byU).length, teacherActive: 0, teacherTotal: 0, rank })
    }
    case 'snapshot': return ok(JSON.parse(JSON.stringify(DB)))
    default: return { code: 404, data: { msg: 'unknown action' } }
  }
}

/* ===================== 生产路径：腾讯文档 ===================== */
async function prodHandler(action, data, openid) {
  // 预热字段映射（仅冷启动有真实成本，之后命中缓存≈0），并让首条请求顺带把各表 fieldId 缓存好，
  // 后续写操作不再逐个串行拉字段，显著缩短审批/出入库等写请求的耗时。
  await td.warmFieldMaps()
  // run：业务函数成功时返回纯数据（无 code）→ 用 ok 包成 {code:0,data}；
  //      业务函数主动返回 {code:4xx,data}（如脏数据/库存不足）→ 原样返回，前端拿到明确错误而非 500。
  const run = async (fn) => {
    const r = await fn
    if (r && typeof r === 'object' && r.code) return r
    return ok(r)
  }
  switch (action) {
    case 'getItem': return run(() => td.getItem(data.id))
    case 'listMine': return run(() => td.listMine(data.user))
    case 'pending': return run(() => td.listPending())
    case 'listMaterials': return run(() => td.listMaterials())
    case 'listTools': return run(() => td.listTools())
    case 'findUser': {
      const found = await td.findUser(data.id)
      if (!found) return { code: 404, data: { msg: '未找到该工号或账号未启用' } }
      // 首次用工号登录：把当前微信 openid 绑定到该用户行，之后可免输工号自动登录。
      // best-effort——绑定失败不影响本次登录。
      if (openid && !found.openid) {
        try { await td.bindOpenId(found.rid, openid) } catch (e) { console.warn('[docsProxy] openid 绑定失败（不影响登录）：' + e.message) }
      }
      return ok(found.user)
    }
    case 'listUsers': return run(() => td.listUsers())
    case 'whoami': return run(() => td.whoami(openid))
    case 'bindLogin': return await td.bindLogin(data, openid)
    case 'requisition': return run(() => td.requisition(data))
    case 'toolRequisition': return run(() => td.toolRequisition(data))
    case 'approve': return run(() => td.approve(data))
    case 'io': return run(() => td.io(data))
    case 'addMaterial': return run(() => td.addMaterial(data))
    case 'listStockIO': return run(() => td.listStockIO(data))
    case 'borrow': return run(() => td.borrow(data))
    case 'returnTool': return run(() => td.returnTool(data))
    case 'access': return run(() => td.access(data))
    case 'usage': return run(() => td.usage())
    case 'snapshot': return run(() => td.snapshot())
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

  // ===== 自检接口：不走 mock/prod 分支，直接回云端真实运行态 =====
  // 用途：前端「我的」页一键显示"到底跑的是 mock 还是真腾讯文档"，不用再翻云端日志。
  // 若当前是生产模式，还会真实读一次 materials 表，验证凭证/表格是否真的通。
  if (action === 'diag') {
    const info = Object.assign({
      useMock: USE_MOCK,
      rawUseMock: (RAW_USE_MOCK === undefined || String(RAW_USE_MOCK).trim() === '')
        ? '(未设置→按凭证自动判断)' : String(RAW_USE_MOCK),
      hasCredential: HAS_CREDENTIAL
    }, td.runtimeInfo())
    if (!USE_MOCK) {
      try {
        const ms = await td.listMaterials()
        info.ping = 'ok'
        info.materialCount = Array.isArray(ms) ? ms.length : 0
        info.materialSample = (Array.isArray(ms) ? ms.slice(0, 3) : []).map(m => m.id + '/' + m.name + ' 库存' + m.stock)
        // 缓存观测：用于判断 API 配额压力（腾讯文档限 150 次/分钟/fileID）
        const cs = td.cacheStats()
        info.cache = { hit: cs.hit, miss: cs.miss, tables: cs.cachedTables.length, ttl: cs.ttl }
      } catch (e) {
        info.ping = 'fail'
        info.pingError = e.message
      }
    } else {
      info.ping = 'skipped(当前是mock模式，未尝试连腾讯文档)'
    }
    console.log('[docsProxy] diag →', JSON.stringify(info))
    return { code: 0, src: USE_MOCK ? 'mock' : 'cloud', data: info }
  }

  try {
    const r = USE_MOCK ? mockHandler(action, data) : await prodHandler(action, data, openid)
    // src 供前端显示「数据来源」：mock=云函数内内存演示数据；cloud=真实腾讯文档
    if (r && typeof r === 'object') r.src = USE_MOCK ? 'mock' : 'cloud'
    console.log('[docsProxy] action=' + action + ' → src=' + (r.src || '?') + (USE_MOCK ? ' (内存mock)' : ' (腾讯文档)'))
    return r
  } catch (e) {
    return { code: 500, data: { msg: e.message }, src: USE_MOCK ? 'mock' : 'cloud' }
  }
}
