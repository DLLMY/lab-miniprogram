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

// 场景 1：干净环境，直接登录 T001
console.log('\n场景 1：干净存储直接登录教师 T001')
async function s1() {
  const { identity, app, store } = makeRuntime({})
  const u = await identity.login('T001')
  check('登录成功', !!u, u && u.id + '/' + u.role)
  check('globalData.role=teacher', app.globalData.role === 'teacher', 'role=' + app.globalData.role)
  check('教师能过闸', gate(identity) === true)
  check('storage 已写入身份', !!store['lab_identity'], JSON.stringify(store['lab_identity']))
}

// 场景 2：旧版 lab_mock 把 T001 存成了学生（本次报障最可能的原因）
console.log('\n场景 2：旧缓存 lab_mock 里 T001 的 role 是 student（脏种子）')
async function s2() {
  const staleMock = {
    users: [
      { id: 'S001', name: '张三', role: 'student', cls: '24电气1' },
      { id: 'T001', name: '邓老师', role: 'student', cls: '' }
    ],
    materials: [], tools: [], requisitions: [], borrow: [], stock_io: [], access: [], logs: []
  }
  const { identity, app } = makeRuntime({ lab_mock: staleMock })
  const u = await identity.login('T001')
  check('登录后角色被校正', u && u.role === 'teacher', u && u.role)
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

;(async () => {
  await s1(); await s2(); s3(); await s4(); s5()
  console.log('\n结果：pass=' + pass + ' fail=' + fail)
  process.exit(fail ? 1 : 0)
})()
