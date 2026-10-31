// pages/inspection/inspection.js
// 巡检管理：巡检任务按实训室分配、归属与跟踪，由教师执行。
// 服务端 addInspection / updateInspection 经 gStaff() 拦截（学生不可写）。
const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

const STATUS_ALL = ['全部', '待巡检', '已完成', '已逾期']

Page({
  data: {
    isStaff: false,
    denied: false,
    me: null,
    list: [],
    labs: [],
    filterLabId: '',
    filterStatus: '全部',
    filterStatusIndex: 0,
    statusLabels: STATUS_ALL,
    loading: false,
    // 新增巡检
    showForm: false,
    form: { labId: '', labName: '', title: '', planDate: '' },
    labLabels: [],
    labIndex: 0,
    // 执行 / 完成
    showExec: false,
    executing: null,
    resultText: ''
  },

  async onLoad(options) {
    const me = identity.current()
    this.setData({ isStaff: identity.isStaff(), me })
    if (!this.data.isStaff) { this.setData({ denied: true }); return }
    if (options && options.labId) this.setData({ filterLabId: ('' + options.labId).trim().toUpperCase() })
    await this.loadLabs()
    this.load()
  },

  onShow() {
    if (this.data.denied) return
    this.load()
  },

  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    api.call('fresh', {}).then(() => this.load()).then(done, done)
  },

  async loadLabs() {
    const labs = await api.call('listLabs', {})
    const arr = Array.isArray(labs) ? labs : []
    this.setData({ labs: arr, labLabels: arr.map(l => l.name + '（' + l.id + '）') })
  },

  async load() {
    this.setData({ loading: true })
    const f = this.data.filterLabId
    const s = this.data.filterStatus === '全部' ? '' : this.data.filterStatus
    const list = await api.call('listInspections', { labId: f, status: s })
    const labs = this.data.labs
    const arr = (Array.isArray(list) ? list : []).map(x => ({ ...x, labDeleted: !!(x.labId && !labs.find(l => ('' + l.id).trim().toUpperCase() === ('' + x.labId).trim().toUpperCase())) }))
    this.setData({ list: arr, loading: false })
  },

  onFilterLab(e) {
    const i = Number(e.detail.value)
    const lab = this.data.labs[i]
    this.setData({ labIndex: i, filterLabId: lab ? ('' + lab.id).toUpperCase() : '' }, () => this.load())
  },
  onFilterStatus(e) {
    const i = Number(e.detail.value)
    this.setData({ filterStatusIndex: i, filterStatus: STATUS_ALL[i] }, () => this.load())
  },

  // —— 新增巡检任务 ——
  openAdd() {
    const idx = this.data.labs.findIndex(l => ('' + l.id).toUpperCase() === this.data.filterLabId)
    this.setData({
      showForm: true,
      form: { labId: this.data.filterLabId, labName: idx >= 0 ? this.data.labs[idx].name : '', title: '', planDate: '' },
      labIndex: idx >= 0 ? idx : 0
    })
  },
  closeForm() { this.setData({ showForm: false }) },
  noop() {},
  onLab(e) {
    const i = Number(e.detail.value)
    const lab = this.data.labs[i]
    this.setData({ labIndex: i, 'form.labId': lab ? ('' + lab.id).toUpperCase() : '', 'form.labName': lab ? lab.name : '' })
  },
  onTitle(e) { this.setData({ 'form.title': e.detail.value }) },
  onPlanDate(e) { this.setData({ 'form.planDate': e.detail.value }) },

  async save() {
    const f = this.data.form
    if (!f.title || !f.title.trim()) { wx.showToast({ title: '请填写巡检任务名称', icon: 'none' }); return }
    if (!f.labId) { wx.showToast({ title: '请选择归属实训室', icon: 'none' }); return }
    const payload = {
      labId: ('' + f.labId).trim().toUpperCase(),
      labName: f.labName || '',
      title: f.title.trim(),
      planDate: f.planDate || '',
      actor: this.data.me.id,
      executorName: this.data.me.name
    }
    wx.showLoading({ title: '提交中', mask: true })
    api.warnIfDemo()
    const r = await api.callFull('addInspection', payload, { noFallback: true })
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: '已下发巡检', icon: 'success' })
      this.setData({ showForm: false })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '提交失败', icon: 'none' })
    }
  },

  // —— 执行 / 完成 ——
  openExec(e) {
    const item = e.currentTarget.dataset.item
    this.setData({ showExec: true, executing: item, resultText: item.result || '' })
  },
  closeExec() { this.setData({ showExec: false }) },
  onResult(e) { this.setData({ resultText: e.detail.value }) },

  async saveExec() {
    const item = this.data.executing
    if (!item) return
    const payload = {
      id: item.id,
      status: '已完成',
      result: (this.data.resultText || '').trim(),
      executorId: this.data.me.id,
      executorName: this.data.me.name
    }
    wx.showLoading({ title: '提交中', mask: true })
    api.warnIfDemo()
    const r = await api.callFull('updateInspection', payload, { noFallback: true })
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: '已记录巡检结果', icon: 'success' })
      this.setData({ showExec: false })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '操作失败', icon: 'none' })
    }
  }
})
