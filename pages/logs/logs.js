const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')
const exporter = require('../../utils/export.js')

const PAGE = 50

// 操作日志查询（管理员）
// logs 表一直在写，但此前只能在腾讯文档里看；出了事要回答"谁在什么时候做了什么"，
// 在系统内没有任何入口——这是审计能力上的硬缺口。
Page({
  data: {
    allow: false,
    roleText: '未登录',
    // tab: log=操作日志 / access=门禁记录（P3-㉑：门禁表此前只在腾讯文档里能看到）
    tab: 'log',
    rows: [],
    total: 0,
    offset: 0,
    hasMore: false,
    loading: false,
    // 筛选
    fActor: '',
    fTarget: '',
    fOp: '',
    fFrom: '',
    fTo: '',
    opOptions: ['全部操作类型', '入库登记', '出库登记', '审批通过', '审批拒绝', '提交领用申请', '提交工具借出申请',
      '工具借出', '归还工具', '编辑用户', '删除用户', '期初建账', '库存盘点', '冲销出入库流水', '撤销申请']
  },
  onShow() {
    identity.syncGlobal()
    const i = identity.current()
    const allow = identity.isAdmin()
    this.setData({ allow, roleText: i ? identity.roleText(i.role) : '未登录' })
    if (allow) this.load(true)
  },
  setTab(e) {
    const t = e.currentTarget.dataset.t === 'access' ? 'access' : 'log'
    this.setData({ tab: t, fActor: '', fTarget: '', fOp: '', fFrom: '', fTo: '' })
    this.load(true)
  },
  switchAccount() { identity.switchAccount() },
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    if (!this.data.allow) { done(); return }
    api.call('fresh', {}).then(() => this.load(true)).then(done, done)
  },
  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.load(false)
  },
  buildFilter() {
    const d = this.data
    const from = d.fFrom ? new Date(d.fFrom + 'T00:00:00+08:00').getTime() : 0
    const to = d.fTo ? new Date(d.fTo + 'T23:59:59+08:00').getTime() : 0
    if (d.tab === 'access') {
      // 门禁表按「用户 / 门禁点」筛选，没有操作类型这一维度
      return { user: (d.fActor || '').trim(), point: '', from, to }
    }
    return {
      actor: (d.fActor || '').trim(),
      target: (d.fTarget || '').trim(),
      op: d.fOp && d.fOp !== '全部操作类型' ? d.fOp : '',
      from, to
    }
  },
  async load(reset) {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const f = this.buildFilter()
      const action = this.data.tab === 'access' ? 'listAccess' : 'listLogs'
      const d = await api.call(action, Object.assign({}, f, {
        limit: PAGE, offset: reset ? 0 : this.data.offset
      }))
      const rows = (d && d.rows) || []
      const mapped = rows.map((r, i) => (this.data.tab === 'access' ? {
        key: (r.id || ('a' + i + '_' + Date.now())),
        id: r.id, time: r.time, actor: r.user, op: (r.point || '门禁'), target: '', result: r.result,
        failed: /失败|拒绝|异常/.test('' + (r.result || ''))
      } : {
        key: (r.id || ('r' + i + '_' + Date.now())),
        id: r.id, time: r.time, actor: r.actor, op: r.op, target: r.target, result: r.result,
        // 结果列为准的成功/失败着色：便于快速扫出失败项（排障时最关心的那几行）
        failed: /失败|未生效|不足/.test('' + (r.result || ''))
      }))
      const list = reset ? mapped : this.data.rows.concat(mapped)
      const total = (d && Number(d.total)) || list.length
      this.setData({
        rows: list,
        total,
        offset: list.length,
        hasMore: !!(d && d.hasMore)
      })
    } finally {
      this.setData({ loading: false })
    }
  },
  loadMore() { this.load(false) },
  onFilter(e) {
    const k = e.currentTarget.dataset.k
    this.setData({ [k]: e.detail.value })
    this.debounced()
  },
  onOpFilter(e) {
    const i = Number(e.detail.value) || 0
    this.setData({ fOp: this.data.opOptions[i] || '' })
    this.load(true)
  },
  onFrom(e) { this.setData({ fFrom: e.detail.value }); this.load(true) },
  onTo(e) { this.setData({ fTo: e.detail.value }); this.load(true) },
  debounced() {
    if (this._t) clearTimeout(this._t)
    this._t = setTimeout(() => this.load(true), 300)
  },
  resetFilter() {
    this.setData({ fActor: '', fTarget: '', fOp: '', fFrom: '', fTo: '' })
    this.load(true)
  },
  exportLogs() {
    exporter.run(this.data.tab === 'access' ? 'access' : 'logs', false, '正在导出…')
  }
})
