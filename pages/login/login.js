const identity = require('../../utils/identity.js')
const api = require('../../utils/api.js')

Page({
  data: { name: '', id: '', busy: false, autoJumping: false },
  onLoad(options) {
    this.bootstrap(options || {})
  },
  async bootstrap(options) {
    // 已有身份 → 直接放行（冷启动透传，无需重复登录）
    if (identity.current()) {
      // ⚠️ 不能在 onLoad 内同步跳转：LazyCodeLoading 开启时，当前页 webview 尚未注册完
      // 就切路由会触发 'routeDone with a webviewId X is not found' 及连带
      // 'Cannot read properties of null (reading screenHeight)' 崩溃。
      // 必须延迟到下一 tick 再切换，并用 autoJumping 占位避免表单闪现。
      this.setData({ autoJumping: true })
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 60)
      return
    }
    // 用户主动「退出/切换账号」后跳转而来（?force=1）：不要再用 whoami 静默自动登录，
    // 否则真实云端下会立刻以同一微信重新登录回原账号，表现为「点了退出却没退出」。
    // 直接展示登录表单，让用户重新录入（也能拾取表格里刚改过的角色）。
    if (options && options.force === '1') {
      return
    }
    // 冷启动且已绑定过微信的用户：免输入姓名/工号，直接自动登录
    try {
      const u = await api.call('whoami', {})
      if (u) {
        console.log('[login] openid 自动登录 ' + u.id + ' · ' + u.role)
        identity.loginWithUser(u)
        wx.showToast({ title: '欢迎回来，' + u.name, icon: 'none' })
        setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 500)
        return
      }
    } catch (e) { /* 忽略，走姓名+工号绑定 */ }
    // 未绑定：展示姓名 + 工号绑定表单（不再展示账号列表，避免泄露用户表与角色）
  },
  nameInput(e) { this.setData({ name: e.detail.value }) },
  idInput(e) { this.setData({ id: e.detail.value }) },
  async submit() {
    if (this.data.busy) return
    const name = (this.data.name || '').trim()
    const id = (this.data.id || '').trim()
    if (!name || !id) { wx.showToast({ title: '请输入姓名和工号', icon: 'none' }); return }
    this.setData({ busy: true })
    wx.showLoading({ title: '绑定中...', mask: true })
    try {
      // noFallback：bindLogin 是写操作（把 openid 写进 users 表）。传输失败时若回落本地
      // mock，mock 用户表为空会误报「工号不存在」，把网络问题伪装成业务错误。
      const r = await api.callFull('bindLogin', { name, id }, { noFallback: true })
      if (r && r.code === 0 && r.data) {
        identity.loginWithUser(r.data)
        wx.showToast({ title: '绑定成功，欢迎 ' + r.data.name, icon: 'none' })
        setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 600)
      } else {
        // 把具体原因透出：工号不存在 / 姓名不符 / 已被其他微信绑定 / 此微信已绑他号
        wx.showToast({ title: (r && r.data && r.data.msg) || '绑定失败，请重试', icon: 'none' })
      }
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  }
})
