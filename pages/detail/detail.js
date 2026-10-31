const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

Page({
  data: {
    id: '', type: '', item: null, role: 'student', stockPct: 0, lowStock: false, busy: false,
    // 当前登录者是否就是该工具的借用人：决定「自助归还」按钮是否出现
    isMineBorrow: false,
    // 申请弹层（数量 + 用途）
    showApply: false,
    applyMode: 'material',
    apQty: 1,
    apReason: '',
    usagePresets: ['实训课程教学', '技能竞赛训练', '社团活动', '设备维修', '毕业设计', '其他'],
    // 二维码面板
    showQr: false
  },
  // 借用人和 receptor 都会变（换设备/切身份），身份与物品任一刷新都要重算一次
  refreshMineBorrow() {
    const item = this.data.item
    const mine = this.meId()
    const isMine = !!(this.data.type === 'tool' && item && mine &&
      ('' + (item.borrower || '')).trim().toUpperCase() === ('' + mine).trim().toUpperCase())
    if (isMine !== this.data.isMineBorrow) this.setData({ isMineBorrow: isMine })
  },
  onLoad(o) {
    this.setData({ role: this.currentRole() })
    if (o.id) this.load(o.id)
  },
  onShow() {
    // 角色可能在首页被切换，页面显示时按持久化身份同步一次，避免按钮组过期
    this.setData({ role: this.currentRole() })
    this.refreshMineBorrow()
  },
  // 角色以持久化身份为准，避免 globalData 里的旧值让教师看不到教师操作
  currentRole() {
    identity.syncGlobal()
    const i = identity.current()
    return i ? identity.normalizeRole(i.role) : 'student'
  },
  // 当前登录用户 ID：统一从持久化身份取（与审批页一致），不依赖 globalData 时序
  meId() {
    const i = identity.current()
    return i ? i.id : ''
  },
  async load(id) {
    this.setData({ id })
    const d = await api.call('getItem', { id })
    if (d && d.item) {
      this.setData({ type: d.type, item: d.item })
      this.calcStock(d.item)
      this.refreshMineBorrow()
    } else wx.showToast({ title: '未找到物品', icon: 'none' })
  },
  // 扫码即办：带着已扫到的物品ID与方向跳转出入库页并自动选中，
  // 省掉「回首页→进登记页→在 picker 里翻找刚扫过的物品」这段往返。
  goIo(e) {
    const dir = (e.currentTarget.dataset.dir || 'in').trim()
    const id = encodeURIComponent(this.data.id || '')
    if (!id) { wx.showToast({ title: '物品ID缺失', icon: 'none' }); return }
    wx.navigateTo({ url: '/pages/io/io?pick=' + id + '&dir=' + dir })
  },
  // 库存水位进度：以安全库存为 100% 基准（超出安全线封顶 100%）
  calcStock(item) {
    const stock = Number(item.stock) || 0
    const safe = Number(item.safe) || 0
    let pct = safe > 0 ? Math.round((stock / safe) * 100) : (stock > 0 ? 100 : 0)
    if (pct < 0) pct = 0
    if (pct > 100) pct = 100
    this.setData({ stockPct: pct, lowStock: stock < safe })
  },
  // 下拉刷新：先清云端读缓存再重取，保证工具状态/持有人是最新的
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    if (!this.data.id) { done(); return }
    api.call('fresh', {}).then(() => this.load(this.data.id)).then(done, done)
  },
  /* ---------- 二维码（P3-㉘） ---------- */
  openQr() {
    if (!this.data.item) return
    this.setData({ showQr: true })
    // canvas 尺寸依赖布局，等一帧再画，否则拿到的宽高可能是 0
    setTimeout(() => this.drawQr(), 60)
  },
  closeQr() { this.setData({ showQr: false }) },
  drawQr() {
    const draw = require('../../utils/qrcode.js')
    const id = '' + (this.data.id || '')
    // 统一前缀 ITEM:：扫码端据此判断"这是本系统的码"并取出 ID，
    // 同时兼容物品自带条形码（纯 ID，无前缀）——两种码都能落到详情页。
    draw({
      canvasId: 'itemQr',
      _this: this,
      text: 'ITEM:' + id,
      width: 220, height: 220,
      background: '#FFFFFF', foreground: '#0F2350'
    })
  },
  saveQr() {
    wx.canvasToTempFilePath({
      canvasId: 'itemQr',
      success: (r) => {
        wx.saveImageToPhotosAlbum({
          filePath: r.tempFilePath,
          success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
          fail: (e) => {
            // 用户拒绝相册权限时给明确引导，而不是默默失败
            const msg = (e && e.errMsg || '')
            if (/auth deny|authorize|deny/.test(msg)) {
              wx.showModal({
                title: '需要相册权限',
                content: '请在小程序设置中允许保存到相册，或截图后打印。',
                showCancel: false, confirmText: '知道了'
              })
            } else {
              wx.showToast({ title: '保存失败，可截图后打印', icon: 'none' })
            }
          }
        })
      },
      fail: () => wx.showToast({ title: '生成图片失败，可截图后打印', icon: 'none' })
    }, this)
  },
  /* ---------- 申请领用 / 借出（数量 + 用途） ---------- */
  openApply(e) {
    const mode = (e.currentTarget.dataset.mode === 'tool') ? 'tool' : 'material'
    this.setData({ showApply: true, applyMode: mode, apQty: 1, apReason: '' })
  },
  closeApply() { this.setData({ showApply: false }) },
  noop() {},
  apQtyInput(e) {
    let q = parseInt(e.detail.value, 10)
    if (!q || q < 1) q = 1
    this.setData({ apQty: q })
  },
  apStep(e) {
    const d = parseInt(e.currentTarget.dataset.d, 10) || 0
    let q = (parseInt(this.data.apQty, 10) || 1) + d
    if (q < 1) q = 1
    this.setData({ apQty: q })
  },
  apReasonInput(e) { this.setData({ apReason: e.detail.value }) },
  // 预置用途一键填充；再点一次取消选择，方便改回手写
  pickReason(e) {
    const v = e.currentTarget.dataset.v
    this.setData({ apReason: this.data.apReason === v ? '' : v })
  },
  async submitApply() {
    // busy 守卫：请求返回前按钮可再次点击，双击会产生两条相同申请
    if (this.data.busy) return
    const reason = (this.data.apReason || '').trim()
    if (!reason) { wx.showToast({ title: '请填写或选择用途', icon: 'none' }); return }
    const qty = parseInt(this.data.apQty, 10) || 0
    if (this.data.applyMode !== 'tool' && (!qty || qty < 1)) {
      wx.showToast({ title: '请输入正整数数量', icon: 'none' }); return
    }
    const me = this.meId()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
    this.setData({ busy: true })
    wx.showLoading({ title: '提交中…', mask: true })
    try {
      api.warnIfDemo()
      // callFull + noFallback：提交失败时展示服务端真实原因（物品不存在/数量非法/云函数未部署…），
      // 且传输层失败不回退 mock——否则会显示"已提交"而申请单根本没写进腾讯文档
      const req = this.data.applyMode === 'tool'
        ? { action: 'toolRequisition', payload: { user: me, toolId: this.data.id, reason } }
        : { action: 'requisition', payload: { user: me, matId: this.data.id, qty, reason } }
      const res = await api.callFull(req.action, req.payload, { noFallback: true })
      if (res && res.code === 0) {
        this.setData({ showApply: false })
        wx.showToast({ title: '已提交，待审批', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 800)
      } else {
        wx.showToast({ title: (res && res.data && res.data.msg) || '提交失败', icon: 'none' })
      }
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  },
  async returnTool() {
    if (this.data.busy) return
    const me = this.meId()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
    this.setData({ busy: true })
    api.warnIfDemo()
    wx.showLoading({ title: '归还中…', mask: true })
    let r = null
    try {
      // 用 callFull 拿完整返回：失败时能看到服务端真实原因（记录不存在/工具行没写进去/…），
      // 而不是被 api.call 吞成一句「归还未成功」
      r = await api.callFull('returnTool', { actor: me, toolId: this.data.id }, { noFallback: true })
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
    if (r && r.code === 0) {
      wx.showToast({ title: r.data && r.data.healed ? '已确认归还（记录已修复）' : '已确认归还', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    } else {
      const msg = (r && r.data && r.data.msg) || '归还未成功，请重试'
      // 失败时停在详情页并说明原因：不跳走，避免用户回到列表看到旧状态却不知道发生了什么
      wx.showModal({ title: '归还未完成', content: msg, showCancel: false, confirmText: '知道了' })
    }
  }
})
