const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

Page({
  data: { allow: false, stat: null, teachers: [], rank: [], me: null, roleText: '未登录', loadErr: false },
  onShow() {
    // 角色以持久化身份为准（app.globalData.role 冷启动/切号后可能是旧值）
    identity.syncGlobal()
    const i = identity.current()
    const allow = identity.isStaff()
    this.setData({ allow, me: i, roleText: i ? identity.roleText(i.role) : '未登录' })
    console.log('[usage] 身份=' + (i ? i.id + '/' + i.role : '未登录') + ' allow=' + allow)
    if (allow) this.load()
  },
  switchAccount() {
    identity.switchAccount()
  },
  // 下拉刷新：先清云端读缓存再重取统计
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    if (!this.data.allow) { done(); return }
    api.call('fresh', {}).then(() => this.load()).then(done, done)
  },
  async load() {
    const d = await api.call('usage', {})
    // null = 云端业务错误：历史上静默不渲染，整页除了权限拦截就是空白，
    // 用户分不清「没数据」还是「没加载出来」。显式落 loadErr 由 WXML 展示重试提示。
    if (!d) {
      this.setData({ stat: null, teachers: [], rank: [], loadErr: true })
      return
    }
    // 注入中文角色名 + 头像首字 + 进度百分比，避免页面直接显示英文 role / 做数值运算
    const raw = d.rank || []
    const max = raw.reduce((m, x) => Math.max(m, Number(x.n) || 0), 0) || 1
    const rank = raw.map(x => ({
      ...x,
      roleText: x.user ? identity.roleText(x.user.role) : '?',
      initial: x.user && x.user.name ? x.user.name.charAt(0) : '?',
      pct: Math.max(6, Math.round(((Number(x.n) || 0) / max) * 100))
    }))
    const teachers = rank.filter(x => x.user && x.user.role === 'teacher')

    // 报表数据的展示预处理：柱高百分比、排行条百分比、月份短标签都在 JS 里算好，
    // WXML 不做数值运算（保持与既有页面一致的写法，也避免空值 NaN 污染渲染）
    const trendMax = Number(d.trendMax) || 1
    const trend = (d.trend || []).map(x => ({
      m: x.m, short: ('' + x.m).slice(5) + '月',
      in: x.in || 0, out: x.out || 0,
      inH: Math.round(((Number(x.in) || 0) / trendMax) * 100),
      outH: Math.round(((Number(x.out) || 0) / trendMax) * 100)
    }))
    const topMax = Math.max(1, ...(d.topMaterials || []).map(x => Number(x.qty) || 0))
    const topMaterials = (d.topMaterials || []).map(x => ({
      ...x, pct: Math.max(6, Math.round(((Number(x.qty) || 0) / topMax) * 100))
    }))
    const stat = Object.assign({}, d, { trend, topMaterials })

    this.setData({
      stat,
      teachers,
      rank,
      // 旧版云函数（尚未重传）不含报表字段，用空集合兜底，避免 WXML 读 undefined 报错
      loadErr: false
    })
  }
})
