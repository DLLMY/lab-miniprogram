const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

Page({
  data: {
    allow: false, list: [], busy: false, me: null, roleText: '未登录', loadErr: false,
    // 批量审批（P2-⑬）：选中项的单号集合
    checked: [],
    allChecked: false,
    // 驳回原因弹层（P1-⑧）
    showReject: false, rejectNo: '', rejectWhy: '',
    rejectPresets: ['数量超出实训需求', '用途不明确', '物品暂不外借', '库存紧张暂缓', '请改为课后集中领取']
  },
  onShow() {
    // 角色以持久化身份为唯一依据：历史实现读 app.globalData.role，
    // 冷启动/切号后该值可能是旧的 'student'，导致教师账号也被拦成「无权限」。
    identity.syncGlobal()
    const i = identity.current()
    const allow = identity.isStaff()
    this.setData({ allow, me: i, roleText: i ? identity.roleText(i.role) : '未登录' })
    if (allow) this.load()
  },
  switchAccount() {
    identity.switchAccount()
  },
  // 下拉刷新：先清云端读缓存再重取待审批列表
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    if (!this.data.allow) { done(); return }
    api.call('fresh', {}).then(() => this.load()).then(done, done)
  },
  async load() {
    const list = await api.call('pending', {})
    // null = 云端业务错误（如 500/403），与「真的没有待审批」是两回事：
    // 历史上笼统显示「全部处理完毕」，用户会以为审批完了，实际是没加载出来
    if (list === null || list === undefined) {
      this.setData({ list: [], loadErr: true, checked: [], allChecked: false })
      return
    }
    this.setData({ list: list || [], loadErr: false, checked: [], allChecked: false })
  },

  /* ---------- 批量选择（P2-⑬） ---------- */
  toggleOne(e) {
    const no = '' + e.currentTarget.dataset.no
    const checked = this.data.checked.slice()
    const i = checked.indexOf(no)
    if (i >= 0) checked.splice(i, 1)
    else checked.push(no)
    this.setData({ checked, allChecked: checked.length > 0 && checked.length === this.data.list.length })
  },
  toggleAll() {
    if (this.data.allChecked) return this.setData({ checked: [], allChecked: false })
    this.setData({ checked: this.data.list.map(x => '' + x.no), allChecked: true })
  },
  // 批量通过：逐单串行提交（服务端已有写锁与幂等，串行只为拿到逐单结果做汇总）
  async approveAll() {
    if (this.data.busy) return
    const nos = this.data.checked.slice()
    if (!nos.length) { wx.showToast({ title: '请先勾选申请', icon: 'none' }); return }
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
    // 批量是不可逆的写操作，先确认总量，避免误触一次清空整个待办
    const confirm = await new Promise(res => wx.showModal({
      title: '批量通过确认',
      content: '将一次性通过 ' + nos.length + ' 张申请并扣减对应库存，确定继续？',
      success: res
    }))
    if (!confirm.confirm) return
    this.setData({ busy: true })
    api.warnIfDemo()
    wx.showLoading({ title: '处理中...', mask: true })
    let okCount = 0
    const fails = []
    try {
      for (const no of nos) {
        const r = await api.callFull('approve', { no, ok: true, actor: me.id }, { noFallback: true })
        if (r && r.code === 0) okCount++
        else fails.push(no + '：' + ((r && r.data && r.data.msg) || '失败'))
      }
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
    wx.showModal({
      title: '批量通过完成',
      content: '成功 ' + okCount + ' 张' + (fails.length ? '，失败 ' + fails.length + ' 张：\n' + fails.slice(0, 3).join('\n') : ''),
      showCancel: false, confirmText: '知道了'
    })
    await this.load()
  },

  /* ---------- 驳回原因（P1-⑧） ---------- */
  openReject(e) {
    if (this.data.busy) return
    this.setData({ showReject: true, rejectNo: '' + e.currentTarget.dataset.no, rejectWhy: '' })
  },
  closeReject() { this.setData({ showReject: false, rejectNo: '', rejectWhy: '' }) },
  noop() {},
  rejectInput(e) { this.setData({ rejectWhy: e.detail.value }) },
  pickReject(e) {
    const v = e.currentTarget.dataset.v
    this.setData({ rejectWhy: this.data.rejectWhy === v ? '' : v })
  },

  // ok=true 直接通过；ok=false 走驳回弹层先填原因
  async approve(e) {
    if (this.data.busy) return // 防连点重复审批
    const no = e.currentTarget.dataset.no
    const ok = e.currentTarget.dataset.ok === '1'
    const me = identity.current()
    if (!me) {
      wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    api.warnIfDemo()
    wx.showLoading({ title: ok ? '审批中...' : '处理中...', mask: true })
    try {
      // callFull：审批写后校验失败时展示服务端真实原因（如「审批未完全生效…请到腾讯文档核对」），
      // 而不是笼统的「操作未成功」
      const payload = { no, ok, actor: me.id }
      if (!ok) payload.reason = (this.data.rejectWhy || '').trim()
      const r = await api.callFull('approve', payload, { noFallback: true })
      // 服务端要求填写驳回原因：不要把用户锁在已关闭的弹层外，直接重新展开
      if (r && r.code === 400 && r.data && /驳回原因/.test(r.data.msg || '')) {
        wx.hideLoading()
        this.setData({ busy: false, showReject: true, rejectNo: no })
        wx.showToast({ title: r.data.msg, icon: 'none' })
        return
      }
      wx.showToast({ title: (r && r.code === 0) ? (ok ? '已通过' : '已拒绝') : ((r && r.data && r.data.msg) || '操作未成功'), icon: 'none' })
      if (r && r.code === 0) this.setData({ showReject: false, rejectNo: '', rejectWhy: '' })
      await this.load()
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  },

  /* ---------- 驳回弹层的提交入口 ---------- */
  async submitReject() {
    const why = (this.data.rejectWhy || '').trim()
    if (!why) { wx.showToast({ title: '请填写驳回原因', icon: 'none' }); return }
    await this.approve({ currentTarget: { dataset: { no: this.data.rejectNo, ok: '0' } } })
  }
})
