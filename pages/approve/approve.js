const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

Page({
  data: { allow: false, list: [], busy: false, me: null, roleText: '未登录' },
  onShow() {
    // 角色以持久化身份为唯一依据：历史实现读 app.globalData.role，
    // 冷启动/切号后该值可能是旧的 'student'，导致教师账号也被拦成「无权限」。
    identity.syncGlobal()
    const i = identity.current()
    const allow = identity.isStaff()
    this.setData({ allow, me: i, roleText: i ? identity.roleText(i.role) : '未登录' })
    console.log('[approve] 身份=' + (i ? i.id + '/' + i.role : '未登录') + ' allow=' + allow)
    if (allow) this.load()
  },
  switchAccount() {
    identity.switchAccount()
  },
  async load() {
    const list = await api.call('pending', {})
    this.setData({ list: list || [] })
  },
  async approve(e) {
    if (this.data.busy) return // 防连点重复审批
    const no = e.currentTarget.dataset.no
    const ok = e.currentTarget.dataset.ok === '1'
    const me = identity.current()
    if (!me) {
      wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    wx.showLoading({ title: ok ? '审批中...' : '处理中...', mask: true })
    try {
      const r = await api.call('approve', { no, ok, actor: me.id })
      wx.showToast({ title: r ? (ok ? '已通过' : '已拒绝') : '操作未成功', icon: 'none' })
      await this.load()
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  }
})
