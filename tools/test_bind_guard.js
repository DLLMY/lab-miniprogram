// tools/test_bind_guard.js
// 工号 ↔ 微信 openid 绑定不变量回归。
//
// 背景（2026-11-17）：用户确认「一个工号被 openid 绑定后，其他账号不可再绑定」这条限制即可接受。
//   该限制此前【没有任何测试守护】，且实测发现两个真缺陷：
//     ① 物理删除已绑定账号 → openid 随行消失 → 同工号重建后变成「未绑定」→
//        任何人都能抢绑该工号（限制被绕过）。
//     ② bindLogin 的 409 提示「请联系管理员清空该工号的绑定」，但管理员根本没有清空绑定的入口
//        → 换绑是死路。
//   已修：删除已绑定账号被 409 拒绝 + 新增 adminUnbindUser（管理员可解绑，解绑后可重新绑定）。
//
// 全部用例走真实 prodDispatch 链路（打桩 wx-server-sdk + 内存伪云库），
// 直接调适配器不带请求上下文 → ds.currentScope() 为空 → 隔离闸门不生效（不是生产路径）。
const path = require('path')
const Module = require('module')

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
process.env.DATA_BACKEND = 'cloud'
process.env.USE_MOCK = 'false'
process.env.FALLBACK = 'off'

const ROOT = path.join(__dirname, '..')
const clouddb = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'clouddb.js'))
const cloudMock = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'index.js'))

let pass = 0
let fail = 0
const issues = []
function ok(title, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + title) }
  else { fail++; issues.push(title + (extra ? ' → ' + extra : '')); console.log('  ✗ ' + title + (extra ? ' → ' + extra : '')) }
}
function section(t) { console.log('\n===== ' + t + ' =====') }

// ---------- 内存伪云库（与 test_action_matrix 同款最小实现）----------
// 伪云库：统一用 tools/fake_cloud_db.js（支持 where().update() 条件更新 → 可验证 CAS 跨实例并发安全）
const { makeDb } = require('./fake_cloud_db.js')
const CLS = '2024级电气1班'
const CLS2 = '2024级电气2班'

const SEED = () => ({
  users: [
    { id: 'T001', name: '邓老师', role: 'super', cls: '', status: '启用', openid: 'o_super', managedClasses: '' },
    { id: 'A001', name: '管理员甲', role: 'admin', cls: '', status: '启用', openid: 'o_admin', managedClasses: '' },
    { id: 'WT001', name: '教师乙', role: 'teacher', cls: '', status: '启用', openid: '', managedClasses: CLS },
    { id: 'WT002', name: '教师丙', role: 'teacher', cls: '', status: '启用', openid: 'o_B', managedClasses: CLS2 },
    { id: 'S001', name: '学生丁', role: 'student', cls: CLS, status: '启用', openid: '', managedClasses: '' },
    { id: 'S002', name: '学生戊', role: 'student', cls: CLS2, status: '启用', openid: '', managedClasses: '' },
    { id: 'S003', name: '学生己', role: 'student', cls: CLS, status: '停用', openid: '', managedClasses: '' }
  ],
  materials: [], tools: [], requisitions: [], borrow: [], stock_io: [],
  access: [], logs: [], labs: [], repairs: [], inspections: []
})

const db = makeDb(SEED())
clouddb.__setDbForTest(db)
const main = (evt) => cloudMock.main(evt)
const row = (id) => db.store.users.find(u => u.id === id)
const code = (r) => (r && r.code)
const msg = (r) => ((r && r.data && r.data.msg) || '')

;(async () => {
  section('① 核心限制：一个工号被绑定后，其他微信不可再绑')
  CUR_OPENID = 'o_A'
  let r = await main({ action: 'bindLogin', id: 'WT001', name: '教师乙' })
  ok('未绑定的工号首次绑定成功', code(r) === 0, JSON.stringify(r))
  ok('绑定关系写入该工号行', row('WT001').openid === 'o_A', row('WT001').openid)

  CUR_OPENID = 'o_B'
  r = await main({ action: 'bindLogin', id: 'WT001', name: '教师乙' })
  ok('另一微信绑同一工号被拒（409）', code(r) === 409, JSON.stringify(r))
  ok('拒绝后绑定关系未被覆盖', row('WT001').openid === 'o_A', row('WT001').openid)
  ok('拒绝提示说明了处理路径（请联系管理员清空绑定）', /清空/.test(msg(r)), msg(r))

  CUR_OPENID = 'o_A'
  r = await main({ action: 'bindLogin', id: 'WT001', name: '教师乙' })
  ok('同一微信重复绑定为幂等登录（放行）', code(r) === 0, JSON.stringify(r))

  section('② 一个微信只能绑定一个工号')
  CUR_OPENID = 'o_A'
  r = await main({ action: 'bindLogin', id: 'S001', name: '学生丁' })
  ok('已绑工号的微信再绑别的工号被拒（409）', code(r) === 409, JSON.stringify(r))
  ok('被拒后目标工号仍为未绑定', !row('S001').openid, JSON.stringify(row('S001').openid))

  section('③ 身份核对与启用状态')
  CUR_OPENID = 'o_C'
  r = await main({ action: 'bindLogin', id: 'S001', name: '张三' })
  ok('姓名与工号不匹配被拒（400）', code(r) === 400, JSON.stringify(r))
  r = await main({ action: 'bindLogin', id: 'S003', name: '学生己' })
  ok('已停用账号不能绑定（400）', code(r) === 400, JSON.stringify(r))
  r = await main({ action: 'bindLogin', id: 'NOPE', name: '查无此人' })
  ok('工号不存在被拒（404）', code(r) === 404, JSON.stringify(r))

  section('④ 停用保留绑定（停用≠解绑）')
  CUR_OPENID = 'o_super'
  r = await main({ action: 'adminUpsertUser', id: 'WT001', name: '教师乙', role: 'teacher', cls: '', managedClasses: CLS, status: '停用', rid: row('WT001')._id })
  ok('管理员停用账号成功', code(r) === 0, JSON.stringify(r))
  ok('停用后 openid 仍保留（防止工号被顶替抢绑）', row('WT001').openid === 'o_A', row('WT001').openid)
  CUR_OPENID = 'o_B'
  r = await main({ action: 'bindLogin', id: 'WT001', name: '教师乙' })
  ok('停用账号也不能被他人绑定', code(r) === 409 || code(r) === 400, JSON.stringify(r))
  // 恢复启用
  CUR_OPENID = 'o_super'
  await main({ action: 'adminUpsertUser', id: 'WT001', name: '教师乙', role: 'teacher', cls: '', managedClasses: CLS, status: '启用', rid: row('WT001')._id })

  section('⑤ 删除已绑定账号被拒（堵住「删除→重建→无保护」绕过）')
  CUR_OPENID = 'o_super'
  r = await main({ action: 'adminDeleteUser', id: 'WT001' })
  ok('删除已绑定微信的账号被拒（409）', code(r) === 409, JSON.stringify(r))
  ok('账号行仍在（未被删除）', !!row('WT001'))
  ok('拒绝提示引导改用停用或先解绑', /停用|解绑/.test(msg(r)), msg(r))
  // 未绑定的账号仍可删除（错录脏账号要能清）
  r = await main({ action: 'adminDeleteUser', id: 'S001' })
  ok('未绑定微信的账号仍可删除', code(r) === 0, JSON.stringify(r))
  ok('该行确实被删除', !row('S001'))

  section('⑥ 管理员解绑：换绑的正规出路')
  CUR_OPENID = 'o_super'
  r = await main({ action: 'adminUnbindUser', id: 'WT001' })
  ok('解绑成功', code(r) === 0, JSON.stringify(r))
  ok('openid 已清空', !row('WT001').openid, JSON.stringify(row('WT001').openid))
  const logs = db.store.logs.filter(l => l.op === '解除微信绑定')
  ok('解绑留下日志留痕', logs.length === 1, 'logs=' + logs.length)
  r = await main({ action: 'adminUnbindUser', id: 'WT001' })
  ok('对未绑定账号解绑被拒（400）', code(r) === 400, JSON.stringify(r))
  // 解绑后该工号可被重新绑定
  CUR_OPENID = 'o_D'
  r = await main({ action: 'bindLogin', id: 'WT001', name: '教师乙' })
  ok('解绑后该工号可以被重新绑定（新的微信可接管）', code(r) === 0, JSON.stringify(r))
  ok('新绑定关系已生效', row('WT001').openid === 'o_D', row('WT001').openid)

  section('⑦ 解绑的层级与数据域约束（与删除/编辑同口径）')
  // 准备一个教师身份：先把 WT001 的绑定解开，再用 o_teacher 这个微信绑定它
  CUR_OPENID = 'o_super'
  await main({ action: 'adminUnbindUser', id: 'WT001' })
  CUR_OPENID = 'o_teacher'
  r = await main({ action: 'bindLogin', id: 'WT001', name: '教师乙' })
  ok('教师身份就位（WT001 绑到 o_teacher）', code(r) === 0, JSON.stringify(r))
  // WT002 是另一个班的教师账号
  r = await main({ action: 'adminUnbindUser', id: 'WT002' })
  ok('教师不能解绑教师账号（403，层级裁决）', code(r) === 403, JSON.stringify(r))
  r = await main({ action: 'adminUnbindUser', id: 'S002' })
  ok('教师不能解绑别班学生（403，数据域裁决）', code(r) === 403, JSON.stringify(r))
  // 本班学生：先让其被绑定，再由教师解绑
  CUR_OPENID = 'o_super'
  await main({ action: 'adminUpsertUser', id: 'S001', name: '学生丁', role: 'student', cls: CLS, status: '启用', rid: row('S001') ? row('S001')._id : '' })
  CUR_OPENID = 'o_F'
  await main({ action: 'bindLogin', id: 'S001', name: '学生丁' })
  ok('本班学生已被绑定', row('S001').openid === 'o_F', JSON.stringify(row('S001').openid))
  CUR_OPENID = 'o_teacher'
  r = await main({ action: 'adminUnbindUser', id: 'S001' })
  ok('教师可以解绑本班学生（与编辑/删除同口径）', code(r) === 0, JSON.stringify(r))
  ok('解绑后本班学生的 openid 已清空', !row('S001').openid, JSON.stringify(row('S001').openid))

  section('⑧ 管理员改工号：绑定关系随行保留')
  CUR_OPENID = 'o_super'
  r = await main({ action: 'adminUpsertUser', id: 'WT009', name: '教师丙', role: 'teacher', cls: '', managedClasses: CLS2, status: '启用', rid: row('WT002')._id })
  ok('改工号成功', code(r) === 0, JSON.stringify(r))
  ok('openid 随行保留（不是新账号）', row('WT009').openid === 'o_B', row('WT009').openid)
  CUR_OPENID = 'o_E'
  r = await main({ action: 'bindLogin', id: 'WT009', name: '教师丙' })
  ok('改后的新工号同样受绑定保护（他人绑不上）', code(r) === 409, JSON.stringify(r))

  section('⑨ 绑定保护不可被普通写操作绕过')
  CUR_OPENID = 'o_admin'
  const before = row('WT009').openid
  r = await main({ action: 'adminUpsertUser', id: 'WT009', name: '教师丙', role: 'teacher', cls: '', managedClasses: CLS2, status: '启用', rid: row('WT009')._id })
  ok('管理员改资料不会清掉绑定', code(r) === 0 && row('WT009').openid === before, JSON.stringify(row('WT009').openid))

  console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====')
  if (issues.length) {
    console.log('\n问题清单：')
    issues.forEach(i => console.log('  · ' + i))
  }
  process.exit(fail ? 1 : 0)
})()
