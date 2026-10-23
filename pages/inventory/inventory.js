const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

Page({
  data: {
    mats: [],
    tools: [],
    matList: [],
    toolList: [],
    lowCount: 0,
    tab: 'mat',
    kw: '',
    srcText: '加载中…'
  },
  onShow() {
    this.load()
  },
  async load() {
    const [mats, tools] = await Promise.all([
      api.call('listMaterials', {}),
      api.call('listTools', {})
    ])
    const app = getApp()
    const src = app && app.globalData ? app.globalData.dataSource : ''
    const m = mats || []
    const t = tools || []
    // 预计算库存水位百分比、是否低于安全线与预警数，避免在 WXML 里做数值运算
    const mats2 = m.map(x => {
      const stock = Number(x.stock) || 0
      const safe = Number(x.safe) || 0
      return Object.assign({}, x, { pct: this.pct(stock, safe), low: stock < safe })
    })
    this.setData({
      mats: mats2,
      tools: t,
      lowCount: mats2.filter(x => (Number(x.stock) || 0) < (Number(x.safe) || 0)).length,
      srcText: src === 'cloud' ? '真实腾讯文档' : (src === 'mock' ? '本地演示数据' : '未知')
    })
    this.filter()
  },
  // 以安全库存为 100% 基准
  pct(stock, safe) {
    const s = Number(stock) || 0
    const f = Number(safe) || 0
    let p = f > 0 ? Math.round((s / f) * 100) : (s > 0 ? 100 : 0)
    if (p < 0) p = 0
    if (p > 100) p = 100
    return p
  },
  setTab(e) {
    this.setData({ tab: e.currentTarget.dataset.t === 'tool' ? 'tool' : 'mat' })
    this.filter()
  },
  onKw(e) {
    this.setData({ kw: e.detail.value })
    this.filter()
  },
  // 按关键字过滤当前分段的数据
  filter() {
    const kw = (this.data.kw || '').trim().toLowerCase()
    const hit = (x) => !kw ||
      (x.name || '').toLowerCase().indexOf(kw) >= 0 ||
      (x.id || '').toLowerCase().indexOf(kw) >= 0
    this.setData({
      matList: this.data.mats.filter(hit),
      toolList: this.data.tools.filter(hit)
    })
  },
  goDetail(e) {
    const id = e.currentTarget.dataset.id
    if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
  }
})
