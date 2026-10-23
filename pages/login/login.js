const identity = require('../../utils/identity.js')
const api = require('../../utils/api.js')

Page({
  data: { name: '', id: '', users: [], bound: null, busy: false },
  onLoad() {
    this.bootstrap()
  },
  async bootstrap() {
    // 已有身份 → 直接放行（冷启动透传，无需重复登录）
    if (identity.current()) {
      wx.switchTab({ url: '/pages/index/index' })
      return
    }
    // 已绑定过微信的用户：免输入姓名/工号，直接自动登录
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
    // 未绑定：展示绑定表单 + 账号列表（点击仅填充，不直接登录）
    this.setData({ bound: null })
    await this.loadUsers()
  },
  async loadUsers() {
    let list = []
    try { list = await api.call('listUsers', {}) || [] } catch (e) { list = [] }
    if (!list.length) list = require('../../utils/mock.js').listUsers()  // 云端不可用回落演示账号
    // 预计算头像首字：WXML 里不支持对字符串取下标
    list = list.map(u => Object.assign({}, u, { initial: (u.name || '?').charAt(0) }))
    this.setData({ users: list })
  },
  nameInput(e) { this.setData({ name: e.detail.value }) },
  idInput(e) { this.setData({ id: e.detail.value }) },
  // 点演示账号 → 仅填充姓名/工号，再由用户点「绑定并登录」，避免误绑
  fill(e) {
    const u = e.currentTarget.dataset.u
    this.setData({ name: u.name, id: u.id })
  },
  async submit() {
    if (this.data.busy) return
    const name = (this.data.name || '').trim()
    const id = (this.data.id || '').trim()
    if (!name || !id) { wx.showToast({ title: '请输入姓名和工号', icon: 'none' }); return }
    this.setData({ busy: true })
    wx.showLoading({ title: '绑定中...', mask: true })
    try {
      const r = await api.callFull('bindLogin', { name, id })
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
