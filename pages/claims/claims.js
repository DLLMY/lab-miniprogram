const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')
const exporter = require('../../utils/export.js')

const PAGE = 50

// 领用记录查询（教师 / 管理员）
// 老师此前无法回答"我班上学生领用了什么耗材"：
//   · io 页是出入库操作台（登记/冲销），不是查询台；
//   · approve 页只看待审批，审批完那单就消失了；
//   · usage 页是聚合统计（趋势/排行），看不到逐条明细；
//   · logs 页是操作日志（谁做了什么动作），不是业务明细。
// 本页以「领用申请单」为主表，按班级/物品/领用人/状态/时间筛选，
// 老师一眼看清"哪个班、谁、领了什么、多少、用途是什么"。
// 按指定字段去重（保留首次出现的顺序）：分页累加时防止新数据插入导致的行重复
function dedupeByKey(list, field) {
  const seen = {}
  const out = []
  for (const x of list || []) {
    const k = '' + (x[field] || '')
    if (!k) { out.push(x); continue }
    if (seen[k]) continue
    seen[k] = 1
    out.push(x)
  }
  return out
}

Page({
  data: {
    allow: false,
    roleText: '未登录',
    rows: [],
    total: 0,
    offset: 0,
    hasMore: false,
    loading: false,
    loadErr: false,
    // 筛选
    fCls: '',
    fItem: '',
    fUser: '',
    fStatus: '',
    fFrom: '',
    fTo: '',
    clsOptions: ['全部班级'],
    // 与后端原始状态一致：撤销写的是「已撤销」（下发前端归一为 canceled），此前筛不到这一类
    statusOptions: ['全部状态', '待审批', '已通过', '已拒绝', '已撤销'],
    // 按班级汇总（老师最关心"哪个班领了多少"）
    byCls: [],
    // 展开的明细行（显示用途/审批人/驳回原因）
    openNo: '',
    // 审批撤销（管理员专属，会回补库存/结清借还，高风险）
    isAdmin: false,
    showRevoke: false, revokeNo: '', revokeWhy: '',
    revokePresets: ['误批，申请人已取消', '重复审批', '信息填写错误', '库存核对后需重批']
  },
  onShow() {
    identity.syncGlobal()
    const i = identity.current()
    const allow = identity.isStaff()
    this.setData({ allow, isAdmin: identity.isAdmin(), roleText: i ? identity.roleText(i.role) : '未登录' })
    if (allow) this.load(true)
  },
  switchAccount() { identity.switchAccount() },
  // 期末对账/上报教务要的是领用明细，此前后端支持 requisitions 导出但前端没有任何入口
  exportClaims() { exporter.run('requisitions', false, '正在导出领用单…') },
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    if (!this.data.allow) { done(); return }
    api.call('fresh', {}).then(() => this.load(true)).then(done, done)
  },
  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.load(false)
  },
  // WXML 的「加载更多」按钮此前绑定了本方法却从未实现，点击无任何反应；只能靠触底加载。
  // 与触底走同一条路径，保持分页游标与防连点口径一致。
  loadMore() { if (!this.data.loading && this.data.hasMore) this.load(false) },
  buildFilter() {
    const d = this.data
    const from = d.fFrom ? new Date(d.fFrom + 'T00:00:00+08:00').getTime() : 0
    const to = d.fTo ? new Date(d.fTo + 'T23:59:59+08:00').getTime() : 0
    return {
      cls: (d.fCls && d.fCls !== '全部班级') ? d.fCls : '',
      item: (d.fItem || '').trim(),
      user: (d.fUser || '').trim(),
      status: (d.fStatus && d.fStatus !== '全部状态') ? d.fStatus : '',
      from, to
    }
  },
  async load(reset) {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const f = this.buildFilter()
      const d = await api.call('listClaims', Object.assign({}, f, {
        limit: PAGE, offset: reset ? 0 : this.data.offset
      }))
      if (d === null) { this.setData({ loading: false, loadErr: true }); return }
      const rows = (d && d.rows) || []
      const mapped = rows.map((r, i) => ({
        key: (r.no || ('c' + i + '_' + Date.now())),
        no: r.no, itemName: r.itemName || r.item, qty: r.qty, unit: r.unit || '',
        userName: r.userName || r.user, user: r.user, cls: r.cls || '',
        reason: r.reason || '', reject: r.reject || '', approver: r.approver || '',
        status: r.status || '', time: r.time || '',
        pending: r.status === 'pending' || r.status === '待审批',
        approved: r.status === 'approved' || r.status === '已通过',
        rejected: r.status === 'rejected' || r.status === '已拒绝',
        canceled: r.status === 'canceled' || r.status === '已撤销' || r.status === '已撤回'
      }))
      // 累加去重：翻页期间新增申请单会顶到列表头，使分页偏移错位、末行重复出现
      const list = reset ? mapped : dedupeByKey(this.data.rows.concat(mapped), 'key')
      const total = (d && Number(d.total)) || list.length
      // 班级下拉：服务端给的 classOptions 是当前可见范围内的班级
      const opts = ['全部班级'].concat((d && d.classOptions) || [])
      this.setData({
        rows: list,
        total,
        offset: list.length,
        hasMore: !!(d && d.hasMore),
        byCls: (d && d.byCls) || [],
        clsOptions: opts
      })
    } finally {
      this.setData({ loading: false })
    }
  },
  onClsFilter(e) {
    const i = Number(e.detail.value) || 0
    this.setData({ fCls: this.data.clsOptions[i] || '' })
    this.load(true)
  },
  onStatusFilter(e) {
    const i = Number(e.detail.value) || 0
    this.setData({ fStatus: this.data.statusOptions[i] || '' })
    this.load(true)
  },
  onItem(e) {
    this.setData({ fItem: e.detail.value })
    this.debounced()
  },
  onUser(e) {
    this.setData({ fUser: e.detail.value })
    this.debounced()
  },
  onFrom(e) { this.setData({ fFrom: e.detail.value }); this.load(true) },
  onTo(e) { this.setData({ fTo: e.detail.value }); this.load(true) },
  debounced() {
    if (this._t) clearTimeout(this._t)
    this._t = setTimeout(() => this.load(true), 300)
  },
  resetFilter() {
    this.setData({ fCls: '', fItem: '', fUser: '', fStatus: '', fFrom: '', fTo: '' })
    this.load(true)
  },
  // 展开/收起明细（用途、审批人、驳回原因）
  toggle(e) {
    const no = '' + (e.currentTarget.dataset.no || '')
    this.setData({ openNo: this.data.openNo === no ? '' : no })
  },

  /* ---------- 审批撤销（管理员）---------- */
  openRevoke(e) {
    if (!this.data.isAdmin) return
    const no = '' + (e.currentTarget.dataset.no || '')
    this.setData({ showRevoke: true, revokeNo: no, revokeWhy: '' })
  },
  closeRevoke() { this.setData({ showRevoke: false, revokeNo: '', revokeWhy: '' }) },
  noop() {},
  revokeInput(e) { this.setData({ revokeWhy: e.detail.value }) },
  pickRevoke(e) {
    const v = e.currentTarget.dataset.v
    this.setData({ revokeWhy: this.data.revokeWhy === v ? '' : v })
  },
  async submitRevoke() {
    const no = this.data.revokeNo
    if (!no) return
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效', icon: 'none' }); return }
    const why = (this.data.revokeWhy || '').trim() || '审批撤销'
    if (this.data._revokeBusy) return
    this.setData({ _revokeBusy: true })
    api.warnIfDemo()
    wx.showLoading({ title: '撤销中…', mask: true })
    let r = null
    try {
      r = await api.callFull('revokeApprove', { no, reason: why, actor: me.id }, { noFallback: true })
    } finally {
      wx.hideLoading()
      this.setData({ _revokeBusy: false })
    }
    if (r && r.code === 0) {
      const d = r.data || {}
      this.setData({ showRevoke: false, revokeNo: '', revokeWhy: '' })
      await this.load(true)
      if (d.warn) {
        // 回滚没生效时不能只弹「已撤销」的绿色提示——否则库存没回来却无人察觉
        wx.showModal({
          title: '已撤销，但需人工核对',
          content: d.warn + '。申请单已标记为「已撤销」，请到库存页核对实物与账面。',
          showCancel: false,
          confirmText: '知道了'
        })
        return
      }
      wx.showToast({ title: d.rolledBack ? '已撤销并回滚' : '已撤销', icon: 'success' })
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '撤销失败', icon: 'none' })
    }
  }
})
