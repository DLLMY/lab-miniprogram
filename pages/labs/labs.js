// pages/labs/labs.js
// 实训室归属管理中枢：列表 + 详情（位置 / 负责人 / 报修 / 巡检 统一查询）。
// 实训室 CRUD、负责人设置 = 管理员专属（服务端 gAdmin 拦截）；其余教师可查看。
const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

const STATUSES = ['启用', '停用']
const STAFF_ROLES = ['teacher']

function cleanLab() {
  return {
    id: '', name: '', campus: '', building: '', floor: '', roomNo: '',
    address: '', lng: '', lat: '', managerId: '', managerName: '',
    status: '启用', note: ''
  }
}

Page({
  data: {
    isStaff: false,
    isAdmin: false,
    mode: 'list',                 // list | detail
    denied: false,
    labs: [],
    current: null,               // labOverview 结果 {lab, repairs, inspections}
    loading: false,
    // 表单（新增 / 编辑实训室）
    showForm: false,
    editing: false,
    form: cleanLab(),
    statusLabels: STATUSES,
    statusIndex: 0,
    managers: [],
    managerLabels: [],
    managerIndex: 0
  },

  onLoad(options) {
    this.setData({
      isStaff: identity.isStaff(),
      isAdmin: identity.isAdmin()
    })
    if (!this.data.isStaff) { this.setData({ denied: true }); return }
    if (options && options.id) {
      this.setData({ mode: 'detail' })
      this.loadDetail(options.id)
    } else {
      this.setData({ mode: 'list' })
      this.loadList()
    }
  },

  onShow() {
    if (this.data.denied) return
    if (this.data.mode === 'detail' && this.data.current) this.loadDetail(this.data.current.lab.id)
    else this.loadList()
  },

  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    api.call('fresh', {}).then(() => {
      if (this.data.mode === 'detail' && this.data.current) this.loadDetail(this.data.current.lab.id)
      else this.loadList()
    }).then(done, done)
  },

  async loadList() {
    this.setData({ loading: true })
    const list = await api.call('listLabs', {})
    this.setData({ labs: Array.isArray(list) ? list : [], loading: false })
  },

  async loadDetail(id) {
    this.setData({ loading: true })
    const ov = await api.call('labOverview', { labId: id })
    this.setData({ current: ov || { lab: null, repairs: [], inspections: [] }, loading: false })
  },

  back() {
    this.setData({ mode: 'list', current: null })
    this.loadList()
  },

  tapLab(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ mode: 'detail' })
    this.loadDetail(id)
  },

  // —— 负责人候选：教师 / 管理员 / 超级管理员 均可被设为实训室负责人 ——
  async loadManagers() {
    const list = await api.call('adminListUsers', {})
    const staff = (Array.isArray(list) ? list : []).filter(u => STAFF_ROLES.indexOf(u.role) >= 0)
    const labels = staff.map(u => u.name + '（' + u.id + '）')
    this.setData({ managers: staff, managerLabels: labels, managerIndex: 0 })
  },

  openAdd() {
    this.loadManagers()
    this.setData({
      showForm: true, editing: false,
      form: cleanLab(),
      statusIndex: 0, managerIndex: 0
    })
  },

  openEdit() {
    const lab = this.data.current && this.data.current.lab
    if (!lab) return
    this.loadManagers()
    const idx = this.data.managers.findIndex(m => ('' + m.id).toUpperCase() === ('' + lab.managerId).toUpperCase())
    const statusIndex = (lab.status === '停用') ? 1 : 0
    this.setData({
      showForm: true, editing: true,
      form: {
        id: lab.id, name: lab.name || '', campus: lab.campus || '', building: lab.building || '',
        floor: lab.floor || '', roomNo: lab.roomNo || '', address: lab.address || '',
        lng: lab.lng || '', lat: lab.lat || '',
        managerId: lab.managerId || '', managerName: lab.managerName || '',
        status: lab.status || '启用', note: lab.note || ''
      },
      statusIndex, managerIndex: idx >= 0 ? idx : 0
    })
  },

  closeForm() { this.setData({ showForm: false }) },
  noop() {},

  onName(e) { this.setData({ 'form.name': e.detail.value }) },
  onCampus(e) { this.setData({ 'form.campus': e.detail.value }) },
  onBuilding(e) { this.setData({ 'form.building': e.detail.value }) },
  onFloor(e) { this.setData({ 'form.floor': e.detail.value }) },
  onRoomNo(e) { this.setData({ 'form.roomNo': e.detail.value }) },
  onAddress(e) { this.setData({ 'form.address': e.detail.value }) },
  onLng(e) { this.setData({ 'form.lng': e.detail.value }) },
  onLat(e) { this.setData({ 'form.lat': e.detail.value }) },
  onNote(e) { this.setData({ 'form.note': e.detail.value }) },
  onStatus(e) {
    const i = Number(e.detail.value)
    this.setData({ statusIndex: i, 'form.status': STATUSES[i] })
  },
  onManager(e) {
    const i = Number(e.detail.value)
    const m = this.data.managers[i]
    if (!m) return
    this.setData({ managerIndex: i, 'form.managerId': m.id, 'form.managerName': m.name })
  },

  async save() {
    const f = this.data.form
    if (!f.name || !f.name.trim()) {
      wx.showToast({ title: '请填写实训室名称', icon: 'none' })
      return
    }
    const payload = {
      name: f.name.trim(), campus: (f.campus || '').trim(), building: (f.building || '').trim(),
      floor: (f.floor || '').trim(), roomNo: (f.roomNo || '').trim(), address: (f.address || '').trim(),
      lng: Number(f.lng) || 0, lat: Number(f.lat) || 0,
      managerId: (f.managerId || '').trim(), managerName: (f.managerName || '').trim(),
      status: f.status || '启用', note: (f.note || '').trim()
    }
    if (this.data.editing) payload.id = ('' + f.id).trim().toUpperCase()
    wx.showLoading({ title: '保存中', mask: true })
    api.warnIfDemo()
    const r = await api.callFull(this.data.editing ? 'updateLab' : 'addLab', payload, { noFallback: true })
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: this.data.editing ? '已更新' : '已新增', icon: 'success' })
      this.setData({ showForm: false })
      if (this.data.mode === 'detail') this.loadDetail((payload.id || (this.data.current && this.data.current.lab.id)))
      else this.loadList()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '保存失败', icon: 'none' })
    }
  },

  async del() {
    const lab = this.data.current && this.data.current.lab
    if (!lab) return
    const ok = await new Promise(res => wx.showModal({
      title: '删除实训室',
      content: '将删除「' + lab.name + '」（' + lab.id + '）。其下报修 / 巡检记录不会被自动删除，但将失去归属关联。确定？',
      confirmText: '删除', confirmColor: '#DC2626',
      success: r => res(r.confirm)
    }))
    if (!ok) return
    wx.showLoading({ title: '删除中', mask: true })
    api.warnIfDemo()
    const r = await api.callFull('deleteLab', { id: ('' + lab.id).trim().toUpperCase() }, { noFallback: true })
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: '已删除', icon: 'success' })
      this.back()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '删除失败', icon: 'none' })
    }
  },

  goRepairs() {
    const lab = this.data.current && this.data.current.lab
    if (!lab) return
    wx.navigateTo({ url: '/pages/repair/repair?labId=' + encodeURIComponent(lab.id) })
  },
  goInspections() {
    const lab = this.data.current && this.data.current.lab
    if (!lab) return
    wx.navigateTo({ url: '/pages/inspection/inspection?labId=' + encodeURIComponent(lab.id) })
  }
})
