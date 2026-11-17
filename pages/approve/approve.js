const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

Page({
  data: {
    allow: false, list: [], busy: false, me: null, roleText: '未登录', loadErr: false,
    // 批量审批（P2-⑬）：选中项的单号集合
    checked: [],
    allChecked: false,
    // 驳回原因弹层（P1-⑧）；rejectNos 非空表示批量驳回模式
    showReject: false, rejectNo: '', rejectNos: [], rejectWhy: '',
    // 确认借用天数（工具借出审批）：学生填的借期可由老师在此调整
    showDays: false, daysNo: '', daysValue: 7, daysHint: '',
    rejectPresets: ['数量超出实训需求', '用途不明确', '物品暂不外借', '库存紧张暂缓', '请改期再申请']
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

  // 批量驳回：复用勾选集合，先填统一原因，再走服务端 batchReject（一次写锁内逐单裁决）
  batchReject() {
    if (this.data.busy) return
    const nos = this.data.checked.slice()
    if (!nos.length) { wx.showToast({ title: '请先勾选申请', icon: 'none' }); return }
    this.setData({ showReject: true, rejectNo: '', rejectNos: nos, rejectWhy: '' })
  },

  /* ---------- 驳回原因（P1-⑧） ---------- */
  openReject(e) {
    if (this.data.busy) return
    this.setData({ showReject: true, rejectNo: '' + e.currentTarget.dataset.no, rejectNos: [], rejectWhy: '' })
  },
  closeReject() { this.setData({ showReject: false, rejectNo: '', rejectNos: [], rejectWhy: '' }) },
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
    // 单条通过与批量同样是不可逆写（扣库存 + 生成流水），补二次确认防误触。
    // 驳回路径已有独立弹层填原因，不重复确认。
    if (ok) {
      const item = this.data.list.find(x => ('' + x.no) === ('' + no))
      const who = item ? (item.userName || item.user || '') : ''
      // 工具借出：让学生申请的借期与老师看到的应还日期一致。
      // 学生申请时填了 N 天，老师这里可以确认或临时改（比赛/实训周期常与申请时预估不同）。
      if (item && item.kind === 'tool') {
        // 用自定义弹层而不是 showModal(editable)：editable 模式下 content 会成为
        // 输入框的初始值，多行提示会整段塞进输入框，学员根本没法改。
        const want = parseInt(item.days, 10) || 7
        this.setData({ showDays: true, daysNo: no, daysValue: want, daysHint: (item.userName || item.user || '') })
        return   // 由 submitDays 继续走审批
      } else {
        const c = await new Promise(res => wx.showModal({
          title: '确认通过',
          content: '通过后将扣减库存并生成领用流水' + (who ? '（申请人：' + who + '）' : '') + '，不能直接撤回。确定继续？',
          confirmText: '确认通过',
          success: res
        }))
        if (!c.confirm) return
      }
    }
    return this.doApprove(no, ok, 0)
  },

  // 真正提交审批（ok=true 时可带 days 指定借期）
  async doApprove(no, ok, days) {
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
    this.setData({ busy: true })
    api.warnIfDemo()
    wx.showLoading({ title: ok ? '审批中...' : '处理中...', mask: true })
    try {
      // callFull：审批写后校验失败时展示服务端真实原因（如「审批未完全生效…请到腾讯文档核对」），
      // 而不是笼统的「操作未成功」
      const payload = { no, ok, actor: me.id }
      if (!ok) payload.reason = (this.data.rejectWhy || '').trim()
      if (ok && days) payload.days = days
      const r = await api.callFull('approve', payload, { noFallback: true })
      // 服务端要求填写驳回原因：不要把用户锁在已关闭的弹层外，直接重新展开
      if (r && r.code === 400 && r.data && /驳回原因/.test(r.data.msg || '')) {
        wx.hideLoading()
        this.setData({ busy: false, showReject: true, rejectNo: no })
        wx.showToast({ title: r.data.msg, icon: 'none' })
        return
      }
      // 「成功但有提醒」（如幂等补齐：此前已出库、本次未重复扣减库存）必须让老师看见——
      // toast 一闪而过看不见，账面万一不符就没人知道要去盘点核对。
      const warn = (r && r.code === 0 && r.data && r.data.warn) ? ('' + r.data.warn) : ''
      if (warn) {
        wx.showModal({ title: ok ? '已通过（需核对）' : '已处理', content: warn, showCancel: false })
      } else {
        wx.showToast({ title: (r && r.code === 0) ? (ok ? '已通过' : '已拒绝') : ((r && r.data && r.data.msg) || '操作未成功'), icon: (r && r.code === 0) ? 'success' : 'none' })
      }
      if (r && r.code === 0) this.setData({ showReject: false, rejectNo: '', rejectWhy: '' })
      await this.load()
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  },

  /* ---------- 确认借用天数（工具借出）---------- */
  closeDays() { this.setData({ showDays: false, daysNo: '', daysValue: 7, daysHint: '' }) },
  daysInput(e) {
    let d = parseInt(e.detail.value, 10)
    if (!d || d < 1) d = 1
    if (d > 90) d = 90
    this.setData({ daysValue: d })
  },
  daysStep(e) {
    const delta = parseInt(e.currentTarget.dataset.d, 10) || 0
    let d = (parseInt(this.data.daysValue, 10) || 7) + delta
    if (d < 1) d = 1
    if (d > 90) d = 90
    this.setData({ daysValue: d })
  },
  async submitDays() {
    if (this.data.busy) return
    const no = this.data.daysNo
    const days = parseInt(this.data.daysValue, 10) || 7
    this.setData({ showDays: false })
    await this.doApprove(no, true, days)
  },

  // 审批完待办就被清空，教师需要就地跳到领用记录核对「谁领了什么」
  goClaims() { wx.navigateTo({ url: '/pages/claims/claims' }) },

  /* ---------- 驳回弹层的提交入口 ---------- */
  async submitReject() {
    const why = (this.data.rejectWhy || '').trim()
    if (!why) { wx.showToast({ title: '请填写驳回原因', icon: 'none' }); return }
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
    // 批量：一次请求交给服务端 batchReject，统一原因、逐单裁决、返回跳过明细
    if (this.data.rejectNos.length) {
      if (this.data.busy) return
      const nos = this.data.rejectNos.slice()
      this.setData({ busy: true })
      api.warnIfDemo()
      wx.showLoading({ title: '批量驳回中…', mask: true })
      let r = null
      try {
        r = await api.callFull('batchReject', { nos, reason: why, actor: me.id }, { noFallback: true })
      } finally {
        wx.hideLoading()
        this.setData({ busy: false })
      }
      if (r && r.code === 0) {
        const d = r.data || {}
        wx.showModal({
          title: '批量驳回完成',
          content: '成功 ' + (d.ok || 0) + ' 张' + (d.skipped && d.skipped.length ? '，跳过 ' + d.skipped.length + ' 张（已被他人处理或不存在）' : ''),
          showCancel: false, confirmText: '知道了'
        })
        this.setData({ showReject: false, rejectNo: '', rejectNos: [], rejectWhy: '' })
        await this.load()
      } else {
        wx.showToast({ title: (r && r.data && r.data.msg) || '批量驳回失败', icon: 'none' })
      }
      return
    }
    await this.approve({ currentTarget: { dataset: { no: this.data.rejectNo, ok: '0' } } })
  }
})
