// utils/api.js
// 调用云函数 docsProxy；云不可用（未配置/调用失败）时回退本地 mock，保证导入即跑。
// 坑：wx.cloud.callFunction 在未 wx.cloud.init 时会【同步 throw】；
// 且"不使用云服务"导入时 wx.cloud/callFunction 对象依然存在（只是没初始化），
// 单看 typeof 判断会误判为可用。因此必须：① 配了真实 env 才尝试云；
// ② 云调用整体 try/catch 兜住同步 throw；③ 本 Promise 永不 reject，页面无需 try/catch。
const mock = require('./mock.js')

// 标记本次取数来源，供页面显示「数据来源」，避免云函数没生效时误以为看到的是真实数据
function markSource(src) {
  try {
    const app = getApp()
    if (app && app.globalData) app.globalData.dataSource = src
  } catch (e) { /* 忽略 */ }
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

function call(action, data = {}) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const fallback = (why) => {
      console.warn('[api] 回退本地 mock (' + why + '), action=' + action)
      markSource('mock')
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
      wx.cloud.callFunction({
        name: 'docsProxy',
        data: { action, ...data },
        success: (res) => {
          const r = (res && res.result) || {}
          // 云函数会回 src：mock=云函数内演示数据（说明 USE_MOCK 还是 true），cloud=真实腾讯文档
          const src = r.src || '?'
          markSource(src === 'mock' ? 'mock' : 'cloud')
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
          if (r.code === 0) done(r.data)
          else { done(null) } // 业务错误，上层自行提示
        },
        fail: (err) => {
          fallback('callFunction 失败: ' + (err && (err.errMsg || err.message)))
        }
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
function callFull(action, data = {}) {
  return new Promise((resolve) => {
    const canCloud = cloudEnvOk() && !!wx.cloud && typeof wx.cloud.callFunction === 'function'
    if (!canCloud) {
      try { markSource('mock'); resolve(mock.dispatch(action, data)) } catch (e) { resolve(null) }
      return
    }
    try {
      wx.cloud.callFunction({
        name: 'docsProxy',
        data: { action, ...data },
        success: (res) => {
          const r = (res && res.result) || {}
          markSource(r.src === 'mock' ? 'mock' : 'cloud')
          resolve(r)
        },
        fail: () => {
          try { markSource('mock'); resolve(mock.dispatch(action, data)) } catch (e) { resolve(null) }
        }
      })
    } catch (e) {
      try { markSource('mock'); resolve(mock.dispatch(action, data)) } catch (_) { resolve(null) }
    }
  })
}

module.exports = { call, callFull }
