// utils/api.js
// 调用云函数 docsProxy；云不可用（未配置/调用失败）时回退本地 mock，保证导入即跑。
// 坑：wx.cloud.callFunction 在未 wx.cloud.init 时会【同步 throw】；
// 且"不使用云服务"导入时 wx.cloud/callFunction 对象依然存在（只是没初始化），
// 单看 typeof 判断会误判为可用。因此必须：① 配了真实 env 才尝试云；
// ② 云调用整体 try/catch 兜住同步 throw；③ 本 Promise 永不 reject，页面无需 try/catch。
const mock = require('./mock.js')

// 标记本次取数来源与真实后端，供页面显示「数据来源」，避免云函数没生效时误以为看到的是真实数据。
// src：'mock'(云函数内演示/未部署) | 'cloud'(真实后端已生效)；
// backend：'tencent'(腾讯文档) | 'cloud'(微信云数据库) | 'mock'，来自云函数每响应的 r.backend 字段。
// 关键：切到云数据库后 dataBackend 是 'cloud'，必须据此显示「微信云数据库」而非「腾讯文档」。
function markSource(src, backend) {
  try {
    const app = getApp()
    if (app && app.globalData) {
      app.globalData.dataSource = (src === 'mock') ? 'mock' : 'cloud'
      if (backend) app.globalData.dataBackend = backend
    }
  } catch (e) { /* 忽略 */ }
}
// 本地演示（云函数未连接，或云端 USE_MOCK 仍为 true）：dataSource/backend 均为 'mock'
function markMock() {
  try {
    const app = getApp()
    if (app && app.globalData) {
      app.globalData.dataSource = 'mock'
      app.globalData.dataBackend = 'mock'
    }
  } catch (e) { /* 忽略 */ }
}
// 真实后端标识 → 用户可见文案
function backendLabel(b) {
  if (b === 'cloud') return '微信云数据库'
  if (b === 'tencent') return '腾讯文档'
  if (b === 'mock') return '本地演示数据'
  return '未知'
}

function cloudEnvOk() {
  try {
    const app = getApp()
    const env = app && app.globalData ? app.globalData.env : ''
    return !!env && env !== 'your-cloud-env-id'
  } catch (e) {
    return false
  }
}

// 调用超时竞速：wx.cloud.callFunction 无超时参数，弱网/云函数异常悬挂时 Promise 永不 settle，
// 页面 showLoading 会永久转圈。这里加一道 30s 兜底（云函数自身超时上限约 20s，30s 只在平台异常时触发）。
// 超时以 Error('__timeout__') 拒绝，与传输层失败（callFunction 的 fail）区分开，调用方分别处理。
const CALL_TIMEOUT = 30000
function withTimeout(p) {
  let timer = null
  const raced = Promise.race([
    p,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('__timeout__')), CALL_TIMEOUT)
    })
  ])
  // 竞速落定后清定时器，避免定时器泄漏；.catch 兜住 reject 分支无人处理的告警
  raced.finally(() => clearTimeout(timer)).catch(() => {})
  return raced
}
function isTimeoutErr(e) { return e && e.message === '__timeout__' }

function call(action, data = {}) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const fallback = (why) => {
      console.warn('[api] 回退本地 mock (' + why + '), action=' + action)
      markMock()
      try {
        const r = mock.dispatch(action, data)
        done(r && r.code === 0 ? r.data : null) // 与云路径一致：业务错误（如库存不足）→ null
      } catch (e) { done(null) }
    }

    // 诊断：每次取数都先打印路径，便于在模拟器 Console 直接判断（不依赖云端日志）
    const canCloud = cloudEnvOk() && !!wx.cloud && typeof wx.cloud.callFunction === 'function'
    console.log('[api] call(action=' + action + ') cloudEnvOk=' + cloudEnvOk() + ' wxCloud=' + (!!wx.cloud) + ' → ' + (canCloud ? '走云端' : '回退mock'))

    try {
      if (!canCloud) {
        fallback(cloudEnvOk() ? 'wx.cloud 不可用' : '未配置云环境')
        return
      }
      const cp = new Promise((res, rej) => {
        wx.cloud.callFunction({
          name: 'docsProxy',
          data: { action, ...data },
          success: res,
          fail: rej
        })
      })
      withTimeout(cp)
        .then((res) => {
          const r = (res && res.result) || {}
          // 云函数会回 src：mock=云函数内演示数据（说明 USE_MOCK 还是 true），cloud=真实后端已生效（腾讯文档或微信云数据库）
          const src = r.src || '?'
          markSource(src, r.backend)
          // 每个 action 都打一行返回摘要，一眼看出「云端返回了什么」（不依赖云端日志）
          let brief = ''
          if (action === 'listMine') {
            const dd = r.data || {}
            brief = ' 领用=' + ((dd.requisitions || []).length) + ' 借还=' + ((dd.borrow || []).length) + ' 用户=' + (data.user || '')
          } else if (Array.isArray(r.data)) {
            brief = ' 条数=' + r.data.length
          } else if (r.data && typeof r.data === 'object') {
            const keys = Object.keys(r.data).slice(0, 4)
            brief = ' keys=' + keys.join(',')
          }
          console.log('[api] 云端返回 action=' + action + ' src=' + src + ' code=' + r.code + brief
            + (r.data && r.data.msg ? ' msg=' + r.data.msg : ''))
          done(r.code === 0 ? r.data : null) // 业务错误，上层自行提示
        }, (err) => {
          fallback(isTimeoutErr(err)
            ? '调用超时(' + CALL_TIMEOUT / 1000 + 's)'
            : 'callFunction 失败: ' + (err && (err.errMsg || err.message)))
        })
    } catch (e) {
      // 同步 throw（典型：未 wx.cloud.init 就调 callFunction）
      fallback('云 API 异常: ' + (e && e.message))
    }
  })
}

// 与 call 相同，但【完整返回】{code,data,src}（业务错误也带 msg），
// 供需要把具体错误展示给用户的场景（如绑定登录：工号不存在/姓名不符/已被其他微信绑定）。
// 云不可用时回落 mock.dispatch 的 {code,data}；传输层失败也尽量回落 mock。
//
// opts.noFallback（写操作必须传 true）：
//   传输层失败（网络断/云函数未部署/超时）时【不回退 mock】——否则 mock 对写 action
//   一律返回 {code:0}，页面会显示"登记成功/已通过/已删除"而云端什么都没写（假成功）。
//   改为返回 {code:503,...} 让上层把真实状态告诉用户。
//   注：仅"配了云环境但调用失败"时生效；纯本地演示（未配置 env）仍走 mock，保证导入即跑。
function callFull(action, data = {}, opts) {
  const noFallback = !!(opts && opts.noFallback)
  const transportFail = () => (noFallback
    ? { code: 503, data: { msg: '云函数调用失败（网络异常或云函数未部署），请检查网络后重试' } }
    : null)
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const mockFallback = () => {
      try { markMock(); return mock.dispatch(action, data) } catch (e) { return null }
    }
    const canCloud = cloudEnvOk() && !!wx.cloud && typeof wx.cloud.callFunction === 'function'
    if (!canCloud) {
      done(mockFallback())
      return
    }
    try {
      const cp = new Promise((res, rej) => {
        wx.cloud.callFunction({
          name: 'docsProxy',
          data: { action, ...data },
          success: res,
          fail: rej
        })
      })
      withTimeout(cp)
        .then((res) => {
          const r = (res && res.result) || {}
          markSource(r.src, r.backend)
          done(r)
        }, () => {
          // 传输层失败（网络断 / 云函数未部署 / 超时）：noFallback 时返回 503 让上层告知用户，
          // 否则回落 mock（读操作与纯演示场景的既有语义）
          done(noFallback ? transportFail() : mockFallback())
        })
    } catch (e) {
      done(noFallback ? transportFail() : mockFallback())
    }
  })
}

// 当前数据来源是否为本地演示（云函数未连接，或云端 USE_MOCK 仍为 true）。
// 测试时最大的误导是「云函数明明没生效，却因为 mock 有反应而以为数据已落云端」。
function isDemoData() {
  try {
    const app = getApp()
    const src = app && app.globalData ? app.globalData.dataSource : ''
    if (src === 'mock') return true
    if (src === 'cloud') return false
    // 还没有任何取数记录时，按云环境是否配置判断（未配置 env 必然走不到云端）
    return !cloudEnvOk()
  } catch (e) {
    return false
  }
}

// 写操作（登记/审批/归还/建号）入口调用：演示模式下先弹一条 2.5s 警示（不阻断流程），
// 明确告知结果只保存在本机，避免把「本机 mock 有反应」误当成「云函数已生效」。
function warnIfDemo() {
  if (!isDemoData()) return
  console.warn('[api] 演示模式写操作：结果仅保存在本机 mock，不会写入云端')
  try {
    wx.showToast({ title: '演示模式：仅保存在本机', icon: 'none', duration: 2500 })
  } catch (e) { /* 忽略 */ }
}

module.exports = { call, callFull, isDemoData, warnIfDemo, backendLabel }
