const app = getApp()
const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')
const mock = require('../../utils/mock.js')

Page({
  data: { me: null, meInitial: '?', roleText: '未登录', isStaff: false, isAdmin: false, isDemo: false, rs: [], bs: [], srcText: '检测中…', srcOk: false, diag: null, diagText: '检测中…', diagOk: false,
    // 个人机器人密钥（WorkBuddy 自然语言操作自服务）
    robotKey: '', robotKeyShown: false, hasRobotKey: false, robotBusy: false },

  // 云端自检：直接问云函数「你现在跑的是 mock 还是真后端（腾讯文档/云数据库）」，并把结果摊在页面上
  async runDiag() {
    // 云端自检需要已绑定身份（服务端 diag 只对已登录用户开放，避免匿名反复调用打后端配额）。
    // 未登录时直接说明，不去打扰云端，也不误报「云函数是旧版代码」。
    if (!identity.current()) {
      this.setData({ diag: null, diagText: '请先登录后再自检', diagOk: false })
      return
    }
    this.setData({ diagText: '检测中…', diagOk: false })
    const dg = await api.call('diag', {})
    if (!dg) {
      this.setData({ diag: null, diagText: '自检无响应：云端未返回诊断信息。若刚部署过云函数，请确认已「上传并部署：云端安装依赖」后重试', diagOk: false })
      return
    }
    let t
    let ok = false
    const bk = dg.backend || dg.dataBackend || '?'
    const bkName = bk === 'cloud' ? '微信云数据库' : (bk === 'tencent' ? '腾讯文档' : (bk === 'mock' ? '本地演示数据' : bk))
    if (dg.useMock) {
      t = dg.hasCredential
        ? '凭证齐全，但 USE_MOCK 被显式设成了 ' + dg.rawUseMock + '，改回 false 即可'
        : '云端跑的是内存 mock（USE_MOCK=' + dg.rawUseMock + '，凭证不全），数据不落真实后端'
    } else if (dg.ping === 'ok') {
      t = '主后端=' + bk + '（' + bkName + '），自检通过，耗材读到 ' + dg.materialCount + ' 条'
      ok = true
    } else {
      let extra = dg.pingError || '未知错误'
      if (bk === 'cloud' && dg.dbReady === false) extra += '；云数据库未初始化（dbReady=false）'
      t = '主后端=' + bk + '，但连不上：' + extra
    }
    // access_token 临期告警（仅腾讯文档模式有意义：云库/mock 不消耗 token）。
    // 个人开发者凭证 30 天到期且无自动刷新，临期不处理会集体 401，内测中途全站不可用。
    // tokenDaysLeft：-1=未配置/解析不了（不告警）；0~7=临期；<=-2=已过期。
    if (dg.backend === 'tencent' && typeof dg.tokenDaysLeft === 'number') {
      if (dg.tokenDaysLeft >= 0 && dg.tokenDaysLeft <= 7) {
        t = '⚠ access_token 将在 ' + dg.tokenDaysLeft + ' 天后过期：请到腾讯文档开放平台控制台重置 token，并更新云函数环境变量 TENCENT_DOCS_ACCESS_TOKEN'
        ok = false
      } else if (dg.tokenDaysLeft <= -2) {
        t = '⚠ access_token 已过期约 ' + (-dg.tokenDaysLeft) + ' 天：请立即到腾讯文档开放平台控制台重置 token 并更新环境变量，否则全站不可用'
        ok = false
      }
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
      isAdmin: identity.isAdmin(),
      isDemo: !!(app && app.globalData && app.globalData.DEMO)
    })
    await this.runDiag()
    const d = await api.call('listMine', { user: (i && i.id) || '' })
    const be = (app && app.globalData && app.globalData.dataBackend) ||
      (app && app.globalData && app.globalData.dataSource) || ''
    const srcText = api.backendLabel(be) || '未知'
    this.setData({
      rs: (d && d.requisitions) || [],
      bs: (d && d.borrow) || [],
      srcText,
      srcOk: be === 'cloud' || be === 'tencent'
    })
    await this.loadRobotStatus()
  },

  // 读取当前用户是否已有机器人密钥（仅已登录有效）
  async loadRobotStatus() {
    const i = identity.current()
    if (!i) { this.setData({ hasRobotKey: false, robotKey: '', robotKeyShown: false }); return }
    try {
      const r = await api.callFull('robotKeyStatus', {}, { noFallback: true })
      this.setData({ hasRobotKey: !!(r && r.code === 0 && r.data && r.data.hasKey) })
    } catch (e) {
      this.setData({ hasRobotKey: false })
    }
  },

  // 生成/重置个人机器人密钥：密钥明文仅返回这一次，需立即复制保存
  async genRobotKey() {
    if (this.data.robotBusy) return
    const i = identity.current()
    if (!i) { wx.showToast({ title: '请先登录', icon: 'none' }); return }
    if (this.data.hasRobotKey) {
      const c = await new Promise(res => wx.showModal({
        title: '重置密钥',
        content: '将生成一把新密钥，旧密钥立即失效（正在使用的 WorkBuddy 连接会断开，需用新密钥重新配置）。确定重置？',
        confirmText: '重置', success: res
      }))
      if (!c.confirm) return
    }
    this.setData({ robotBusy: true })
    wx.showLoading({ title: '生成中…', mask: true })
    try {
      const r = await api.callFull('genRobotKey', {}, { noFallback: true })
      wx.hideLoading()
      if (r && r.code === 0 && r.data && r.data.token) {
        this.setData({ robotKey: r.data.token, robotKeyShown: true, hasRobotKey: true, robotBusy: false })
      } else {
        this.setData({ robotBusy: false })
        wx.showModal({ title: '生成失败', content: (r && r.data && r.data.msg) || '请稍后重试', showCancel: false, confirmText: '知道了' })
      }
    } catch (e) {
      wx.hideLoading(); this.setData({ robotBusy: false })
      wx.showModal({ title: '生成异常', content: '云端未响应，请确认云函数已部署后重试', showCancel: false, confirmText: '知道了' })
    }
  },

  // 吊销密钥：清空后任何 WorkBuddy 连接立即失效
  async revokeRobotKey() {
    if (this.data.robotBusy) return
    const c = await new Promise(res => wx.showModal({
      title: '吊销密钥',
      content: '吊销后，你的所有 WorkBuddy 自然语言连接将立即失效，需重新生成才能使用。确定？',
      confirmText: '吊销', success: res
    }))
    if (!c.confirm) return
    this.setData({ robotBusy: true })
    wx.showLoading({ title: '处理中…', mask: true })
    try {
      const r = await api.callFull('revokeRobotKey', {}, { noFallback: true })
      wx.hideLoading(); this.setData({ robotBusy: false, robotKey: '', robotKeyShown: false, hasRobotKey: false })
      if (r && r.code === 0) wx.showToast({ title: '已吊销', icon: 'success' })
      else wx.showModal({ title: '吊销失败', content: (r && r.data && r.data.msg) || '请稍后重试', showCancel: false, confirmText: '知道了' })
    } catch (e) {
      wx.hideLoading(); this.setData({ robotBusy: false })
      wx.showModal({ title: '吊销异常', content: '云端未响应，请确认云函数已部署后重试', showCancel: false, confirmText: '知道了' })
    }
  },

  copyRobotKey() {
    const k = this.data.robotKey
    if (!k) return
    wx.setClipboardData({ data: k, success: () => wx.showToast({ title: '已复制', icon: 'success' }) })
  },
  goStaff(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  },
  // 下拉刷新：先清云端读缓存，再重跑自检与列表
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    api.call('fresh', {}).then(() => this.onShow()).then(done, done)
  },
  switchAccount() {
    // 统一走 identity.switchAccount（退出 + Toast + 回登录页），避免各页重复实现导致行为不一致
    identity.switchAccount()
  },
  // 撤回申请（P1-⑨）：仅本人、仅待审批。此前提错单只能等审批或找管理员改表
  async cancelReq(e) {
    const no = '' + (e.currentTarget.dataset.no || '')
    if (!no) return
    const confirm = await new Promise(res => wx.showModal({
      title: '撤回申请',
      content: '撤回后该单据不再进入审批流程，确定撤回 ' + no + ' 吗？',
      confirmText: '撤回',
      success: res
    }))
    if (!confirm.confirm) return
    wx.showLoading({ title: '处理中…', mask: true })
    try {
      const r = await api.callFull('cancelReq', { no }, { noFallback: true })
      if (r && r.code === 0) {
        wx.showToast({ title: '已撤回', icon: 'success' })
        await this.onShow()
      } else {
        wx.showModal({
          title: '撤回失败',
          content: (r && r.data && r.data.msg) || '请刷新后重试',
          showCancel: false, confirmText: '知道了'
        })
      }
    } finally {
      wx.hideLoading()
    }
  },
})
