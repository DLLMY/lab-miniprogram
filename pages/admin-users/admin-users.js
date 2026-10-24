// pages/admin-users/admin-users.js
// 仅管理员可用的用户与角色管理页：列表 / 新增 / 编辑 / 删除。
// 服务端 adminListUsers / adminUpsertUser / adminDeleteUser 均经 gAdmin() 拦截，非管理员调用返回 403。
const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

const ROLES = [
  { k: 'student', label: '学生' },
  { k: 'teacher', label: '教师' },
  { k: 'admin', label: '管理员' }
]
const STATUSES = ['启用', '停用']

Page({
  data: {
    users: [],
    loading: false,
    showForm: false,
    editing: null,                                   // 正在编辑的 rid；null = 新增
    form: { id: '', name: '', role: 'student', cls: '', status: '启用' },
    roleIndex: 0,
    statusIndex: 0,
    roleLabels: ROLES.map(r => r.label),
    statusLabels: STATUSES
  },

  onShow() { this.load() },

  async load() {
    this.setData({ loading: true })
    const list = await api.call('adminListUsers', {})
    this.setData({ users: Array.isArray(list) ? list : [], loading: false })
  },

  openAdd() {
    this.setData({
      showForm: true,
      editing: null,
      form: { id: '', name: '', role: 'student', cls: '', status: '启用' },
      roleIndex: 0,
      statusIndex: 0
    })
  },

  openEdit(e) {
    const u = e.currentTarget.dataset.u
    const roleIndex = Math.max(0, ROLES.findIndex(r => r.k === u.role))
    const statusIndex = u.status === '停用' ? 1 : 0
    this.setData({
      showForm: true,
      editing: u.rid,
      form: { id: u.id, name: u.name, role: u.role, cls: u.cls || '', status: u.status || '启用' },
      roleIndex,
      statusIndex
    })
  },

  closeForm() { this.setData({ showForm: false }) },
  noop() {},

  onId(e) { this.setData({ 'form.id': e.detail.value }) },
  onName(e) { this.setData({ 'form.name': e.detail.value }) },
  onCls(e) { this.setData({ 'form.cls': e.detail.value }) },
  onRole(e) {
    const i = Number(e.detail.value)
    this.setData({ roleIndex: i, 'form.role': ROLES[i].k })
  },
  onStatus(e) {
    const i = Number(e.detail.value)
    this.setData({ statusIndex: i, 'form.status': STATUSES[i] })
  },

  async save() {
    const f = this.data.form
    const payload = {
      id: f.id.trim(),
      name: f.name.trim(),
      role: f.role,
      cls: f.cls.trim(),
      status: f.status
    }
    if (!payload.id || !payload.name) {
      wx.showToast({ title: '工号和姓名必填', icon: 'none' })
      return
    }
    wx.showLoading({ title: '保存中' })
    const r = await api.callFull('adminUpsertUser', payload)
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: this.data.editing ? '已更新' : '已新增', icon: 'success' })
      this.setData({ showForm: false })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '保存失败', icon: 'none' })
    }
  },

  async del(e) {
    const u = e.currentTarget.dataset.u
    const me = identity.current()
    if (me && ('' + me.id).toUpperCase() === ('' + u.id).toUpperCase()) {
      wx.showToast({ title: '不能删除当前登录账号', icon: 'none' })
      return
    }
    const ok = await new Promise(res => wx.showModal({
      title: '删除用户',
      content: '确定删除 ' + u.id + '（' + u.name + '）？其历史领用 / 借还记录保留。',
      confirmText: '删除',
      confirmColor: '#DC2626',
      success: r => res(r.confirm)
    }))
    if (!ok) return
    wx.showLoading({ title: '删除中' })
    const r = await api.callFull('adminDeleteUser', { id: u.id })
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: '已删除', icon: 'success' })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '删除失败', icon: 'none' })
    }
  }
})
