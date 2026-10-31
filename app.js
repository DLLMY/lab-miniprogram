// app.js
// 全局初始化：身份体系（演示期本地 users 表，生产走 openid）+ 云开发环境
const identity = require('./utils/identity.js')

App({
  globalData: {
    DEMO: false,                      // 生产模式：走真实云环境（openid→users 表）；本地 mock 仅作离线回退
    role: 'student',
    me: { id: '', name: '', role: 'student' },
    identity: null,                   // 当前身份 { id, name, role }，未登录为 null
    // 云开发环境 ID（生产环境，须与上线 AppID 同主体）：
    // 保持占位 'your-cloud-env-id' 会自动回退本地 mock；填真实值 → 走云函数 docsProxy。
    // ⚠️ 上线替换：换学校生产 AppID 后，必须在本账号下重新开通云开发，并把此值改为新环境 ID。
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
