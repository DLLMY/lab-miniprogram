// utils/mock.js
// 本地演示数据（结构对齐生产 8 张表：腾讯文档或微信云数据库）。
// 仅作为「云函数不可用时」的回退，保证导入即跑。生产由云函数 docsProxy 读写真实后端（腾讯文档或微信云数据库）。

function clone(o) { return JSON.parse(JSON.stringify(o)) }

const seed = {
  // 演示账号已清空：上线前不应随包分发真实工号+姓名组合（原 T001 邓老师 / A001 王管理员 等
  // 与真实 users 表同名同号，存在凭证泄露风险）。生产走真实后端 users 表；纯 mock 模式下
  // 登录将无可用账号（仅开发回退用，可接受）。如需本地演示，请用 tools/add-users.js 录入临时账号。
  users: [],
  materials: [
    { id: 'M001', name: '电阻包(1kΩ)', cat: '电子耗材', unit: '包', safe: 10, stock: 25, loc: 'A柜1层' },
    { id: 'M002', name: '面包板', cat: '电子耗材', unit: '块', safe: 5, stock: 3, loc: 'A柜2层' },
    { id: 'M003', name: '杜邦线(公对母)', cat: '电子耗材', unit: '扎', safe: 20, stock: 40, loc: 'B柜1层' },
    { id: 'M004', name: '焊锡丝', cat: '焊接耗材', unit: '卷', safe: 3, stock: 1, loc: 'C柜' }
  ],
  tools: [
    // 字段与生产 normTool 对齐：{id,name,spec,sn,loc,status,borrower,outTime}
    { id: 'T001', name: '万用表 FLUKE-17', spec: 'FL-17001', sn: 'FL-17001', loc: 'A柜', status: '在库', borrower: '', outTime: '' },
    { id: 'T002', name: '电烙铁 60W', spec: 'LT-2002', sn: 'LT-2002', loc: 'C柜', status: '借出', borrower: 'S002', outTime: '2026-10-20 10:12' },
    { id: 'T003', name: '示波器 SDS1104', spec: 'OS-1104', sn: 'OS-1104', loc: 'B柜', status: '在库', borrower: '', outTime: '' }
  ],
  requisitions: [
    { no: 'R20261001', user: 'S002', matId: 'M003', qty: 2, kind: 'material', status: 'pending', time: '2026-10-22 09:30' }
  ],
  borrow: [
    // status 存前端契约值（'借出'/'已还'）：mock 不过 normBorrow，与生产读回形状对齐
    { id: 'B2026001', toolId: 'T002', user: 'S002', out: '2026-10-20 10:12', in: '', status: '借出' }
  ],
  stock_io: [
    { no: 'IO2026001', matId: 'M001', type: 'in', qty: 10, operator: 'A001', time: '2026-10-18 14:00' }
  ],
  access: [
    { time: '2026-10-22 08:05', actor: 'T001', door: '实训室A', result: '开门' }
  ],
  logs: [
    { time: '2026-10-22 09:30', actor: 'S002', op: '提交领用申请', target: 'M003', result: '待审批' }
  ],
  // 实训室归属管理体系（前端回退演示数据；结构与云库一致）
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

let DB = wx.getStorageSync('lab_mock') || clone(seed)
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
  const d = new Date()
  const p = n => ('' + n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function ok(data) { return { code: 0, data } }
function mat(id) { return DB.materials.find(m => m.id === id) }
// 演示流水单号：同一毫秒内连写多条会撞号，撞号后「按单号冲销」会命中错误的那一行
let ioSeq = 0
function ioNo() { return 'IO' + Date.now() + '_' + (++ioSeq) }
// 演示时间是北京时间字符串，筛选区间用毫秒时间戳，这里做一次性换算
function tsOf(s) { const n = Date.parse(('' + (s || '')).replace(' ', 'T') + '+08:00'); return Number.isFinite(n) ? n : 0 }
// 与生产 planDue(DEFAULT_LOAN_DAYS=7) 对齐：演示模式也要写「应归还日期」，否则逾期恒为空
function dueStr(days) {
  const d = new Date(Date.now() + (Math.min(90, Math.max(1, Number(days) || 7))) * 86400000)
  const p = n => ('' + n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
// 大小写/空格归一：与生产 findUser 对齐（lab_mock 里的工号可能被手输成 't001'）
function user(id) {
  const k = ('' + (id || '')).trim().toUpperCase()
  return DB.users.find(u => ('' + (u.id || '')).trim().toUpperCase() === k) || null
}

function dispatch(action, data) {
  switch (action) {
    case 'getItem': {
      // 与生产 getItem 一致：trim + 大写归一（prod 侧已按此规范，mock 不能大小写敏感）
      const key = ('' + (data.id || '')).trim().toUpperCase()
      const m = DB.materials.find(x => ('' + x.id).toUpperCase() === key)
      const t = DB.tools.find(x => ('' + x.id).toUpperCase() === key)
      if (m) return ok({ type: 'material', item: m })
      if (t) return ok({ type: 'tool', item: t })
      return { code: 404, data: { msg: '未找到物品' } }
    }
    case 'listMine': {
      const rs = DB.requisitions.filter(r => r.user === data.user)
      const bs = DB.borrow.filter(b => b.user === data.user)
      return ok({ requisitions: rs, borrow: bs })
    }
    case 'pending': {
      return ok(DB.requisitions.filter(r => r.status === 'pending'))
    }
    case 'listMaterials': {
      return ok(DB.materials)
    }
    // 与云侧 mockHandler / prodHandler 对齐：缺失时回退 mock 会掉进 default 404，
    // 前端 tools 恒为空（库存页「在册工具」0 条、工作台工具数 0）——静默且难查
    case 'listTools': {
      return ok(DB.tools)
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
        reversed: ('' + (r.note || '')).indexOf('[已冲销]') >= 0,
        itemName: nameMap[r.matId] || r.matId || ''
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
        const real = Math.floor(Number(it.real))
        if (!Number.isFinite(real) || real < 0) return { code: 400, data: { msg: '实盘数量必须是不小于 0 的整数：' + it.matId } }
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
        const qty = Math.floor(Number(it.qty) || 0)
        if (qty < 1) return { code: 400, data: { msg: '数量必须是大于 0 的整数：' + matId } }
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
    // 个人机器人密钥：本地演示无云端身份体系，密钥管理必须在联网（真实云函数）下进行
    case 'robotKeyStatus': return ok({ hasKey: false })
    case 'genRobotKey': return { code: 400, data: { msg: '离线演示模式不支持生成密钥，请联网并在小程序内登录后操作' } }
    case 'revokeRobotKey': return { code: 400, data: { msg: '离线演示模式不支持吊销密钥，请联网后在小程序内操作' } }
    case 'addMaterial': {
      const name = ('' + (data.name || '')).trim()
      if (!name) return { code: 400, data: { msg: '请填写物品名称' } }
      const qty = Math.floor(Number(data.qty) || 0)
      if (qty < 0) return { code: 400, data: { msg: '数量不能为负数' } }
      const dup = DB.materials.find(x => x.name === name)
      if (dup) return { code: 409, data: { msg: '该物品已存在：' + dup.id, matId: dup.id } }
      let max = 0
      DB.materials.forEach(x => { const m = /^\s*[Mm](\d+)\s*$/.exec('' + x.id); if (m) max = Math.max(max, parseInt(m[1], 10) || 0) })
      const newId = 'M' + String(max + 1).padStart(3, '0')
      DB.materials.push({ id: newId, name, spec: data.spec || '', cat: data.cat || '电子元件', loc: data.loc || '', stock: qty, unit: data.unit || '个', safe: Number(data.safe) || 0, status: '正常' })
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
          if (setStock) existing.stock = stockNum
          updated.push({ id: existing.id, name })
        } else {
          max += 1
          const newId = id || ('M' + String(max).padStart(3, '0'))
          DB.materials.push({ id: newId, name, spec, cat, loc, stock: stockNum, unit, safe, status: '正常' })
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
        const status = ('' + (raw.status || '')).trim() || '正常'
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
    case 'requisition': {
      // 与生产路径一致：数量/物品ID 校验，不信客户端
      const matId = ('' + (data.matId || '')).trim()
      if (!matId) return { code: 400, data: { msg: '缺少物品ID，无法提交申请' } }
      const qty = Math.floor(Number(data.qty) || 0)
      if (qty < 1) return { code: 400, data: { msg: '数量必须是大于 0 的整数' } }
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
      DB.requisitions.push({ no, user: data.user, toolId, kind: 'tool', status: 'pending', time: now(), reason: data.reason || '', reject: '' })
      DB.logs.push({ time: now(), actor: data.user, op: '提交工具借出申请', target: toolId, result: '待审批' })
      persist()
      return ok({ no })
    }
    case 'approve': {
      const r = DB.requisitions.find(x => x.no === data.no)
      if (!r) return { code: 404, data: {} }
      // 与生产 approve 同款守卫：已处理（approved/rejected）的单不能再审批。
      // 缺这个守卫时，重复点击/两个审批人同时点通过 → 二次扣库存、重复建借还记录。
      if (r.status !== 'pending') return { code: 400, data: { msg: '该申请已处理' } }
      if (data.ok) {
        if (r.kind === 'tool') {
          const t = DB.tools.find(x => x.id === r.toolId)
          if (!t) return { code: 404, data: { msg: '工具不存在' } }
          if (t.status !== '在库') return { code: 400, data: { msg: '该工具不在库' } }
          DB.borrow.push({ id: 'B' + Date.now(), toolId: r.toolId, user: r.user, out: now(), plan: dueStr(data.days), in: '', status: '借出' })
          t.status = '借出'; t.borrower = r.user; t.outTime = now()
          DB.logs.push({ time: now(), actor: data.actor, op: '审批通过工具借出', target: r.toolId, result: '已通过' })
        } else {
          const m = mat(r.matId)
          if (m.stock < r.qty) return { code: 400, data: { msg: '库存不足' } }
          m.stock -= r.qty
          DB.logs.push({ time: now(), actor: data.actor, op: '审批通过领用', target: r.matId, result: '已通过' })
        }
        r.status = 'approved'
      } else {
        r.status = 'rejected'
        DB.logs.push({ time: now(), actor: data.actor, op: '审批拒绝', target: r.no, result: '已拒绝' })
      }
      persist()
      return ok({})
    }
    case 'io': {
      const m = mat(data.matId)
      if (!m) return { code: 404, data: {} }
      if (data.type !== 'in' && data.type !== 'out') return { code: 400, data: { msg: '登记方向必须是 in / out' } }
      const qty = Math.floor(Number(data.qty) || 0)
      if (qty < 1) return { code: 400, data: { msg: '数量必须是大于 0 的整数' } }
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
      DB.borrow.push({ id: 'B' + Date.now(), toolId: data.toolId, user: data.user, out: now(), plan: dueStr(data.days), in: '', status: '借出' })
      t.status = '借出'; t.borrower = data.user; t.outTime = now()
      DB.logs.push({ time: now(), actor: data.user, op: '借出工具', target: data.toolId, result: '借出' })
      persist()
      return ok({})
    }
    case 'returnTool': {
      const b = DB.borrow.find(x => x.toolId === data.toolId && x.status === '借出')
      const t = DB.tools.find(x => x.id === data.toolId)
      if (b) { b.status = '已还'; b.in = now() }
      if (t) { t.status = '在库'; t.borrower = ''; t.outTime = '' }
      DB.logs.push({ time: now(), actor: data.actor, op: '归还工具', target: data.toolId, result: '已还' })
      persist()
      return ok({})
    }
    // 预警聚合（L2 主动服务数据源，离线演示同构）：低库存 + 逾期巡检 + 待审批
    case 'alerts': {
      const lowStock = (DB.materials || [])
        .filter(m => (Number(m.safe) || 0) > 0 && (Number(m.stock) || 0) <= (Number(m.safe) || 0))
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
      const overdue = (DB.borrow || []).filter(b => b.status !== '已还' && b.plan && tsOf(b.plan) && Date.now() > tsOf(b.plan))
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
    case 'adminListUsers': {
      return ok(DB.users.map(u => ({ rid: 'm_' + u.id, id: u.id, name: u.name, role: u.role, cls: u.cls || '', status: u.status || '启用', bound: false })))
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
      if (ex) { ex.name = name; ex.role = role; ex.cls = cls; ex.status = status }
      else DB.users.push({ id, name, role, cls, status })
      persist()
      return ok({ id })
    }
    case 'adminDeleteUser': {
      const id = ('' + (data.id || '')).trim().toUpperCase()
      const idx = DB.users.findIndex(x => ('' + x.id).toUpperCase() === id)
      if (idx < 0) return { code: 404, data: { msg: '该工号不存在' } }
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
      const planEnd = (s) => { if (!s) return 0; const t = new Date('' + s + 'T23:59:59+08:00').getTime(); return isNaN(t) ? 0 : t }
      let list = DB.inspections.map(r => ({ ...r, overdue: r.status === '待巡检' && !!r.planDate && Date.now() > planEnd(r.planDate) }))
      list = list.filter(r => {
        if (f.labId && ('' + r.labId).trim().toUpperCase() !== ('' + f.labId).trim().toUpperCase()) return false
        if (f.status === '已逾期') return r.status === '待巡检' && r.overdue
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
  reset: () => { DB = clone(seed); persist() },
  getUser: (id) => user((id || '').trim().toUpperCase()) || null,
  listUsers: () => clone(DB.users)
}
