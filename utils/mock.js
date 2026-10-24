// utils/mock.js
// 本地演示数据（结构对齐腾讯文档 8 张表）。
// 仅作为「云函数不可用时」的回退，保证导入即跑。生产由云函数 docsProxy 读写腾讯文档。

function clone(o) { return JSON.parse(JSON.stringify(o)) }

const seed = {
  // 演示账号已清空：上线前不应随包分发真实工号+姓名组合（原 T001 邓老师 / A001 王管理员 等
  // 与真实 users 表同名同号，存在凭证泄露风险）。生产走真实腾讯文档 users 表；纯 mock 模式下
  // 登录将无可用账号（仅开发回退用，可接受）。如需本地演示，请用 tools/add-users.js 录入临时账号。
  users: [],
  materials: [
    { id: 'M001', name: '电阻包(1kΩ)', cat: '电子耗材', unit: '包', safe: 10, stock: 25, loc: 'A柜1层' },
    { id: 'M002', name: '面包板', cat: '电子耗材', unit: '块', safe: 5, stock: 3, loc: 'A柜2层' },
    { id: 'M003', name: '杜邦线(公对母)', cat: '电子耗材', unit: '扎', safe: 20, stock: 40, loc: 'B柜1层' },
    { id: 'M004', name: '焊锡丝', cat: '焊接耗材', unit: '卷', safe: 3, stock: 1, loc: 'C柜' }
  ],
  tools: [
    { id: 'T001', name: '万用表 FLUKE-17', sn: 'FL-17001', status: '在库', borrower: '', outTime: '' },
    { id: 'T002', name: '电烙铁 60W', sn: 'LT-2002', status: '借出', borrower: 'S002', outTime: '2026-10-20 10:12' },
    { id: 'T003', name: '示波器 SDS1104', sn: 'OS-1104', status: '在库', borrower: '', outTime: '' }
  ],
  requisitions: [
    { no: 'R20261001', user: 'S002', matId: 'M003', qty: 2, kind: 'material', status: 'pending', time: '2026-10-22 09:30' }
  ],
  borrow: [
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
  ]
}

let DB = wx.getStorageSync('lab_mock') || clone(seed)
function persist() { wx.setStorageSync('lab_mock', DB) }

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
function user(id) { return DB.users.find(u => u.id === id) }

function dispatch(action, data) {
  switch (action) {
    case 'getItem': {
      const m = mat(data.id)
      const t = DB.tools.find(x => x.id === data.id)
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
    case 'requisition': {
      const no = 'R' + Date.now()
      DB.requisitions.push({ no, user: data.user, matId: data.matId, qty: data.qty, kind: 'material', status: 'pending', time: now() })
      DB.logs.push({ time: now(), actor: data.user, op: '提交领用申请', target: data.matId, result: '待审批' })
      persist()
      return ok({ no })
    }
    case 'toolRequisition': {
      const no = 'R' + Date.now()
      DB.requisitions.push({ no, user: data.user, toolId: data.toolId, kind: 'tool', status: 'pending', time: now() })
      DB.logs.push({ time: now(), actor: data.user, op: '提交工具借出申请', target: data.toolId, result: '待审批' })
      persist()
      return ok({ no })
    }
    case 'approve': {
      const r = DB.requisitions.find(x => x.no === data.no)
      if (!r) return { code: 404, data: {} }
      if (data.ok) {
        if (r.kind === 'tool') {
          const t = DB.tools.find(x => x.id === r.toolId)
          if (!t) return { code: 404, data: { msg: '工具不存在' } }
          if (t.status !== '在库') return { code: 400, data: { msg: '该工具不在库' } }
          DB.borrow.push({ id: 'B' + Date.now(), toolId: r.toolId, user: r.user, out: now(), in: '', status: '借出' })
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
      if (data.type === 'out' && m.stock < data.qty) return { code: 400, data: { msg: '出库超库存' } }
      m.stock += data.type === 'in' ? data.qty : -data.qty
      DB.stock_io.push({ no: 'IO' + Date.now(), matId: data.matId, type: data.type, qty: data.qty, operator: data.actor, time: now() })
      DB.logs.push({ time: now(), actor: data.actor, op: '出入库登记', target: data.matId, result: (data.type === 'in' ? '+' : '-') + data.qty })
      persist()
      return ok({})
    }
    case 'borrow': {
      const t = DB.tools.find(x => x.id === data.toolId)
      if (!t) return { code: 404, data: {} }
      if (t.status !== '在库') return { code: 400, data: { msg: '该工具不在库' } }
      DB.borrow.push({ id: 'B' + Date.now(), toolId: data.toolId, user: data.user, out: now(), in: '', status: '借出' })
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
    case 'usage': {
      const acts = [
        ...DB.logs.map(l => ({ actor: l.actor, op: l.op, time: l.time })),
        ...DB.access.map(a => ({ actor: a.actor, op: '刷开门禁', time: a.time }))
      ]
      const byUser = {}
      acts.forEach(a => {
        byUser[a.actor] = byUser[a.actor] || { n: 0, last: a.time }
        byUser[a.actor].n++
        byUser[a.actor].last = a.time
      })
      const rank = Object.keys(byUser).map(id => ({ user: user(id), ...byUser[id] })).sort((a, b) => b.n - a.n)
      const teachers = DB.users.filter(u => u.role === 'teacher')
      const activeTeachers = teachers.filter(t => byUser[t.id])
      return ok({
        total: acts.length,
        activeUsers: Object.keys(byUser).length,
        teacherActive: activeTeachers.length,
        teacherTotal: teachers.length,
        rank
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
      if (['student', 'teacher', 'admin'].indexOf(role) < 0) return { code: 400, data: { msg: '角色非法' } }
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
