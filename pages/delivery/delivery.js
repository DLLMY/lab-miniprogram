// pages/delivery/delivery.js
// 物品交付单：审批通过 → 库存已扣 → 但东西可能还没交到学生手上。
// 本页给教师/管理员一张「待交付清单」，照着单子把耗材/工具发出去并逐单确认。
// 关键：确认交付只留痕「实物已发出」，**不再动库存**（审批时已扣），防二次扣减。
const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

const DAYS = 30   // 默认只看近 30 天的单，避免上线瞬间历史已通过单一次性涌出来

Page({
  data: {
    allow: false,
    roleText: '未登录',
    tab: 'pending',        // pending=待交付 | delivered=已交付
    rows: [],
    total: 0,
    loading: false,
    loadErr: false,
    allDays: false,        // 是否显示全部历史未交付单
    busy: false
  },

  onShow() {
    identity.syncGlobal()
    const i = identity.current()
    const allow = identity.isStaff()
    this.setData({ allow, roleText: i ? identity.roleText(i.role) : '未登录' })
    if (allow) this.load()
    else this.setData({ rows: [], total: 0 })
  },

  async load() {
    if (this.data.loading) return
    this.setData({ loading: true, loadErr: false })
    try {
      const d = await api.call('listDeliveries', {
        showDelivered: this.data.tab === 'delivered',
        days: this.data.allDays ? 0 : DAYS
      })
      if (d === null) { this.setData({ loading: false, loadErr: true, rows: [], total: 0 }); return }
      const rows = (d && d.rows) || []
      this.setData({
        rows,
        total: (d && Number(d.total)) || rows.length,
        loading: false
      })
    } catch (e) {
      this.setData({ loading: false, loadErr: true })
    }
  },

  switchAccount() { identity.switchAccount() },
  noop() {},

  onTab(e) {
    const t = e.currentTarget.dataset.t
    if (this.data.tab === t) return
    this.setData({ tab: t }, () => this.load())
  },
  toggleAllDays() {
    this.setData({ allDays: !this.data.allDays }, () => this.load())
  },
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    api.call('fresh', {}).then(() => this.load()).then(done, done)
  },

  // 确认交付：二次确认 → 调 confirmDelivery → 刷新清单
  async confirm(e) {
    if (this.data.busy) return
    const no = e.currentTarget.dataset.no
    const item = (this.data.rows || []).find(x => ('' + x.no) === ('' + no))
    if (!item) return
    const what = item.kind === 'tool'
      ? (item.itemName || item.toolId) + '（工具借出，借期 ' + (item.days || 7) + ' 天）'
      : (item.itemName || item.matId) + ' × ' + item.qty
    const c = await new Promise(res => wx.showModal({
      title: '确认交付',
      content: '确认已把 ' + what + ' 交给 ' + (item.userName || item.user) + '？\\n（库存已在审批时扣减，这里只确认实物已交出）',
      confirmText: '已交付',
      success: res
    }))
    if (!c.confirm) return
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
    this.setData({ busy: true })
    api.warnIfDemo()
    let r = null
    try {
      r = await api.callFull('confirmDelivery', { no: item.no, actor: me.id }, { noFallback: true })
    } catch (e) {
      r = null
    } finally {
      this.setData({ busy: false })
    }
    if (r && r.code === 0) {
      wx.showToast({ title: '已确认交付', icon: 'success' })
      await this.load()
    } else {
      wx.showModal({ title: '确认失败', content: (r && r.data && r.data.msg) || '请重试', showCancel: false })
    }
  }
})
