// pages/admin-users/admin-users.js
// 仅管理员可用的用户与角色管理页：列表 / 新增 / 编辑 / 删除。
// 服务端 adminListUsers / adminUpsertUser / adminDeleteUser 均经 gAdmin() 拦截，非管理员调用返回 403。
const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

const ROLES = [
  { k: 'student', label: '学生' },
  { k: 'teacher', label: '教师' },
  { k: 'admin', label: '管理员' },
  { k: 'super', label: '超级管理员' }
]
const STATUSES = ['启用', '停用']

// 角色可选项：非超级管理员看不到「超级管理员」项，避免越权授予（服务端同样会拦截）。
function visibleRoles(isSuper) {
  return isSuper ? ROLES : ROLES.filter(r => r.k !== 'super')
}

Page({
  data: {
    users: [],
    loading: false,
    showForm: false,
    isSuper: false,
    editing: null,                                   // 正在编辑的 rid；null = 新增
    form: { id: '', name: '', role: 'student', cls: '', status: '启用' },
    roleIndex: 0,
    statusIndex: 0,
    roleLabels: ROLES.map(r => r.label),
    statusLabels: STATUSES
  },

  onShow() {
    const isSuper = identity.isSuper()
    this.setData({
      isSuper,
      roleLabels: visibleRoles(isSuper).map(r => r.label)
    })
    this.load()
  },
  // 下拉刷新：先清云端读缓存再重取用户列表
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    api.call('fresh', {}).then(() => this.load()).then(done, done)
  },

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
    const roles = visibleRoles(this.data.isSuper)
    const roleIndex = Math.max(0, roles.findIndex(r => r.k === u.role))
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
    const roles = visibleRoles(this.data.isSuper)
    this.setData({ roleIndex: i, 'form.role': roles[i].k })
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
      status: f.status,
      // 编辑时带上行 ID（recordId）：服务端按 rid 精确定位，改工号时能查出「目标工号已被占用」
      rid: this.data.editing || ''
    }
    if (!payload.id || !payload.name) {
      wx.showToast({ title: '工号和姓名必填', icon: 'none' })
      return
    }
    // mask:true：保存期间阻断重复点击——否则快速双击会发两次 upsert（第二次虽幂等，
    // 但会重复刷新列表、Toast 抖动，且失败时的错误提示会被后一次覆盖）
    wx.showLoading({ title: '保存中', mask: true })
    api.warnIfDemo()
    const r = await api.callFull('adminUpsertUser', payload, { noFallback: true })
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: this.data.editing ? '已更新' : '已新增', icon: 'success' })
      this.setData({ showForm: false })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '保存失败', icon: 'none' })
    }
  },

  // 停用 / 启用（P2-⑲）：离职或转班人员的正确处理是"停用账号"，而不是删掉这一行。
  // 删除后 users 里查无此人，但历史领用/借还里的工号还在 → 使用概况与列表直接显示裸工号，
  // 谁借的都无法追溯。停用则保留档案、只拦登录，随时可恢复。
  async toggleStatus(e) {
    const u = e.currentTarget.dataset.u
    if (!u) return
    const me = identity.current()
    if (me && ('' + me.id).toUpperCase() === ('' + u.id).toUpperCase()) {
      wx.showToast({ title: '不能停用当前登录账号', icon: 'none' })
      return
    }
    const disabled = ('' + (u.status || '启用')) === '停用'
    const nextLabel = disabled ? '启用' : '停用'
    const ok = await new Promise(res => wx.showModal({
      title: nextLabel + '账号',
      content: (disabled
        ? '恢复 ' + u.id + '（' + u.name + '）的登录权限，确定？'
        : '停用后 ' + u.id + '（' + u.name + '）将无法登录，但其历史领用 / 借还记录完整保留。推荐用此方式代替删除。'),
      confirmText: nextLabel,
      confirmColor: disabled ? '#2B6CFF' : '#DC2626',
      success: r => res(r.confirm)
    }))
    if (!ok) return
    wx.showLoading({ title: '处理中', mask: true })
    api.warnIfDemo()
    const r = await api.callFull('adminUpsertUser', {
      id: u.id, name: u.name, role: u.role, cls: u.cls || '',
      status: nextLabel, rid: u.rid || ''
    }, { noFallback: true })
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: '已' + nextLabel, icon: 'success' })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '操作失败', icon: 'none' })
    }
  },

  async del(e) {
    const u = e.currentTarget.dataset.u
    const me = identity.current()
    if (me && ('' + me.id).toUpperCase() === ('' + u.id).toUpperCase()) {
      wx.showToast({ title: '不能删除当前登录账号', icon: 'none' })
      return
    }
    // 删除改为两步确认 + 明确后果：物理删除会让后续统计里的工号变成无法追溯的裸 ID，
    // 所以第一步推荐停用，只有确认"这是录入错的脏账号"才走到真删除。
    const still = await new Promise(res => wx.showModal({
      title: '建议改用「停用」',
      content: '删除会把 ' + u.id + '（' + u.name + '）的档案彻底移除：' +
        '其历史领用 / 借还记录仍在，但统计里只能显示工号、查不到姓名与班级。\n\n' +
        '若该人员仅是不再使用系统，请用列表上的「停用」。',
      cancelText: '改用停用',
      confirmText: '仍要删除',
      success: r => res(r.confirm)
    }))
    if (!still) {
      // 用户选了「改用停用」：直接对该账号执行停用（保留历史档案，比物理删除更安全）
      return this.toggleStatus({ currentTarget: { dataset: { u } } })
    }
    const ok = await new Promise(res => wx.showModal({
      title: '确认删除（不可恢复）',
      content: '此操作不可撤销。确定彻底删除 ' + u.id + '（' + u.name + '）？',
      confirmText: '彻底删除',
      confirmColor: '#DC2626',
      success: r => res(r.confirm)
    }))
    if (!ok) return
    // mask:true：删除确认后阻断重复点击——否则第二次点击会打到已删除的行，
    // 服务端返回 404「该工号不存在」，在「已删除」成功提示后再弹一个错误，用户会困惑
    wx.showLoading({ title: '删除中', mask: true })
    api.warnIfDemo()
    const r = await api.callFull('adminDeleteUser', { id: u.id }, { noFallback: true })
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: '已删除', icon: 'success' })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '删除失败', icon: 'none' })
    }
  }
})
