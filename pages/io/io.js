const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')
const exporter = require('../../utils/export.js')

const PAGE = 30

Page({
  data: {
    allow: false,
    isAdmin: false,
    mats: [],
    idx: 0,
    type: 'in',
    qty: 1,
    // 入库来源（P3-㉖）：默认采购；出库时来源由服务端按方向自动归类，前端不显示
    srcIdx: 0,
    srcOptions: ['采购', '捐赠', '调拨', '其他'],
    roleText: '未登录',
    curMat: null,
    afterStock: 0,
    // 新建物品（建档入库）表单
    showNew: false,
    nmName: '',
    nmSpec: '',
    nmCat: '',
    nmLoc: '',
    nmUnit: '个',
    nmSafe: '',
    nmQty: 1,
    // 出入库流水（分页 + 筛选）
    logs: [],
    ioTotal: 0,
    ioHasMore: false,
    ioLoading: false,
    ioInQty: 0,
    ioOutQty: 0,
    fItem: '',
    fOp: '',
    fDir: '',
    fDirIdx: 0,
    dirOptions: ['全部方向', '入库', '出库'],
    fFrom: '',
    fTo: '',
    fActive: false,
    // 写操作进行中标志（防重复提交：登记/建档进行中时忽略再次点击）
    busy: false,
    // 「扫码即办」待选中的物品ID（由详情页跳转带入，落地后自动选中并清空）
    pendingPick: '',
    // 连续扫码批量登记（P2-⑬）
    showBatch: false,
    batch: []
  },
  onLoad(o) {
    // 从首页「物品入库」进入时直接展开新建弹层
    if (o && o.tab === 'new') this.setData({ showNew: true })
    // 扫码即办（P1-④）：从详情页带着「扫到的物品ID + 方向」过来。
    // 物品列表是异步拉的，这里先记下意图，loadMats 拿到数据后再落地选中。
    if (o && o.pick) this.setData({ pendingPick: ('' + o.pick).trim().toUpperCase() })
    if (o && o.dir) this.setData({ type: o.dir === 'out' ? 'out' : 'in' })
  },
  onShow() {
    // 角色以持久化身份为准（app.globalData.role 冷启动/切号后可能是旧值）
    identity.syncGlobal()
    const i = identity.current()
    const allow = identity.isStaff()
    this.setData({
      allow,
      isAdmin: identity.isAdmin(),
      roleText: i ? identity.roleText(i.role) : '未登录'
    })
    console.log('[io] 身份=' + (i ? i.id + '/' + i.role : '未登录') + ' allow=' + allow)
    if (allow) { this.loadMats(); this.loadLogs(true) }
  },
  switchAccount() {
    identity.switchAccount()
  },
  // 下拉刷新：先清云端读缓存，再重取耗材与流水
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    if (!this.data.allow) { done(); return }
    api.call('fresh', {})
      .then(() => Promise.all([this.loadMats(), this.loadLogs(true)]))
      .then(done, done)
  },
  // 上拉加载更多流水（P2-⑭）
  onReachBottom() {
    if (this.data.ioHasMore && !this.data.ioLoading) this.loadMoreLogs()
  },
  async loadMats() {
    const m = await api.call('listMaterials', {})
    const mats = m || []
    const patch = { mats }
    // 扫码带来的预选：命中即选中；查无此物时明确告知，否则用户会以为扫码没生效
    if (this.data.pendingPick) {
      const want = ('' + this.data.pendingPick).trim().toUpperCase()
      const i = mats.findIndex(x => ('' + (x.id || '')).trim().toUpperCase() === want)
      if (i >= 0) patch.idx = i
      else wx.showToast({ title: '扫码物品已不在册：' + want, icon: 'none' })
      patch.pendingPick = ''
    }
    this.setData(patch)
    this.preview()
  },

  /* ---------- 流水：分页 + 筛选 ---------- */
  buildFilter() {
    const d = this.data
    const dayStart = (s) => (s ? new Date(s + 'T00:00:00+08:00').getTime() : 0)
    const dayEnd = (s) => (s ? new Date(s + 'T23:59:59+08:00').getTime() : 0)
    return {
      item: (d.fItem || '').trim(),
      op: (d.fOp || '').trim(),
      dir: d.fDir === '入库' || d.fDir === '出库' ? d.fDir : '',
      from: dayStart(d.fFrom),
      to: dayEnd(d.fTo)
    }
  },
  async loadLogs(reset) {
    if (this.data.ioLoading) return
    this.setData({ ioLoading: true })
    try {
      const f = this.buildFilter()
      const offset = reset ? 0 : this.data.logs.length
      const d = await api.call('listStockIO', Object.assign({}, f, { limit: PAGE, offset }))
      // 兼容两种返回形状：新版带分页元信息的对象、旧版裸数组
      const rows = Array.isArray(d) ? d : ((d && d.rows) || [])
      const total = Array.isArray(d) ? rows.length : (Number(d && d.total) || rows.length)
      const mapped = rows.map((r, i) => {
        const isIn = (r.dir || '').indexOf('入') >= 0
        return {
          key: (r.id || (r.item + '_' + r.time + '_' + i + '_' + offset)),
          id: r.id || '',
          item: r.item || '',
          itemName: r.itemName || r.item || '',
          dir: r.dir || '',
          isIn,
          icon: '/images/ic-' + (isIn ? 'plus' : 'minus') + '-b.png',
          qty: Number(r.qty) || 0,
          op: r.op || '',
          time: r.time || '',
          note: r.note || '',
          src: r.src || '',
          reversed: !!r.reversed
        }
      })
      const list = reset ? mapped : this.data.logs.concat(mapped)
      this.setData({
        logs: list,
        ioTotal: total,
        ioHasMore: Array.isArray(d) ? false : !!(d && d.hasMore),
        ioInQty: Array.isArray(d) ? 0 : (Number(d && d.inQty) || 0),
        ioOutQty: Array.isArray(d) ? 0 : (Number(d && d.outQty) || 0)
      })
    } finally {
      this.setData({ ioLoading: false })
    }
  },
  loadMoreLogs() { this.loadLogs(false) },
  onFilter(e) {
    const k = e.currentTarget.dataset.k
    this.setData({ [k]: e.detail.value, fActive: true })
    this.applyFilter()
  },
  onDirFilter(e) {
    const i = Number(e.detail.value) || 0
    const v = this.data.dirOptions[i]
    this.setData({ fDirIdx: i, fDir: i === 0 ? '' : v, fActive: true })
    this.applyFilter()
  },
  onFrom(e) {
    this.setData({ fFrom: e.detail.value, fActive: true })
    this.applyFilter()
  },
  onTo(e) {
    this.setData({ fTo: e.detail.value, fActive: true })
    this.applyFilter()
  },
  resetFilter() {
    this.setData({
      fItem: '', fOp: '', fDir: '', fDirIdx: 0, fFrom: '', fTo: '', fActive: false
    })
    this.loadLogs(true)
  },
  // 输入类筛选做防抖，避免每敲一个字打一次云端
  applyFilter() {
    if (this._ft) clearTimeout(this._ft)
    this._ft = setTimeout(() => this.loadLogs(true), 300)
  },
  exportIO() {
    // 导出全量（不受当前筛选/分页影响）：报表要给的是完整台账，不是屏幕上这一页
    exporter.run('stock_io', false, '正在导出…')
  },
  // 冲销（P2-㉒，仅管理员）：登记错误时用反向流水更正，保留原记录痕迹
  async reverseIO(e) {
    const no = '' + (e.currentTarget.dataset.no || '')
    if (!no) return
    const confirm = await new Promise(res => wx.showModal({
      title: '冲销确认',
      content: '将为流水 ' + no + ' 生成一笔方向相反的冲销记录并回滚库存。原流水会标记为「已冲销」而非删除，操作不可撤销，确定继续？',
      confirmText: '冲销',
      success: res
    }))
    if (!confirm.confirm) return
    wx.showLoading({ title: '冲销中…', mask: true })
    try {
      const r = await api.callFull('reverseIO', { no }, { noFallback: true })
      if (r && r.code === 0) {
        const d = r.data || {}
        wx.showModal({
          title: '冲销完成',
          content: '已生成反向流水，' + d.item + ' 库存回滚至 ' + d.stock,
          showCancel: false, confirmText: '知道了'
        })
        await Promise.all([this.loadMats(), this.loadLogs(true)])
      } else {
        wx.showModal({
          title: '冲销失败',
          content: (r && r.data && r.data.msg) || '请刷新后重试',
          showCancel: false, confirmText: '知道了'
        })
      }
    } finally {
      wx.hideLoading()
    }
  },

  onMat(e) {
    this.setData({ idx: e.detail.value })
    this.preview()
  },
  // 分段控件切换出入库类型（替代原 picker，选错时不易误触）
  setType(e) {
    const t = e.currentTarget.dataset.t === 'out' ? 'out' : 'in'
    this.setData({ type: t })
    this.preview()
  },
  onSrc(e) { this.setData({ srcIdx: Number(e.detail.value) || 0 }) },
  onQty(e) {
    this.setData({ qty: parseInt(e.detail.value) || 1 })
    this.preview()
  },
  // 数量步进器
  stepQty(e) {
    const d = parseInt(e.currentTarget.dataset.d) || 0
    let q = (parseInt(this.data.qty) || 0) + d
    if (q < 1) q = 1
    this.setData({ qty: q })
    this.preview()
  },
  // 实时预览：当前耗材 + 登记后的库存
  preview() {
    const m = this.data.mats[this.data.idx]
    if (!m) {
      this.setData({ curMat: null, afterStock: 0 })
      return
    }
    const stock = Number(m.stock) || 0
    const q = parseInt(this.data.qty) || 0
    const after = this.data.type === 'in' ? stock + q : stock - q
    this.setData({ curMat: m, afterStock: after })
  },
  async submit() {
    if (!this.data.allow) return
    // 防重提交：登记期间按钮可再次点击（无遮罩），双击会发两次 io → 库存被扣两次。
    // 服务端虽串行化且每次读最新库存，但两次都是合法扣减，用户只想登记一笔。
    if (this.data.busy) return
    const m = this.data.mats[this.data.idx]
    if (!m) { wx.showToast({ title: '请先选择耗材', icon: 'none' }); return }
    if (this.data.qty < 1) { wx.showToast({ title: '请输入正确数量', icon: 'none' }); return }
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }

    // 二次确认（P2-⑱）：涉及库存变更的提交前必须复核，尤其是不可逆的出库
    const isOut = this.data.type === 'out'
    const after = Number(m.stock || 0) + (isOut ? -1 : 1) * Number(this.data.qty)
    const confirm = await new Promise(res => wx.showModal({
      title: isOut ? '确认出库' : '确认入库',
      content: `${m.name}（${m.id}）\n${isOut ? '出库' : '入库'} ${this.data.qty} ${m.unit || ''}\n` +
        `当前 ${m.stock} → 登记后 ${after}${after < 0 ? '\n⚠ 登记后库存为负，将被拒绝' : ''}`,
      success: res
    }))
    if (!confirm.confirm) return

    this.setData({ busy: true })
    wx.showLoading({ title: '登记中…', mask: true })
    api.warnIfDemo()
    try {
      // 用 callFull 拿完整返回：服务端校验/回读校验失败时展示真实原因（库存不足/数量非法/…），
      // 不再猜一句「失败（库存不足?）」
      const r = await api.callFull('io', {
        matId: m.id, type: this.data.type, qty: this.data.qty, actor: me.id,
        // 出库来源无需选择：服务端会按方向记为「手动出库」，避免用户困惑于"出库还有什么来源"
        src: this.data.type === 'in' ? this.data.srcOptions[this.data.srcIdx] : ''
      }, { noFallback: true })
      if (r && r.code === 0) {
        wx.showToast({ title: '登记成功' })
        this.loadMats()
        this.loadLogs(true)
      } else {
        wx.showToast({ title: (r && r.data && r.data.msg) || '登记失败', icon: 'none' })
      }
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  },

  /* ---------- 连续扫码批量登记（P2-⑬） ---------- */
  startBatch() {
    this.setData({ showBatch: true, batch: [] })
    this.scanOne()
  },
  closeBatch() { this.setData({ showBatch: false, batch: [] }) },
  scanOne() {
    wx.scanCode({
      success: (r) => {
        const id = ('' + (r.result || '')).trim().toUpperCase()
        if (!id) { wx.showToast({ title: '未识别到物品ID', icon: 'none' }); return }
        const mat = this.data.mats.find(m => ('' + m.id).trim().toUpperCase() === id)
        if (!mat) { wx.showToast({ title: '未找到该物品：' + id, icon: 'none' }); return }
        const batch = this.data.batch.slice()
        const exist = batch.find(x => x.matId === id)
        // 同一件再扫一次=数量+1，符合"扫多少算多少"的现场直觉
        if (exist) exist.qty = (Number(exist.qty) || 0) + 1
        else batch.push({ key: id + '_' + Date.now(), matId: id, name: mat.name, qty: 1 })
        this.setData({ batch })
        wx.showToast({ title: '已加入 ' + id, icon: 'none' })
      },
      fail: () => wx.showToast({ title: '扫码取消或模拟器不支持', icon: 'none' })
    })
  },
  btStep(e) {
    const i = Number(e.currentTarget.dataset.i)
    const d = parseInt(e.currentTarget.dataset.d, 10) || 0
    const batch = this.data.batch.slice()
    let q = (parseInt(batch[i].qty, 10) || 0) + d
    if (q < 1) q = 1
    batch[i].qty = q
    this.setData({ batch })
  },
  btQty(e) {
    const i = Number(e.currentTarget.dataset.i)
    const batch = this.data.batch.slice()
    batch[i].qty = Math.max(1, parseInt(e.detail.value, 10) || 1)
    this.setData({ batch })
  },
  btDel(e) {
    const i = Number(e.currentTarget.dataset.i)
    const batch = this.data.batch.slice()
    batch.splice(i, 1)
    this.setData({ batch })
  },
  async submitBatch() {
    if (this.data.busy) return
    const items = this.data.batch.map(x => ({ matId: x.matId, qty: Number(x.qty) || 1 }))
    if (!items.length) { wx.showToast({ title: '请先扫码加入物品', icon: 'none' }); return }
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
    this.setData({ busy: true })
    wx.showLoading({ title: '批量登记中…', mask: true })
    api.warnIfDemo()
    try {
      const r = await api.callFull('batchIo', { items: items, type: 'in', actor: me.id }, { noFallback: true })
      if (r && r.code === 0) {
        const d = r.data || {}
        wx.hideLoading()
        wx.showModal({
          title: '批量入库完成',
          content: '成功 ' + d.done + ' 项' + (d.failed ? ('，失败 ' + d.failed + ' 项：' +
            (d.details || []).filter(x => x.err).map(x => x.matId + '(' + x.err + ')').join('、')) : ''),
          showCancel: false, confirmText: '知道了'
        })
        this.setData({ showBatch: false, batch: [] })
        this.loadMats()
        this.loadLogs(true)
      } else {
        wx.hideLoading()
        wx.showModal({
          title: '批量登记失败',
          content: (r && r.data && r.data.msg) || '请刷新后重试',
          showCancel: false, confirmText: '知道了'
        })
      }
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  },

  /* ---------- 新建物品（建档入库） ---------- */
  openNew() {
    this.setData({
      showNew: true,
      nmName: '', nmSpec: '', nmCat: '', nmLoc: '', nmUnit: '个', nmSafe: '', nmQty: 1
    })
  },
  closeNew() { this.setData({ showNew: false }) },
  nmInput(e) {
    const k = e.currentTarget.dataset.k
    const v = e.detail.value
    // 数量与安全库存按数字存，其余按字符串
    if (k === 'Qty') this.setData({ nmQty: parseInt(v) || 0 })
    else if (k === 'Safe') this.setData({ nmSafe: v })
    else this.setData({ ['nm' + k]: v })
  },
  // 阻止弹层内部点击冒泡导致遮罩关闭
  noop() {},
  nmStep(e) {
    const d = parseInt(e.currentTarget.dataset.d) || 0
    let q = (parseInt(this.data.nmQty) || 0) + d
    if (q < 0) q = 0
    this.setData({ nmQty: q })
  },
  async submitNew() {
    if (!this.data.allow) return
    // 与 submit() 一致的重入守卫：遮罩之外再兜一层，防止个别机型上
    // showLoading 未及时生效时的双击重复建档
    if (this.data.busy) return
    const name = (this.data.nmName || '').trim()
    if (!name) { wx.showToast({ title: '请填写物品名称', icon: 'none' }); return }
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
    this.setData({ busy: true })
    api.warnIfDemo()
    wx.showLoading({ title: '建档中…', mask: true })
    try {
      const r = await api.callFull('addMaterial', {
        name,
        spec: (this.data.nmSpec || '').trim(),
        cat: (this.data.nmCat || '').trim(),
        loc: (this.data.nmLoc || '').trim(),
        unit: (this.data.nmUnit || '').trim() || '个',
        safe: parseInt(this.data.nmSafe) || 0,
        qty: parseInt(this.data.nmQty) || 0,
        actor: me.id
      }, { noFallback: true })
      if (r && r.code === 0 && r.data) {
        wx.hideLoading()
        wx.showToast({ title: '已入库 ' + r.data.id, icon: 'success' })
        this.setData({ showNew: false })
        this.loadMats()
        this.loadLogs(true)
      } else {
        wx.hideLoading()
        const msg = (r && r.data && r.data.msg) || '建档失败'
        // 已存在同名物品：引导直接去登记页选择它
        if (r && r.code === 409) {
          wx.showModal({
            title: '物品已存在',
            content: msg,
            showCancel: false,
            confirmText: '知道了'
          })
        } else {
          wx.showToast({ title: msg, icon: 'none' })
        }
      }
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  }
})
