// utils/identity.js
// 身份体系：工号/学号 → users 表定角色，本地持久化，单点同步进 app.globalData。
// 身份来源（已实现云端优先）：配置了云环境 → 查腾讯文档 users 表（findUser/whoami）；
//   未配云或云端不可用 → 回落本地 mock users 表。其余（持久化/globalData 同步）不变，各页面零改动。
// 注意：mock.js/api.js 在 require 时会读 storage，故此处用惰性 require，避免 app.js 加载期调用 wx API。

const ROLES = ['student', 'teacher', 'admin']

// 角色归一化：历史数据/手输可能给出 'Teacher'、'teacher '、'教师' 等，统一到三值，
// 避免「明明选的是教师账号，页面却判定成学生」。
function normalizeRole(r) {
  const s = ('' + (r === undefined || r === null ? '' : r)).trim().toLowerCase()
  if (s === 'teacher' || s === '教师' || s === '老师') return 'teacher'
  if (s === 'admin' || s === '管理员') return 'admin'
  return 'student'
}

function current() {
  return wx.getStorageSync('lab_identity') || null
}

// 是否配置了真实云环境（配了才把身份查询走云端 users 表，否则回落本地 mock）
function cloudReady() {
  try {
    const app = getApp()
    const env = app && app.globalData ? app.globalData.env : ''
    return !!env && env !== 'your-cloud-env-id' && !!wx.cloud
  } catch (e) {
    return false
  }
}

// 查用户：优先云端 users 表（老师名单以腾讯文档为准），云端不可用/未命中再回落本地 mock。
// 异步化：云端查询是网络调用。api/mock 都用惰性 require，避免 app.js 加载期调用 wx 读 storage。
async function lookup(id) {
  id = ('' + (id || '')).trim().toUpperCase()
  if (!id) return null
  if (cloudReady()) {
    const api = require('./api.js')
    try {
      const u = await api.call('findUser', { id })
      if (u) return { id: u.id, name: u.name, role: u.role, cls: u.cls || '' }
      // 云端查不到（含旧版云函数未部署 findUser 时返回 404）→ 回落 mock，保证登录不中断
    } catch (e) { /* 落到本地 mock */ }
  }
  const mock = require('./mock.js')
  return mock.getUser(id) || null
}

async function login(id) {
  const u = await lookup(id)
  if (!u) return null
  const identity = { id: u.id, name: u.name, role: normalizeRole(u.role) }
  wx.setStorageSync('lab_identity', identity)
  syncGlobal()
  return identity
}

// 用已查到的用户对象直接登录（whoami 免输工号自动登录用，无需再查一次）
function loginWithUser(u) {
  if (!u) return null
  const identity = { id: u.id, name: u.name, role: normalizeRole(u.role) }
  wx.setStorageSync('lab_identity', identity)
  syncGlobal()
  return identity
}

function logout() {
  wx.removeStorageSync('lab_identity')
  const app = getApp()
  if (app && app.globalData) {
    app.globalData.identity = null
    app.globalData.role = 'student'
    app.globalData.me = { id: '', name: '', role: 'student' }
  }
}

// 切换账号：所有页面统一走这里。历史实现里各页依赖 wx.showModal 确认弹窗，
// 弹窗不弹时表现为「点了没反应、卡在当前身份」，这里直接退出并回登录页。
function switchAccount() {
  logout()
  wx.showToast({ title: '已退出，请重新登录', icon: 'none' })
  setTimeout(() => wx.reLaunch({ url: '/pages/login/login' }), 300)
}

// 把 storage 中的身份同步进 app.globalData（页面只读 globalData，不直接碰 storage）
function syncGlobal() {
  const app = getApp()
  if (!app || !app.globalData) return
  const i = current()
  const role = i ? normalizeRole(i.role) : 'student'
  // 顺手把 storage 里的角色写法校正掉（'Teacher'/'教师' → 'teacher'），下次冷启动不必再修
  if (i && i.role !== role) {
    const fixed = { id: i.id, name: i.name, role }
    wx.setStorageSync('lab_identity', fixed)
    app.globalData.identity = fixed
  } else {
    app.globalData.identity = i
  }
  app.globalData.role = role
  app.globalData.me = i ? { id: i.id, name: i.name, role } : { id: '', name: '', role: 'student' }
}

// 是否教师/管理员：以持久化身份为准，并顺手把 globalData 对齐，
// 避免冷启动/切号后页面读到旧角色而误拦。
function isStaff() {
  const i = current()
  if (!i) return false
  return normalizeRole(i.role) !== 'student'
}

// 是否管理员：仅 role === 'admin' 为真（用户与角色管理等后台功能据此对前端隐藏入口）
function isAdmin() {
  const i = current()
  if (!i) return false
  return normalizeRole(i.role) === 'admin'
}

function roleText(role) {
  const r = normalizeRole(role)
  return r === 'teacher' ? '教师' : r === 'admin' ? '管理员' : '学生'
}

module.exports = { current, lookup, login, loginWithUser, logout, switchAccount, syncGlobal, isStaff, isAdmin, roleText, normalizeRole }
