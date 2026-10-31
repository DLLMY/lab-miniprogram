// pages/repair/repair.js
// 报修管理：报修记录归属具体实训室，由教师发起与处理。
// 服务端 addRepair / updateRepair 经 gStaff() 拦截（学生不可写）。
const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

const STATUS_ALL = ['全部', '待处理', '处理中', '已完成', '已取消']
const PRIORITIES = ['紧急', '一般', '低']
const CATEGORIES = ['设备故障', '环境设施', '安全隐患', '其他']

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
    // 新增报修
    showForm: false,
    form: { labId: '', labName: '', title: '', category: CATEGORIES[0], desc: '', priority: PRIORITIES[1] },
    labLabels: [],
    labIndex: 0,
    catLabels: CATEGORIES,
    catIndex: 0,
    priLabels: PRIORITIES,
    priIndex: 1,
    // 处理 / 关闭
    showProcess: false,
    processing: null,
    procForm: { status: '处理中', handlerId: '', handlerName: '', resolvedNote: '' },
    procStatusLabels: ['处理中', '已完成', '已取消'],
    procStatusIndex: 0
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
    const list = await api.call('listRepairs', { labId: f, status: s })
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

  // —— 新增报修 ——
  openAdd() {
    const idx = this.data.labs.findIndex(l => ('' + l.id).toUpperCase() === this.data.filterLabId)
    this.setData({
      showForm: true,
      form: { labId: this.data.filterLabId, labName: idx >= 0 ? this.data.labs[idx].name : '', title: '', category: CATEGORIES[0], desc: '', priority: PRIORITIES[1] },
      labIndex: idx >= 0 ? idx : 0,
      catIndex: 0, priIndex: 1
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
  onDesc(e) { this.setData({ 'form.desc': e.detail.value }) },
  onCat(e) { this.setData({ catIndex: Number(e.detail.value), 'form.category': CATEGORIES[Number(e.detail.value)] }) },
  onPri(e) { this.setData({ priIndex: Number(e.detail.value), 'form.priority': PRIORITIES[Number(e.detail.value)] }) },

  async save() {
    const f = this.data.form
    if (!f.title || !f.title.trim()) { wx.showToast({ title: '请填写报修内容', icon: 'none' }); return }
    if (!f.labId) { wx.showToast({ title: '请选择归属实训室', icon: 'none' }); return }
    const payload = {
      labId: ('' + f.labId).trim().toUpperCase(),
      labName: f.labName || '',
      title: f.title.trim(),
      category: f.category,
      desc: (f.desc || '').trim(),
      priority: f.priority,
      actor: this.data.me.id,
      reporterName: this.data.me.name
    }
    wx.showLoading({ title: '提交中', mask: true })
    api.warnIfDemo()
    const r = await api.callFull('addRepair', payload, { noFallback: true })
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: '已提交报修', icon: 'success' })
      this.setData({ showForm: false })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '提交失败', icon: 'none' })
    }
  },

  // —— 处理 / 关闭 ——
  openProcess(e) {
    const item = e.currentTarget.dataset.item
    this.setData({
      showProcess: true,
      processing: item,
      procForm: {
        status: item.status === '待处理' ? '处理中' : item.status,
        handlerId: this.data.me.id,
        handlerName: this.data.me.name,
        resolvedNote: item.resolvedNote || ''
      },
      procStatusIndex: item.status === '待处理' ? 0 : (item.status === '已完成' ? 1 : 2)
    })
  },
  closeProcess() { this.setData({ showProcess: false }) },
  onProcStatus(e) {
    const i = Number(e.detail.value)
    this.setData({ procStatusIndex: i, 'procForm.status': ['处理中', '已完成', '已取消'][i] })
  },
  onResolvedNote(e) { this.setData({ 'procForm.resolvedNote': e.detail.value }) },

  async saveProcess() {
    const item = this.data.processing
    if (!item) return
    const pf = this.data.procForm
    const payload = {
      id: item.id,
      status: pf.status,
      handlerId: pf.handlerId,
      handlerName: pf.handlerName,
      resolvedNote: (pf.resolvedNote || '').trim()
    }
    wx.showLoading({ title: '处理中', mask: true })
    api.warnIfDemo()
    const r = await api.callFull('updateRepair', payload, { noFallback: true })
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: '已更新', icon: 'success' })
      this.setData({ showProcess: false })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '操作失败', icon: 'none' })
    }
  }
})
