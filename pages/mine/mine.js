const app = getApp()
const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')
const mock = require('../../utils/mock.js')

Page({
  data: { me: null, meInitial: '?', roleText: '未登录', isStaff: false, isDemo: false, showReset: false, rs: [], bs: [], srcText: '检测中…', srcOk: false, diag: null, diagText: '检测中…', diagOk: false },

  // 云端自检：直接问云函数「你现在跑的是 mock 还是真腾讯文档」，并把结果摊在页面上
  async runDiag() {
    this.setData({ diagText: '检测中…', diagOk: false })
    const dg = await api.call('diag', {})
    if (!dg) {
      this.setData({ diag: null, diagText: '自检无响应：云端 docsProxy 很可能是旧版代码（还不认识 diag 接口），请重新「上传并部署：云端安装依赖」' })
      return
    }
    let t
    let ok = false
    if (dg.useMock) {
      t = dg.hasCredential
        ? '凭证齐全，但 USE_MOCK 被显式设成了 ' + dg.rawUseMock + '，改回 false 即可'
        : '云端跑的是内存 mock（USE_MOCK=' + dg.rawUseMock + '，凭证不全），数据不落腾讯文档'
    } else if (dg.ping === 'ok') {
      t = '已连真实腾讯文档，materials 读到 ' + dg.materialCount + ' 条'
      ok = true
    } else {
      t = '生产模式但连不上腾讯文档：' + (dg.pingError || '未知错误')
    }
    this.setData({ diag: dg, diagText: t, diagOk: ok })
  },

  async onShow() {
    const i = identity.current()
    this.setData({
      me: i,
      meInitial: i && i.name ? i.name.charAt(0) : '?',
      roleText: i ? identity.roleText(i.role) : '未登录',
      isStaff: identity.isStaff(),
      isDemo: !!(app && app.globalData && app.globalData.DEMO)
    })
    await this.runDiag()
    const d = await api.call('listMine', { user: (i && i.id) || '' })
    const src = app && app.globalData ? app.globalData.dataSource : ''
    const srcText = src === 'cloud' ? '真实腾讯文档' : (src === 'mock' ? '本地演示数据（云函数未生效）' : '未知')
    // 「重置演示数据」仅在演示（非真实腾讯文档）时可见：走真实库后点了也只清本地 mock，会误导
    this.setData({
      rs: (d && d.requisitions) || [],
      bs: (d && d.borrow) || [],
      srcText,
      srcOk: src === 'cloud',
      showReset: this.data.isDemo && srcText !== '真实腾讯文档'
    })
  },
  goStaff(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  },
  switchAccount() {
    // 统一走 identity.switchAccount（退出 + Toast + 回登录页），避免各页重复实现导致行为不一致
    identity.switchAccount()
  },
  resetDemo() {
    wx.showModal({
      title: '重置演示数据',
      content: '将清空所有领用/借还/出入库记录并恢复初始演示数据，确定？',
      confirmText: '重置',
      success: (r) => {
        if (r.confirm) {
          mock.reset()
          wx.showToast({ title: '已重置', icon: 'success' })
          this.onShow()
        }
      }
    })
  }
})
