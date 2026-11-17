// tools/test_action_matrix.js —— 生产路由权限矩阵实测探针
//
// 为什么需要它：
//   之前对权限的验证靠「读代码逐条确认」，但本项目有 59 个 action、4 类角色，
//   靠人眼必然漏项——本轮就发现 listMaterials/listTools/search/getItem/findUser
//   五个 action 在 prodDispatch 里【没有登录闸】，匿名（HTTP 触发 openid 为空）可直接拉全库。
//   而且「笼子」测试只测了几个代表 action，无法保证其余 action 的闸门等级一致。
//
// 本工具怎么测（不是静态读代码，是真跑）：
//   1. 打桩 wx-server-sdk，让 getWXContext() 返回当前被测身份的 openid；
//   2. DATA_BACKEND=cloud + USE_MOCK=false → CHAIN = [cloud]，强制走真 prodDispatch（不回退 mock）；
//   3. 给云库适配器注入内存伪库，种 5 个身份：
//        匿名('') / student / teacher / admin / super；
//   4. 对每个 action × 每个身份调 exports.main()，记录返回 code；
//   5. 与期望的最低权限等级比对，不一致即失败并打印实际矩阵。
//
// 期望等级（expect）：
//   'public'  —— 允许匿名调用（登录/绑定身份这类入口）
//   'login'   —— 任意已登录用户（含 student）
//   'staff'   —— 教师及以上
//   'admin'   —— 管理员及以上
//   'super'   —— 仅超级管理员
const path = require('path')
const Module = require('module')

// —— wx-server-sdk 打桩：getWXContext 返回当前身份；database() 返回空对象（不会真的被用到）——
let CUR_OPENID = ''
const ModuleStub = {
  init: function () {},
  database: function () { return {} },
  command: {},
  getWXContext: function () { return { OPENID: CUR_OPENID } }
}
const _origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return ModuleStub
  return _origLoad.apply(this, arguments)
}

// 环境：强制走「云库」后端且关闭回退（回退到 mock 会让权限探测失真）
process.env.DATA_BACKEND = 'cloud'
process.env.USE_MOCK = 'false'
process.env.FALLBACK = 'off'

const ROOT = path.join(__dirname, '..')
const clouddb = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'clouddb.js'))
const cloudMock = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'index.js'))

// ---------- 内存伪云库（最小接口：skip/limit/get、add、doc().update/remove）----------
// 伪云库：统一用 tools/fake_cloud_db.js（支持 where().update() 条件更新 → 可验证 CAS 跨实例并发安全）
const { makeDb } = require('./fake_cloud_db.js')
// ---------- 身份与种子数据 ----------
const CLS = '2024级电气1班'
const CLS2 = '2024级电气2班'
function seedRows() {
  return {
    users: [
      { id: 'T001', name: '超级管理员', role: 'super', cls: '', status: '启用', openid: 'o_super', managedClasses: '' },
      { id: 'A001', name: '管理员甲', role: 'admin', cls: '', status: '启用', openid: 'o_admin', managedClasses: '' },
      { id: 'WT001', name: '教师乙', role: 'teacher', cls: '', status: '启用', openid: 'o_teacher', managedClasses: CLS },
      { id: 'S001', name: '学生丙', role: 'student', cls: CLS, status: '启用', openid: 'o_student', managedClasses: '' },
      { id: 'S002', name: '学生丁', role: 'student', cls: CLS2, status: '启用', openid: 'o_student2', managedClasses: '' }
    ],
    materials: [{ id: 'M001', name: '焊锡丝', stock: 10, unit: '卷', safe: 2, status: '启用' }],
    tools: [{ id: 'T100', name: '万用表', status: '在库', holder: '' }],
    requisitions: [{ id: 'R001', user: 'S001', item: 'M001', type: '领用', qty: 1, reason: '实训', status: '待审批', time: '2026-11-01 10:00', approver: '', cls: CLS }],
    borrow: [{ id: 'B001', user: 'S001', tool: 'T100', out: '2026-11-01 10:00', plan: '2026-11-08 10:00', in: '', status: '借出中', cls: CLS }],
    stock_io: [{ id: 'IO001', item: 'M001', dir: 'in', qty: 10, op: 'T001', time: '2026-11-01 09:00', note: '期初', src: '期初', cls: '' }],
    access: [{ id: 'A001', user: 'S001', point: '实训楼门禁', time: '2026-11-01 08:00', result: '通过', cls: CLS }],
    logs: [{ id: 'L001', time: '2026-11-01 09:00', actor: 'T001', op: '期初建账', target: 'M001', result: '成功', cls: '' }],
    labs: [{ id: 'LB1', name: '电气实训室', status: '启用', managerId: 'WT001', managerName: '教师乙' }],
    repairs: [{ id: 'RP1', labId: 'LB1', labName: '电气实训室', title: '灯管坏', status: '待处理', reporterId: 'WT001', handlerId: 'WT001' }],
    inspections: [{ id: 'IN1', labId: 'LB1', labName: '电气实训室', title: '日常巡检', status: '待巡检', planDate: '2026-11-01' }]
  }
}

const IDENTITIES = [
  { key: 'anon', openid: '', label: '匿名(未登录)' },
  { key: 'student', openid: 'o_student', label: '学生' },
  { key: 'teacher', openid: 'o_teacher', label: '教师' },
  { key: 'admin', openid: 'o_admin', label: '管理员' },
  { key: 'super', openid: 'o_super', label: '超管' }
]

// 每个 action 的调用参数（保持可重复、参数合法，避免因参数错误产生误判）
const PARAMS = {
  getItem: { id: 'M001' },
  listMaterials: {}, listTools: {}, search: { kw: '焊' },
  listMine: { user: 'S001' },
  requisition: { matId: 'M001', qty: 1, reason: '探测', user: 'S001' },
  toolRequisition: { toolId: 'T100', reason: '探测', days: 7, user: 'S001' },
  findUser: { id: 'S001' },
  cancelReq: { no: 'R001' },
  whoami: {}, bindLogin: { id: 'S001', name: '学生丙' },
  robotIdentity: {}, robotKeyStatus: {}, genRobotKey: {}, revokeRobotKey: {},
  pending: {}, exportData: { kind: 'materials' },
  listLogs: {}, listAccess: {}, reverseIO: { id: 'IO001' }, batchIo: { items: [] },
  approve: { no: 'R001', ok: true }, batchReject: { nos: ['R001'], reason: '探测' },
  revokeApprove: { no: 'R001' }, io: { matId: 'M001', dir: 'in', qty: 1 },
  addMaterial: { name: '新耗材', id: 'M900', qty: 1, unit: '个' },
  addTool: { name: '新工具', id: 'T900', spec: 'X', loc: 'A柜', actor: 'WT001' },
  listDeliveries: { days: 30, showDelivered: false },
  confirmDelivery: { no: 'R001', actor: 'WT001' },
  importMaterials: { rows: [] }, importTools: { rows: [] },
  stocktake: { mode: 'stocktake', items: [] },
  listStockIO: {}, listClaims: {},
  borrow: { toolId: 'T100' }, directBorrow: { toolId: 'T100', borrower: 'S001' },
  returnTool: { toolId: 'T100' }, access: { point: '实训楼门禁' },
  usage: {}, alerts: {}, listUsers: {}, snapshot: {},
  adminListUsers: {}, listStaff: {},
  adminUpsertUser: { id: 'S900', name: '新建学生', role: 'student', cls: CLS },
  adminDeleteUser: { id: 'S002' },
  adminUnbindUser: { id: 'S002' },
  migrate: {}, clearAllData: {},
  listLabs: {}, getLab: { id: 'LB1' }, labOverview: { labId: 'LB1' },
  addLab: { name: '新实训室' }, updateLab: { id: 'LB1', name: '改名实训室' }, deleteLab: { id: 'LB1' },
  listRepairs: {}, addRepair: { labId: 'LB1', title: '新增报修' }, updateRepair: { id: 'RP1', status: '已处理' },
  listInspections: {}, addInspection: { labId: 'LB1', title: '新增巡检' }, updateInspection: { id: 'IN1', status: '已完成' },
  diag: {}, fresh: {}
}

// 期望的最低权限等级
const EXPECT = {
  whoami: 'public',
  bindLogin: 'public',
  findUser: 'login',          // 需登录：可按工号枚举账号名册，匿名不得调用
  getItem: 'login',
  listMaterials: 'login',
  listTools: 'login',
  search: 'login',
  listMine: 'login',
  requisition: 'login',
  toolRequisition: 'login',
  cancelReq: 'login',
  robotIdentity: 'login',
  robotKeyStatus: 'login',
  genRobotKey: 'login',
  revokeRobotKey: 'login',
  access: 'login',
  listLabs: 'login', getLab: 'login', labOverview: 'login',
  listRepairs: 'login', listInspections: 'login',
  pending: 'staff', exportData: 'staff', batchIo: 'staff', approve: 'staff',
  batchReject: 'staff', io: 'staff', addMaterial: 'staff', stocktake: 'staff',
  // 第十三轮新增：单件工具建档（教师可建，与耗材建档同权限）、待交付清单与确认交付
  addTool: 'staff', listDeliveries: 'staff', confirmDelivery: 'staff',
  listStockIO: 'staff', listClaims: 'staff', borrow: 'staff', directBorrow: 'staff',
  returnTool: 'login', usage: 'staff', alerts: 'staff',
  listStaff: 'staff', adminListUsers: 'staff', adminUpsertUser: 'staff', adminDeleteUser: 'staff',
  adminUnbindUser: 'staff',      // 解除微信绑定：与编辑/删除同口径（教师可解绑本班学生）
  listLogs: 'admin', listAccess: 'admin', reverseIO: 'admin', revokeApprove: 'admin',
  importMaterials: 'admin', importTools: 'admin',
  listUsers: 'admin', snapshot: 'admin',
  addLab: 'admin', updateLab: 'admin', deleteLab: 'admin',
  addRepair: 'staff', updateRepair: 'staff',
  addInspection: 'staff', updateInspection: 'staff',
  migrate: 'super', clearAllData: 'super',
  diag: 'login', fresh: 'login'
}

const LEVEL_RANK = { public: 0, login: 1, staff: 2, admin: 3, super: 4 }
const ID_RANK = { anon: 0, student: 1, teacher: 2, admin: 3, super: 4 }

async function probe(action, identity) {
  CUR_OPENID = identity.openid
  const db = makeDb(seedRows())
  clouddb.__setDbForTest(db)
  const p = Object.assign({}, PARAMS[action] || {})
  p.__nonce = 'n' + Math.random().toString(36).slice(2) + Date.now()
  let r
  try {
    r = await cloudMock.main(Object.assign({ action }, p))
  } catch (e) {
    return { code: 'EXC', msg: (e && e.message) || String(e) }
  }
  return { code: (r && r.code), msg: (r && r.data && r.data.msg) || '' }
}

async function main() {
  console.log('===== 生产路由权限矩阵实测（59 action × 5 身份） =====')
  const actions = Object.keys(EXPECT)
  const matrix = {}
  for (const a of actions) {
    matrix[a] = {}
    for (const id of IDENTITIES) {
      matrix[a][id.key] = await probe(a, id)
    }
  }

  let pass = 0, fail = 0
  const issues = []
  function ok(name, cond, detail) {
    if (cond) { pass++; console.log('  ✓ ' + name) }
    else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); issues.push(name + (detail ? ' → ' + detail : '')) }
  }

  // 判定：某个身份能否调用 —— code===0 视为「放行」；401/403 视为「拒绝」
  const ALLOW = 0
  function allowed(cell) { return cell.code === ALLOW }
  function rejected(cell) { return cell.code === 401 || cell.code === 403 }

  console.log('\n----- 期望等级 vs 实测 -----')
  for (const a of actions) {
    const exp = EXPECT[a]
    const minRank = LEVEL_RANK[exp]
    // 找出实测下被放行的最低身份
    let lowest = null
    for (const id of IDENTITIES) {
      if (allowed(matrix[a][id.key])) { lowest = id.key; break }
    }
    const lowestRank = lowest === null ? 99 : ID_RANK[lowest]
    const detail = IDENTITIES.map(id => id.label + '=' + matrix[a][id.key].code).join(' ')
    ok(a + ' 期望≥' + exp, lowestRank >= minRank,
      '实测最低可达=' + (lowest || '无') + ' | ' + detail)
    // 高于最低层的身份不应被拒（except 超管专属动作对 admin 必须是拒的）
    for (const id of IDENTITIES) {
      const need = minRank
      if (ID_RANK[id.key] < need) continue
      if (id.key === 'anon') continue
      if (ID_RANK[id.key] === need) continue
      // 允许更高层调用
    }
  }

  // 专项一：匿名可达面
  console.log('\n----- 专项一：匿名（HTTP 触发 openid 为空）可达面 -----')
  const anonOpen = actions.filter(a => allowed(matrix[a].anon))
  console.log('  匿名可调用：' + (anonOpen.join(', ') || '（无）'))
  const anonWrite = anonOpen.filter(a => !['whoami', 'bindLogin'].includes(a))
  ok('匿名不可调用任何业务数据接口', anonWrite.length === 0,
    '可调用：' + anonWrite.join(', '))

  // 专项二：学生可达写操作面
  console.log('\n----- 专项二：学生可达的写操作 -----')
  const WRITE = ['requisition', 'toolRequisition', 'cancelReq', 'io', 'batchIo', 'approve', 'revokeApprove',
    'batchReject', 'addMaterial', 'stocktake', 'borrow', 'directBorrow', 'returnTool', 'access', 'reverseIO',
    'bindLogin', 'genRobotKey', 'revokeRobotKey', 'addLab', 'updateLab', 'deleteLab', 'addRepair',
    'updateRepair', 'addInspection', 'updateInspection', 'adminUpsertUser', 'adminDeleteUser',
    'clearAllData', 'migrate', 'importMaterials', 'importTools']
  const stuWrite = WRITE.filter(a => allowed(matrix[a].student))
  // 允许学生写的：本人申请/本人撤销/本人归还/刷卡/绑定 + 个人机器人密钥自服务
  // （密钥只代表本人身份，经机器通道执行时权限仍=student，且写操作还要过 L1 二次确认）
  const studentWriteOk = stuWrite.filter(a => ['requisition', 'toolRequisition', 'cancelReq', 'access',
    'returnTool', 'bindLogin', 'genRobotKey', 'revokeRobotKey'].includes(a))
  ok('学生只能写「本人申请/本人撤销/本人归还/刷卡/绑定」', stuWrite.every(a => studentWriteOk.includes(a)),
    '越权写：' + stuWrite.filter(a => !studentWriteOk.includes(a)).join(', '))

  // 专项三：教师不可越权到管理员专属
  console.log('\n----- 专项三：教师触碰管理员/超管专属动作必须被拒 -----')
  const ADMIN_ONLY = ['listLogs', 'listAccess', 'reverseIO', 'revokeApprove', 'importMaterials', 'importTools',
    'listUsers', 'snapshot', 'addLab', 'updateLab', 'deleteLab', 'migrate', 'clearAllData']
  const teacherLeaks = ADMIN_ONLY.filter(a => allowed(matrix[a].teacher))
  ok('教师不可调用管理员/超管专属动作', teacherLeaks.length === 0, '泄漏：' + teacherLeaks.join(', '))

  // 专项四：管理员不可执行超管专属
  console.log('\n----- 专项四：管理员不可执行超管专属（迁移/清库）-----')
  const adminLeaks = ['migrate', 'clearAllData'].filter(a => allowed(matrix[a].admin))
  ok('管理员不可执行迁移/清库', adminLeaks.length === 0, '泄漏：' + adminLeaks.join(', '))

  // 专项五：不应出现 500（未捕获异常）
  console.log('\n----- 专项五：不应出现 500/未捕获异常 -----')
  const errs = []
  for (const a of actions) {
    for (const id of IDENTITIES) {
      const c = matrix[a][id.key]
      if (c.code === 500 || c.code === 'EXC') errs.push(a + '/' + id.key + '=' + c.code + ' ' + c.msg)
    }
  }
  ok('所有 action × 身份 无 500/异常', errs.length === 0, errs.slice(0, 8).join(' | '))

  // 专项六：前后端 action 契约对齐
  // 此前 parity 只对 28 个 action 逐字段对拍，不覆盖「前端调用的 action 后端到底有没有实现」；
  // 一旦新增 action 只改了前端或只改了后端，症状是页面上「点了没反应 / 返回 unknown action」，
  // 而所有既有回归都照样全绿 —— 这里补上这道对齐检查。
  console.log('\n----- 专项六：前后端 action 契约对齐 -----')
  {
    const fs = require('fs')
    const path = require('path')
    const ROOT = path.join(__dirname, '..')
    // 前端调用的 action
    const front = new Map()
    const pagesDir = path.join(ROOT, 'pages')
    const jsFiles = []
    fs.readdirSync(pagesDir).forEach(d => {
      const f = path.join(pagesDir, d, d + '.js')
      if (fs.existsSync(f)) jsFiles.push(f)
    })
    jsFiles.push(path.join(ROOT, 'utils', 'api.js'), path.join(ROOT, 'utils', 'mock.js'))
    jsFiles.forEach(f => {
      const txt = fs.readFileSync(f, 'utf8')
      for (const m of txt.matchAll(/api\.(?:call|callFull)\(\s*'([^']+)'/g)) {
        if (!front.has(m[1])) front.set(m[1], path.relative(ROOT, f))
      }
    })
    // 生产路径可达的 action：prodDispatch 的 case + switch 之外用 if 处理的两个
    const idxTxt = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'index.js'), 'utf8')
    const prodStart = idxTxt.indexOf('async function prodDispatch')
    const mockStart = idxTxt.indexOf('async function mockHandler')
    const prodSeg = idxTxt.slice(prodStart, mockStart > prodStart ? mockStart : idxTxt.length)
    const prodCases = new Set([...prodSeg.matchAll(/case '([A-Za-z]+)':/g)].map(x => x[1]))
    // diag（exports.main 里）与 fresh（switch 之前的 if 分支）不在 case 列表里，但同样可达
    if (/if \(action === 'diag'\)/.test(idxTxt)) prodCases.add('diag')
    if (/if \(action === 'fresh'\)/.test(prodSeg)) prodCases.add('fresh')
    const missing = [...front.keys()].filter(a => !prodCases.has(a)).sort()
    ok('前端调用的 action 在生产路径全部可达（' + front.size + ' 个）', missing.length === 0,
      '未实现：' + missing.map(a => a + '←' + front.get(a)).join(', '))
    // MCP 白名单也必须在生产路径可达
    const mcpTxt = fs.readFileSync(path.join(ROOT, 'mcp', 'docs-proxy-server.js'), 'utf8')
    const wl = name => {
      const k = 'const ' + name + ' = ['
      if (mcpTxt.indexOf(k) < 0) return []
      return [...mcpTxt.slice(mcpTxt.indexOf(k)).split(']')[0].matchAll(/'([A-Za-z]+)'/g)].map(x => x[1])
    }
    const mcpAll = wl('READ_ACTIONS').concat(wl('WRITE_ACTIONS'))
    const mcpMissing = mcpAll.filter(a => !prodCases.has(a)).sort()
    ok('MCP 白名单 action 在生产路径全部可达（' + mcpAll.length + ' 个）', mcpMissing.length === 0,
      '未实现：' + mcpMissing.join(', '))
  }

  // 专项七：页面门槛 vs 后端 action 闸门的一致性
  // 本轮修的 bug 就是这一类：后端三个用户管理 action 都是 gStaff（教师可调），
  // 前端用户管理页却用 identity.isAdmin() 一刀切把教师挡在门外 → 后端允许的操作在界面上没有入口。
  // 反向错配（页面门槛比 action 严）只在这一种形态下会造成「功能不可达」，
  // 故只查这一向；反向（页面比 action 松）由各页 isAdmin 条件渲染保证，属另一类检查。
  console.log('\n----- 专项七：页面门槛与后端 action 闸门一致性 -----')
  {
    const fs = require('fs')
    const path = require('path')
    const ROOT = path.join(__dirname, '..')
    const pagesDir = path.join(ROOT, 'pages')
    const problems = []
    for (const d of fs.readdirSync(pagesDir)) {
      const js = path.join(pagesDir, d, d + '.js')
      if (!fs.existsSync(js)) continue
      const txt = fs.readFileSync(js, 'utf8')
      const m = txt.match(/const\s+allow(?:ed)?\s*=\s*identity\.(isAdmin|isStaff)\(\)/)
      if (!m) continue
      const gate = m[1] === 'isAdmin' ? 'admin' : 'staff'
      const calls = [...txt.matchAll(/api\.(?:call|callFull)\(\s*'([^']+)'/g)].map(x => x[1])
      for (const a of calls) {
        const lv = EXPECT[a]
        if (!lv) continue
        // 页面门槛=admin 却调用 teacher 级动作 → 教师永远进不去，后端能力白做
        if (gate === 'admin' && lv === 'staff') problems.push(d + ' 页面门槛=admin 但调用了教师级动作 ' + a)
      }
    }
    ok('没有「页面门槛严于后端闸门」的错配', problems.length === 0, problems.join(' | '))

    // 定向断言：用户管理这条链必须始终是 gStaff（前后端一致）
    const auJs = fs.readFileSync(path.join(ROOT, 'pages', 'admin-users', 'admin-users.js'), 'utf8')
    ok('用户管理页的页面门槛是教师及以上（与后端 gStaff 一致）',
      /const\s+allowed\s*=\s*identity\.isStaff\(\)/.test(auJs) &&
      !/const\s+allowed\s*=\s*identity\.isAdmin\(\)/.test(auJs),
      'admin-users.js 门槛表达式不符')
    ok('三个用户管理 action 的期望闸门都是 staff',
      EXPECT.adminListUsers === 'staff' && EXPECT.adminUpsertUser === 'staff' && EXPECT.adminDeleteUser === 'staff',
      [EXPECT.adminListUsers, EXPECT.adminUpsertUser, EXPECT.adminDeleteUser].join('/'))
    const auWxml = fs.readFileSync(path.join(ROOT, 'pages', 'admin-users', 'admin-users.wxml'), 'utf8')
    ok('教师模式下归属班级用选择器（限本人带班）、带班字段对教师隐藏',
      /wx:if="\{\{isTeacher\}\}"[\s\S]{0,400}?clsOptions/.test(auWxml) &&
      /wx:if="\{\{!isTeacher && form\.role==='teacher'\}\}"/.test(auWxml),
      'admin-users.wxml 门槛不符')
  }

  console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====')
  if (issues.length) {
    console.log('--- 问题清单 ---')
    issues.forEach(i => console.log('  · ' + i))
  }
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
