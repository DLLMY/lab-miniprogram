// tools/test-role-gate.js
// 用 Node 桩模拟小程序运行时，验证「教师/管理员能过权限闸」的三种历史坏场景。
// 只测纯逻辑，不触碰腾讯文档。
const path = require('path')

function makeRuntime(storage) {
  const store = Object.assign({}, storage)
  const app = {
    globalData: {
      DEMO: true,
      role: 'student',
      me: { id: '', name: '', role: 'student' },
      identity: null
    }
  }
  global.wx = {
    getStorageSync: k => (store[k] === undefined ? '' : store[k]),
    setStorageSync: (k, v) => { store[k] = v },
    removeStorageSync: k => { delete store[k] },
    showToast: () => {},
    reLaunch: () => {}
  }
  global.getApp = () => app
  // 清掉 require 缓存，让 mock/identity 重新按该 storage 初始化
  Object.keys(require.cache)
    .filter(k => k.includes('utils' + path.sep + 'mock.js') || k.includes('utils' + path.sep + 'identity.js'))
    .forEach(k => delete require.cache[k])
  const identity = require('../utils/identity.js')
  return { identity, app, store }
}

function gate(identity) {
  // 与 approve/io/usage 页面完全一致的判定
  identity.syncGlobal()
  return identity.isStaff()
}

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? ' → ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' → ' + detail : '')) }
}

// mock 用户表：seed.users 已按上线安全要求清空（不随包分发真实工号+姓名），
// 本地演示账号改由 lab_mock 显式提供——生产走云端 users 表，见 mock.js 顶部注释。
function mockDb() {
  return {
    users: [
      { id: 'S001', name: '张三', role: 'student', cls: '24电气1' },
      { id: 'T001', name: '邓老师', role: 'teacher', cls: '' },
      { id: 'A001', name: '王管理员', role: 'admin', cls: '' }
    ],
    materials: [], tools: [], requisitions: [], borrow: [], stock_io: [], access: [], logs: []
  }
}

// 场景 1：lab_mock 提供教师账号，登录成功且能过闸
console.log('\n场景 1：lab_mock 提供教师账号 T001')
async function s1() {
  const { identity, app, store } = makeRuntime({ lab_mock: mockDb() })
  const u = await identity.login('T001')
  check('登录成功', !!u, u && u.id + '/' + u.role)
  check('globalData.role=teacher', app.globalData.role === 'teacher', 'role=' + app.globalData.role)
  check('教师能过闸', gate(identity) === true)
  check('storage 已写入身份', !!store['lab_identity'], JSON.stringify(store['lab_identity']))
}

// 场景 2：lab_mock 里角色写法不规范（'Teacher'）—— normalizeRole 归一为 teacher 后放行
// （旧场景「种子自动校正」已随 seed.users 清空废止：mock 不再内置账号、不再静默改写用户表，
//  脏写法容忍由 identity.normalizeRole 负责）
console.log('\n场景 2：lab_mock 角色写法不规范（Teacher）')
async function s2() {
  const db = mockDb()
  db.users = db.users.map(u => u.id === 'T001' ? Object.assign({}, u, { role: 'Teacher' }) : u)
  const { identity, app } = makeRuntime({ lab_mock: db })
  const u = await identity.login('T001')
  check('登录后角色被归一化', u && u.role === 'teacher', u && u.role)
  check('globalData.role=teacher', app.globalData.role === 'teacher', 'role=' + app.globalData.role)
  check('教师能过闸', gate(identity) === true)
}

// 场景 3：已登录但 storage 里角色写法不规范（'Teacher'），且 globalData 还是旧的 student
console.log('\n场景 3：已登录身份 role=\'Teacher\'（写法不规范）+ globalData 残留 student')
function s3() {
  const { identity, app, store } = makeRuntime({
    lab_identity: { id: 'T001', name: '邓老师', role: 'Teacher' }
  })
  app.globalData.role = 'student' // 模拟冷启动/切号后的旧值
  check('过闸不受 globalData 旧值影响', gate(identity) === true)
  check('storage 角色被归一化', store['lab_identity'].role === 'teacher', store['lab_identity'].role)
  check('globalData 已对齐', app.globalData.role === 'teacher', app.globalData.role)
}

// 场景 4：学生账号仍应被拦（不能因为修权限把闸门放开）
console.log('\n场景 4：学生 S001 必须被拦')
async function s4() {
  const { identity, app } = makeRuntime({})
  await identity.login('S001')
  check('学生被拦', gate(identity) === false, 'role=' + app.globalData.role)
}

// 场景 5：未登录必须被拦
console.log('\n场景 5：未登录必须被拦')
function s5() {
  const { identity } = makeRuntime({})
  check('未登录被拦', gate(identity) === false)
}

// 场景 6：超级管理员角色归一化与权限判定
console.log('\n场景 6：超级管理员 identity 判定')
function s6() {
  const { identity } = makeRuntime({ lab_identity: { id: 'T001', name: '邓老师', role: '超级管理员' } })
  check('normalizeRole 容错「超级管理员」→ super', identity.normalizeRole('超级管理员') === 'super')
  check('isAdmin 对 super 为真', identity.isAdmin() === true)
  check('isSuper 对 super 为真', identity.isSuper() === true)
  check('roleText(super)=超级管理员', identity.roleText('super') === '超级管理员')
}

// 场景 7：管理员 isAdmin 真、isSuper 假；学生两者皆假
console.log('\n场景 7：管理员 vs 学生 的判定边界')
function s7() {
  const admin = makeRuntime({ lab_identity: { id: 'A001', name: '王管理员', role: 'admin' } })
  check('管理员 isAdmin 真', admin.identity.isAdmin() === true)
  check('管理员 isSuper 假', admin.identity.isSuper() === false)
  const stu = makeRuntime({ lab_identity: { id: 'S001', name: '张三', role: 'student' } })
  check('学生 isAdmin 假', stu.identity.isAdmin() === false)
  check('学生 isSuper 假', stu.identity.isSuper() === false)
}

;(async () => {
  await s1(); await s2(); s3(); await s4(); s5(); s6(); s7()
  console.log('\n结果：pass=' + pass + ' fail=' + fail)
  process.exit(fail ? 1 : 0)
})()
