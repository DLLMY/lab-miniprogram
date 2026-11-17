// pages/inspection/inspection.js
// 巡检管理：巡检任务按实训室分配、归属与跟踪，由教师执行。
// 服务端 addInspection / updateInspection 经 gStaff() 拦截（学生不可写）。
const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')
const staff = require('../../utils/staff.js')

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
    form: { labId: '', labName: '', title: '', planDate: '', executorId: '', executorName: '' },
    // 新建时可直接指定执行人（后端 addInspection 已支持 executorId）
    formExecLabels: [], formExecIndex: 0,
    labLabels: [],        // 筛选 picker：首位是「全部实训室」
    formLabLabels: [],    // 表单 picker：只列真实实训室
    filterLabIndex: 0,
    labIndex: 0,
    // 执行 / 完成
    showExec: false,
    executing: null,
    resultText: '',
    // 指派执行人：后端 updateInspection 本就接受 executorId/executorName，
    // 此前前端写死成"我自己"，巡检任务下发不出去。
    showAssign: false, assigning: null,
    execOptions: [], execLabels: [], execIndex: 0, execOnlySelf: false
  },

  async onLoad(options) {
    const me = identity.current()
    this.setData({ isStaff: identity.isStaff(), me })
    if (!this.data.isStaff) { this.setData({ denied: true }); return }
    if (options && options.labId) this.setData({ filterLabId: ('' + options.labId).trim().toUpperCase() })
    await this.loadLabs()
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
    // 与报修页一致：picker 索引与 filterLabId 同步，避免「显示已筛选、实际查全部」。
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
    const list = await api.call('listInspections', { labId: f, status: s })
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

  // —— 新增巡检任务 ——
  async openAdd() {
    const found = this.data.labs.findIndex(l => ('' + l.id).toUpperCase() === this.data.filterLabId)
    const idx = found >= 0 ? found : (this.data.labs.length ? 0 : -1)
    const lab = this.data.labs[idx]
    const me = identity.current()
    this.setData({
      showForm: true,
      form: {
        labId: lab ? ('' + lab.id).toUpperCase() : '', labName: lab ? lab.name : '',
        title: '', planDate: '',
        executorId: me ? me.id : '', executorName: me ? me.name : ''
      },
      labIndex: idx >= 0 ? idx : 0
    })
    // 执行人候选：默认自己，可改派给同事
    const list = await staff.loadStaffCandidates()
    const labels = list.map(u => u.name + '（' + u.id + '）' + (u.self ? ' · 我' : ''))
    let ei = 0
    if (me) {
      const i = list.findIndex(u => ('' + u.id).trim().toUpperCase() === ('' + me.id).trim().toUpperCase())
      if (i >= 0) ei = i
    }
    this.setData({ execOptions: list, execLabels: labels, formExecIndex: ei })
  },
  onFormExec(e) {
    const i = Number(e.detail.value)
    const u = (this.data.execOptions || [])[i]
    this.setData({ formExecIndex: i })
    if (u) this.setData({ 'form.executorId': u.id, 'form.executorName': u.name })
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
      executorId: f.executorId || this.data.me.id,
      executorName: f.executorName || this.data.me.name
    }
    wx.showLoading({ title: '提交中', mask: true })
    api.warnIfDemo()
    const r = await api.callFull('addInspection', payload, { noFallback: true })
    wx.hideLoading()
    if (r && r.code === 0) {
      const idemW = api.idemWarn(r)
      wx.showToast({ title: idemW || '已下发巡检', icon: idemW ? 'none' : 'success' })
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

  /* ---------- 指派执行人 ----------
     「下发巡检」此前只能建给自己（后端 addInspection 把 executorId 固定为创建人），
     现在改为：任务建好后可直接指派给具体老师（后端 updateInspection 支持改执行人）。 */
  async openAssign(e) {
    const item = e.currentTarget.dataset.item
    this.setData({ showAssign: true, assigning: item })
    const list = await staff.loadStaffCandidates()
    const labels = list.map(u => u.name + '（' + u.id + '）' + (u.self ? ' · 我' : ''))
    let idx = 0
    const cur = ('' + ((item && item.executorId) || '')).trim().toUpperCase()
    if (cur) {
      const i = list.findIndex(u => ('' + u.id).trim().toUpperCase() === cur)
      if (i >= 0) idx = i
    }
    this.setData({
      execOptions: list, execLabels: labels, execIndex: idx,
      execOnlySelf: staff.onlySelf(list)
    })
  },
  closeAssign() { this.setData({ showAssign: false }) },
  onExecPick(e) {
    const i = Number(e.detail.value)
    const u = this.data.execOptions[i]
    if (!u) return
    this.setData({ execIndex: i })
  },

  async submitAssign() {
    if (this.data.assignBusy) return
    const item = this.data.assigning
    const u = this.data.execOptions[this.data.execIndex]
    if (!item || !u) return
    const me = identity.current()
    this.setData({ assignBusy: true })
    wx.showLoading({ title: '指派中…', mask: true })
    let r = null
    try {
      r = await api.callFull('updateInspection', {
        id: item.id,
        executorId: u.id,
        executorName: u.name,
        actor: me ? me.id : ''
      }, { noFallback: true })
    } catch (e) {
      r = null
    } finally {
      wx.hideLoading()
      this.setData({ assignBusy: false })
    }
    if (r && r.code === 0) {
      wx.showToast({ title: '已指派给 ' + u.name, icon: 'success' })
      this.setData({ showAssign: false, assigning: null })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '指派失败，请重试', icon: 'none' })
    }
  },

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
