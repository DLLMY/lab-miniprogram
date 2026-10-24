const identity = require('../../utils/identity.js')
const api = require('../../utils/api.js')

Page({
  data: {
    me: null,
    meInitial: '?',
    roleText: '未登录',
    qid: '',
    isStaff: false,
    greet: '你好',
    matCount: 0,
    toolCount: 0,
    pendingCount: 0
  },
  onShow() {
    const i = identity.current()
    this.setData({
      me: i,
      meInitial: i && i.name ? i.name.charAt(0) : '?',
      roleText: i ? identity.roleText(i.role) : '未登录',
      isStaff: identity.isStaff(),
      greet: this.greeting()
    })
    this.loadStats()
  },
  // 按当前时段给出问候语
  greeting() {
    const h = new Date().getHours()
    if (h < 6) return '凌晨好'
    if (h < 12) return '上午好'
    if (h < 14) return '中午好'
    if (h < 18) return '下午好'
    return '晚上好'
  },
  // 顶部统计瓦片：耗材数 / 工具数 / 待审批数（教师可见）
  async loadStats() {
    const staff = this.data.isStaff
    const [mats, tools, pending] = await Promise.all([
      api.call('listMaterials', {}),
      api.call('listTools', {}),
      staff ? api.call('pending', {}) : Promise.resolve(null)
    ])
    this.setData({
      matCount: (mats && mats.length) || 0,
      toolCount: (tools && tools.length) || 0,
      pendingCount: (pending && pending.length) || 0
    })
  },
  switchAccount() {
    // 与「我的」页一致：直接退出并回登录页（旧实现依赖 wx.showModal，弹窗不弹时表现为点了没反应）
    identity.switchAccount()
  },
  scan() {
    wx.scanCode({
      success: (r) => {
        const id = (r.result || '').trim().toUpperCase()
        if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
        else wx.showToast({ title: '未识别到物品ID', icon: 'none' })
      },
      fail: () => {
        // 开发者工具模拟器无摄像头，扫码会静默失败；给明确引导而非“点了无效”
        wx.showToast({ title: '模拟器不支持扫码，请手动输入ID', icon: 'none' })
      }
    })
  },
  input(e) { this.setData({ qid: e.detail.value }) },
  go() {
    const id = (this.data.qid || '').trim().toUpperCase()
    if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
    else wx.showToast({ title: '请输入物品ID', icon: 'none' })
  },
  // 统一跳转：库存一览 / 教师功能页都走这里，url 由 wxml 的 data-url 给定
  goStaff(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  },
  // 「物品入库」直达：进入出入库页并直接展开新建物品弹层
  goNewItem() {
    wx.navigateTo({ url: '/pages/io/io?tab=new' })
  }
})
