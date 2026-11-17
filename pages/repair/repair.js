// pages/repair/repair.js
// 报修管理：报修记录归属具体实训室，由教师发起与处理。
// 服务端 addRepair / updateRepair 经 gStaff() 拦截（学生不可写）。
const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')
const staff = require('../../utils/staff.js')

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
    labLabels: [],        // 筛选 picker：首位是「全部实训室」
    formLabLabels: [],    // 表单 picker：只列真实实训室，不允许选「全部」
    filterLabIndex: 0,
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
    procStatusIndex: 0,
    // 处理人（指派）：后端 updateRepair 本就接受 handlerId/handlerName，
    // 此前前端写死成"我自己"，导致报修单无法派给同事。
    handlerOptions: [], handlerLabels: [], handlerIndex: 0, handlerOnlySelf: false
  },

  async onLoad(options) {
    const me = identity.current()
    this.setData({ isStaff: identity.isStaff(), me })
    if (!this.data.isStaff) { this.setData({ denied: true }); return }
    if (options && options.labId) this.setData({ filterLabId: ('' + options.labId).trim().toUpperCase() })
    await this.loadLabs()
    // 实训室字典就绪后才允许查询：onShow 会紧随 onLoad 同步触发，若那时 labs 仍为空，
    // 列表会把每条报修都误判成「实训室已删除」，且慢返回的旧请求可能覆盖正确结果。
    this._labsReady = true
    this.load()
  },

  onShow() {
    if (this.data.denied || !this._labsReady) return
    this.load()
  },

  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    api.call('fresh', {}).then(() => this.load()).then(done, done)
  },

  async loadLabs() {
    const labs = await api.call('listLabs', {})
    const arr = Array.isArray(labs) ? labs : []
    // picker 与 filterLabId 必须同步：此前首屏查的是「全部」，picker 却显示第一个实训室。
    const idx = arr.findIndex(l => ('' + l.id).trim().toUpperCase() === this.data.filterLabId)
    this.setData({
      labs: arr,
      labLabels: ['全部实训室'].concat(arr.map(l => l.name + '（' + l.id + '）')),
      formLabLabels: arr.map(l => l.name + '（' + l.id + '）'),
      filterLabIndex: idx >= 0 ? idx + 1 : 0
    })
  },

  async load() {
    this.setData({ loading: true, loadErr: false })
    const f = this.data.filterLabId
    const s = this.data.filterStatus === '全部' ? '' : this.data.filterStatus
    const list = await api.call('listRepairs', { labId: f, status: s })
    if (list === null) { this.setData({ loading: false, loadErr: true }); return }
    const labs = this.data.labs
    const arr = (Array.isArray(list) ? list : []).map(x => ({ ...x, labDeleted: !!(x.labId && !labs.find(l => ('' + l.id).trim().toUpperCase() === ('' + x.labId).trim().toUpperCase())) }))
    this.setData({ list: arr, loading: false })
  },

  onFilterLab(e) {
    const i = Number(e.detail.value)
    const lab = this.data.labs[i - 1]   // 0 = 全部实训室
    this.setData({ filterLabIndex: i, filterLabId: lab ? ('' + lab.id).toUpperCase() : '' }, () => this.load())
  },
  onFilterStatus(e) {
    const i = Number(e.detail.value)
    this.setData({ filterStatusIndex: i, filterStatus: STATUS_ALL[i] }, () => this.load())
  },

  // —— 新增报修 ——
  openAdd() {
    const found = this.data.labs.findIndex(l => ('' + l.id).toUpperCase() === this.data.filterLabId)
    // 没有预选时默认第一间实训室，避免 picker 显示着第一间、提交却提示「请选择实训室」
    const idx = found >= 0 ? found : (this.data.labs.length ? 0 : -1)
    const lab = this.data.labs[idx]
    this.setData({
      showForm: true,
      form: { labId: lab ? ('' + lab.id).toUpperCase() : '', labName: lab ? lab.name : '', title: '', category: CATEGORIES[0], desc: '', priority: PRIORITIES[1] },
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
      const idemW = api.idemWarn(r)
      wx.showToast({ title: idemW || '已提交报修', icon: idemW ? 'none' : 'success' })
      this.setData({ showForm: false })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '提交失败', icon: 'none' })
    }
  },

  // —— 处理 / 关闭 ——
  async openProcess(e) {
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
    await this.loadHandlers(item)
  },
  // 载入处理人候选：已派给别人的单据默认定位到该处理人，而不是一律"我自己"。
  // ⚠ 必须同时把 procForm.handlerId/Name 一起同步：否则 picker 明明显示"张老师"，
  //   提交时却仍带着自己的工号 → 一次保存就把别人派的活改回自己（静默错派）。
  async loadHandlers(item) {
    const list = await staff.loadStaffCandidates()
    const labels = list.map(u => u.name + '（' + u.id + '）' + (u.self ? ' · 我' : ''))
    let idx = 0
    const cur = ('' + ((item && item.handlerId) || '')).trim().toUpperCase()
    if (cur) {
      const i = list.findIndex(u => ('' + u.id).trim().toUpperCase() === cur)
      if (i >= 0) idx = i
    }
    const picked = list[idx] || null
    this.setData({
      handlerOptions: list,
      handlerLabels: labels,
      handlerIndex: idx,
      handlerOnlySelf: staff.onlySelf(list)
    })
    if (picked) {
      this.setData({
        'procForm.handlerId': picked.id,
        'procForm.handlerName': picked.name
      })
    }
  },
  onHandler(e) {
    const i = Number(e.detail.value)
    const u = this.data.handlerOptions[i]
    if (!u) return
    this.setData({
      handlerIndex: i,
      'procForm.handlerId': u.id,
      'procForm.handlerName': u.name
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
