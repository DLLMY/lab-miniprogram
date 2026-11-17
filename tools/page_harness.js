// tools/test_page_flows.js —— 端到端页面流程测试（真实页面 JS × 真实后端适配器 × 真实数据）
//
// 为什么需要：
//   此前 13 个套件全部停在**接口层**（适配器、路由、契约、账实、样式），
//   从来没有测试真正**驱动过页面 JS 的逻辑**——onLoad 拉数、筛选、分页去重、
//   弹层开关、二次确认、参数拼装、setData 后的渲染字段，一个都没验证过。
//   于是这类缺陷会一路绿灯：
//     · 页面把 data.user 传给 listMine（后端按 me.id 覆盖）→ 永远查不到别人的单；
//     · 审批二次确认被绕过 → 一点就直接写库；
//     · 翻页不去重 → 同一行出现两次；
//     · 弹层字段名写错 → 提交时参数缺失，后端 400 而页面只显示「操作失败」。
//
// 本工具怎么跑：
//   1) 打桩 wx（含 getWXContext 返回当前被测身份 openid）+ getApp；
//   2) 起一个**内存伪云库**，注入真实形状的种子数据；
//   3) 用 Module._load 钩子把 utils/api.js 换成转发器：页面调 api.call('X') →
//      直接打到真实云函数 exports.main({action:'X'}) → 真实 prodDispatch + 真实适配器；
//   4) 捕获全局 Page 对象，构造带 setData（支持 'a.b' 路径）的实例；
//   5) 逐页驱动 onLoad/onShow 与关键交互，断言「页面状态」+「库里的真实变化」。
//
// 用法：node tools/test_page_flows.js
const path = require('path')
const fs = require('fs')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
// ⚠ 必须在 cloudfunctions/docsProxy/index.js 被首次 require 之前设置：
//   index.js 在模块加载期就解析 ENV 并固化回退链，事后改 process.env 无效。
//   目标：主后端 = 云库（cloud）、关闭回退（off）→ 所有请求都走真 prodDispatch。
process.env.DATA_BACKEND = 'cloud'
process.env.USE_MOCK = 'false'
process.env.FALLBACK = 'off'
const CLS = '24电气1'
const CLS2 = '24电气2'

let pass = 0, fail = 0
const issues = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); issues.push(name + (detail ? ' → ' + detail : '')) }
}
function section(t) { console.log('\n===== ' + t + ' =====') }

// ============================================================
// ① wx 打桩
// ============================================================
const wxCalls = []
let CURRENT_OPENID = ''
const wxStub = {
  getWXContext: () => ({ OPENID: CURRENT_OPENID }),
  showToast: (o) => { wxCalls.push(['toast', o && o.title]); o && o.success && o.success() },
  showModal: (o) => {
    wxCalls.push(['modal', o && o.title])
    const conf = o && o.__confirm
    o && o.success && o.success({ confirm: conf !== false, cancel: false })
  },
  showLoading: () => {}, hideLoading: () => {},
  showActionSheet: (o) => { o && o.success && o.success({ tapIndex: 0 }) },
  setStorageSync: (k, v) => { wxStub._store[k] = v },
  getStorageSync: (k) => wxStub._store[k] === undefined ? '' : wxStub._store[k],
  removeStorageSync: (k) => { delete wxStub._store[k] },
  setClipboardData: (o) => { wxCalls.push(['clipboard', o && o.data && String(o.data).slice(0, 20)]); o && o.success && o.success() },
  navigateTo: (o) => { wxCalls.push(['navigateTo', o && o.url]); o && o.success && o.success() },
  redirectTo: (o) => { wxCalls.push(['redirectTo', o && o.url]); o && o.success && o.success() },
  switchTab: (o) => { wxCalls.push(['switchTab', o && o.url]); o && o.success && o.success() },
  reLaunch: (o) => { wxCalls.push(['reLaunch', o && o.url]); o && o.success && o.success() },
  navigateBack: (o) => { wxCalls.push(['navigateBack', '']); o && o.success && o.success() },
  stopPullDownRefresh: () => {},
  nextTick: (fn) => { fn && fn() },
  createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => ({ exec: (cb) => cb && cb([{ width: 100, height: 40, top: 0, left: 0 }]) }) }), exec: (cb) => cb && cb([]) }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, safeArea: { top: 20, bottom: 640, left: 0, right: 375 } }),
  getFileSystemManager: () => ({ writeFile: (o) => { o && o.success && o.success() }, readFile: (o) => { o && o.success && o.success({ data: '' }) } }),
  canvasToTempFilePath: (o) => { o && o.success && o.success({ tempFilePath: '/tmp/x.png' }) },
  getImageInfo: (o) => { o && o.success && o.success({ width: 100, height: 100 }) },
  previewImage: (o) => { o && o.success && o.success() },
  saveImageToPhotosAlbum: (o) => { o && o.success && o.success() },
  previewMedia: (o) => { o && o.success && o.success() },
  scanCode: (o) => { wxCalls.push(['scanCode', '']); o && o.success && o.success({ result: (o && o.__result) || 'ITEM:T999' }) },
  canIUse: () => true,
  setKeepScreenOn: () => {},
  vibrateShort: () => {},
  getLocation: (o) => { o && o.success && o.success({ latitude: 30, longitude: 108 }) },
  chooseMedia: (o) => { o && o.fail && o.fail({ errMsg: 'cancel' }) },
  env: { USER_DATA_PATH: '/tmp' },
  _store: {}
}
const appStub = {
  globalData: { env: '', identity: null, role: 'student', me: { id: '', name: '', role: 'student' }, dataSource: 'cloud', dataBackend: 'cloud' },
  getSystemInfo: () => ({ windowWidth: 375, windowHeight: 667 })
}

// ============================================================
// ② 内存伪云库（与 test_consistency.js 同构）
// ============================================================
// 伪云库：统一用 tools/fake_cloud_db.js（支持 where().update() 条件更新 → 可验证 CAS 跨实例并发安全）
const { makeDb } = require('./fake_cloud_db.js')
function seedRows() {
  return {
    users: [
      { id: 'T001', name: '邓老师', role: 'super', cls: '', status: '启用', openid: 'o_super', managedClasses: '' },
      { id: 'A001', name: '管理员甲', role: 'admin', cls: '', status: '启用', openid: 'o_admin', managedClasses: '' },
      { id: 'WT001', name: '教师乙', role: 'teacher', cls: '', status: '启用', openid: 'o_teacher', managedClasses: CLS },
      { id: 'S001', name: '学生丙', role: 'student', cls: CLS, status: '启用', openid: 'o_student', managedClasses: '' },
      { id: 'S002', name: '学生丁', role: 'student', cls: CLS2, status: '启用', openid: 'o_student2', managedClasses: '' }
    ],
    materials: [
      { id: 'M001', name: '焊锡丝', spec: '0.8mm', cat: '耗材', loc: 'A柜3层', stock: 10, unit: '卷', safe: 2, status: '正常', expire: '' },
      { id: 'M002', name: '钢料', spec: 'Q235', cat: '钢料', loc: '精工楼509', stock: 2352, unit: '块', safe: 500, status: '正常', expire: '' }
    ],
    tools: [{ id: 'T100', name: '万用表', spec: 'VC830L', loc: 'A柜1层', status: '在库', holder: '' }],
    requisitions: [
      { id: 'R001', user: 'S001', item: 'M001', type: '领用', qty: 2, reason: '实训需要', status: '待审批', time: '2026-11-01 10:00', approver: '', cls: CLS },
      { id: 'T001', user: 'S001', item: 'T100', type: '借出', qty: 1, reason: '比赛借用', status: '待审批', time: '2026-11-01 11:00', approver: '', days: 7, cls: CLS }
    ],
    borrow: [],
    stock_io: [{ id: 'IO001', item: 'M001', dir: '入库', qty: 10, op: 'T001', time: '2026-11-01 09:00', note: '期初', src: '建档入库', cls: '' }],
    access: [],
    logs: [],
    labs: [{ id: 'L001', name: '电气实训室', campus: '主校区', building: '精工楼', floor: '5', roomNo: '509', status: '启用', managerId: 'WT001', managerName: '教师乙', createdAt: '2026-11-01 08:00', updatedAt: '2026-11-01 08:00' }],
    repairs: [{ id: 'RP1', labId: 'L001', labName: '电气实训室', title: '灯管坏', category: '设备故障', desc: '', reporterId: 'WT001', reporterName: '教师乙', status: '待处理', priority: '一般', handlerId: 'WT001', handlerName: '教师乙', createdAt: '2026-11-01 08:00', updatedAt: '2026-11-01 08:00', cls: '' }],
    inspections: [{ id: 'IN1', labId: 'L001', labName: '电气实训室', title: '日常巡检', planDate: '2026-11-20', executorId: 'WT001', executorName: '教师乙', status: '待巡检', result: '', createdAt: '2026-11-01 08:00', doneAt: '' }]
  }
}

// ============================================================
// ③ api 转发器：页面 → 真实云函数 exports.main
// ============================================================
const apiCalls = []
let cloudMain = null
const apiStub = {
  call(action, data = {}) {
    apiCalls.push({ action, data, mode: 'call' })
    return cloudMain(Object.assign({ action }, data)).then(r => (r && r.code === 0 ? r.data : null))
  },
  callFull(action, data = {}, opts) {
    apiCalls.push({ action, data, mode: 'callFull', noFallback: !!(opts && opts.noFallback) })
    return cloudMain(Object.assign({ action }, data)).then(r => r)
  },
  isDemoData: () => false,
  warnIfDemo: () => {},
  // 与真实 utils/api.js 同一实现（utils/idem.js 纯函数，不依赖 wx）
  idemWarn: require(path.join(ROOT, 'utils', 'idem.js')).idemWarn,
  backendLabel: (b) => b,
  demoNotice: () => {}
}

// ============================================================
// ④ 模块加载钩子：替换 api，其余全部用真实实现
// ============================================================
const _origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') {
    return {
      init: function () {}, database: function () { return {} }, command: {},
      getWXContext: () => ({ OPENID: CURRENT_OPENID })
    }
  }
  // 精确替换 utils/api.js：页面用 '../../utils/api.js'，utils 内模块（staff/identity）用 './api.js'
  // —— 只按路径后缀匹配会漏掉后者，导致 staff.js 仍拿真实 api → 云端不可用时回退 mock，候选名单为空。
  try {
    const resolved = Module._resolveFilename(request, parent, isMain)
    if (resolved === path.join(ROOT, 'utils', 'api.js')) return apiStub
  } catch (e) { /* 解析失败则按原样加载 */ }
  return _origLoad.apply(this, arguments)
}

global.wx = wxStub
global.getApp = () => appStub
global.Page = null
global.App = () => {}

// ============================================================
// ⑤ 页面加载与实例化
// ============================================================
function loadPageDef(page) {
  const file = path.join(ROOT, 'pages', page, page + '.js')
  let def = null
  global.Page = (o) => { def = o }
  delete require.cache[require.resolve(file)]
  require(file)
  global.Page = null
  if (!def) throw new Error('页面未调用 Page(): ' + page)
  return def
}

function makeInstance(def) {
  const inst = Object.assign({}, def)
  inst.data = JSON.parse(JSON.stringify(def.data || {}))
  inst.setData = function (patch, cb) {
    for (const k in patch) {
      const v = patch[k]
      if (k.indexOf('.') >= 0) {
        const parts = k.split('.')
        let o = inst.data
        for (let i = 0; i < parts.length - 1; i++) {
          if (o[parts[i]] === undefined || o[parts[i]] === null) o[parts[i]] = {}
          o = o[parts[i]]
        }
        o[parts[parts.length - 1]] = v
      } else {
        inst.data[k] = v
      }
    }
    if (cb) cb()
  }
  return inst
}

// 页面里大量 onLoad → this.load()（不 await），用若干个宏任务 tick 冲刷
async function flush(times = 6) {
  for (let i = 0; i < times; i++) await new Promise(r => setTimeout(r, 0))
}

function loginAs(role) {
  const map = {
    super: { id: 'T001', name: '邓老师', role: 'super' },
    admin: { id: 'A001', name: '管理员甲', role: 'admin' },
    teacher: { id: 'WT001', name: '教师乙', role: 'teacher', cls: '', managedClasses: CLS },
    student: { id: 'S001', name: '学生丙', role: 'student' }
  }
  const u = map[role]
  wxStub._store.lab_identity = u
  appStub.globalData.identity = u
  appStub.globalData.role = u.role
  appStub.globalData.me = u
  CURRENT_OPENID = { super: 'o_super', admin: 'o_admin', teacher: 'o_teacher', student: 'o_student' }[role]
  return u
}

async function boot(role) {
  loginAs(role)
  apiCalls.length = 0
  wxCalls.length = 0
  const clouddb = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'clouddb.js'))
  clouddb.__setDbForTest(makeDb(seedRows()))
  cloudMock = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'index.js'))
  cloudMain = (evt) => cloudMock.main(evt)
  return clouddb
}

let cloudMock = null

module.exports = {
  ok, section, loadPageDef, makeInstance, flush, loginAs, boot,
  apiCalls, wxCalls, wxStub, appStub, seedRows, makeDb, CLS, CLS2, ROOT,
  stats: () => ({ pass, fail, issues: issues.slice() })
}
