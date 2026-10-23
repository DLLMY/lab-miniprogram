const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

Page({
  data: { id: '', type: '', item: null, role: 'student', stockPct: 0, lowStock: false },
  onLoad(o) {
    this.setData({ role: this.currentRole() })
    if (o.id) this.load(o.id)
  },
  onShow() {
    // 角色可能在首页被切换，页面显示时按持久化身份同步一次，避免按钮组过期
    this.setData({ role: this.currentRole() })
  },
  // 角色以持久化身份为准，避免 globalData 里的旧值让教师看不到教师操作
  currentRole() {
    identity.syncGlobal()
    const i = identity.current()
    return i ? identity.normalizeRole(i.role) : 'student'
  },
  // 当前登录用户 ID：统一从持久化身份取（与审批页一致），不依赖 globalData 时序
  meId() {
    const i = identity.current()
    return i ? i.id : ''
  },
  async load(id) {
    this.setData({ id })
    const d = await api.call('getItem', { id })
    if (d && d.item) {
      this.setData({ type: d.type, item: d.item })
      this.calcStock(d.item)
    } else wx.showToast({ title: '未找到物品', icon: 'none' })
  },
  // 库存水位进度：以安全库存为 100% 基准（超出安全线封顶 100%）
  calcStock(item) {
    const stock = Number(item.stock) || 0
    const safe = Number(item.safe) || 0
    let pct = safe > 0 ? Math.round((stock / safe) * 100) : (stock > 0 ? 100 : 0)
    if (pct < 0) pct = 0
    if (pct > 100) pct = 100
    this.setData({ stockPct: pct, lowStock: stock < safe })
  },
  async requisition() {
    const r = await new Promise(res => wx.showModal({
      editable: true, title: '申请领用数量', placeholderText: '1', success: res
    }))
    if (!r.confirm) return
    const qty = parseInt(r.content)
    if (!qty || qty <= 0) { wx.showToast({ title: '请输入正整数数量', icon: 'none' }); return }
    const res = await api.call('requisition', { user: this.meId(), matId: this.data.id, qty })
    wx.showToast({ title: res ? '已提交，待审批' : '提交失败', icon: 'none' })
    if (res) setTimeout(() => wx.navigateBack(), 800)
  },
  async requestBorrow() {
    const res = await api.call('toolRequisition', { user: this.meId(), toolId: this.data.id })
    wx.showToast({ title: res ? '已提交，待审批' : '提交失败', icon: 'none' })
    if (res) setTimeout(() => wx.navigateBack(), 800)
  },
  async returnTool() {
    const res = await api.call('returnTool', { actor: this.meId(), toolId: this.data.id })
    wx.showToast({ title: res ? '已确认归还' : '归还未成功', icon: 'none' })
    if (res) setTimeout(() => wx.navigateBack(), 800)
  }
})
