// app.js
// 全局初始化：身份体系（演示期本地 users 表，生产走 openid）+ 云开发环境
const identity = require('./utils/identity.js')

App({
  globalData: {
    DEMO: true,                       // 演示模式：mock 数据 + 本地身份表；生产 openid→users 表
    role: 'student',
    me: { id: '', name: '', role: 'student' },
    identity: null,                   // 当前身份 { id, name, role }，未登录为 null
    // 云开发环境 ID（已开通：环境名 cloud1 / 应用「数字个人档案」）
    // 保持占位 'your-cloud-env-id' 会自动回退本地 mock；当前已填真实值 → 走云函数 docsProxy
    env: 'cloud1-d7gw1366xdb7ac348'
  },
  onLaunch() {
    // 启动即把持久化身份同步进 globalData；无身份时首页/各页按未登录处理，
    // 入口页 login 负责把关（已有身份会自动放行）
    identity.syncGlobal()
    if (this.globalData.env && this.globalData.env !== 'your-cloud-env-id' && wx.cloud) {
      wx.cloud.init({ env: this.globalData.env, traceUser: true })
      console.log('[app] wx.cloud.init 完成，env=' + this.globalData.env)
    } else {
      console.warn('[app] 未初始化云环境：env=' + this.globalData.env + ' wxCloud=' + (!!wx.cloud))
    }
  }
})
