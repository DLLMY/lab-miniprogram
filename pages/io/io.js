const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

Page({
  data: {
    allow: false,
    mats: [],
    idx: 0,
    type: 'in',
    qty: 1,
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
    // 出入库流水
    logs: []
  },
  onLoad(o) {
    // 从首页「物品入库」进入时直接展开新建弹层
    if (o && o.tab === 'new') this.setData({ showNew: true })
  },
  onShow() {
    // 角色以持久化身份为准（app.globalData.role 冷启动/切号后可能是旧值）
    identity.syncGlobal()
    const i = identity.current()
    const allow = identity.isStaff()
    this.setData({ allow, roleText: i ? identity.roleText(i.role) : '未登录' })
    console.log('[io] 身份=' + (i ? i.id + '/' + i.role : '未登录') + ' allow=' + allow)
    if (allow) { this.loadMats(); this.loadLogs() }
  },
  switchAccount() {
    identity.switchAccount()
  },
  async loadMats() {
    const m = await api.call('listMaterials', {})
    const mats = m || []
    this.setData({ mats })
    this.preview()
  },
  // 载入最近出入库流水（账可查）
  async loadLogs() {
    const rows = await api.call('listStockIO', { limit: 30 })
    const list = rows || []
    // 预计算展示字段：方向 → 是否入库、正负号、图标
    this.setData({
      logs: list.map(r => {
        const isIn = (r.dir || '').indexOf('入') >= 0
        return {
          id: r.id || '',
          item: r.item || '',
          itemName: r.itemName || r.item || '',
          dir: r.dir || '',
          isIn,
          icon: '/images/ic-' + (isIn ? 'plus' : 'minus') + '-b.png',
          qty: Number(r.qty) || 0,
          op: r.op || '',
          time: r.time || '',
          note: r.note || ''
        }
      })
    })
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
    const m = this.data.mats[this.data.idx]
    if (!m) { wx.showToast({ title: '请先选择耗材', icon: 'none' }); return }
    if (this.data.qty < 1) { wx.showToast({ title: '请输入正确数量', icon: 'none' }); return }
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
    const r = await api.call('io', {
      matId: m.id, type: this.data.type, qty: this.data.qty, actor: me.id
    })
    if (r !== null) {
      wx.showToast({ title: '登记成功' })
      this.loadMats()
      this.loadLogs()
    } else {
      wx.showToast({ title: '失败（库存不足?）', icon: 'none' })
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
    const name = (this.data.nmName || '').trim()
    if (!name) { wx.showToast({ title: '请填写物品名称', icon: 'none' }); return }
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
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
      })
      if (r && r.code === 0 && r.data) {
        wx.hideLoading()
        wx.showToast({ title: '已入库 ' + r.data.id, icon: 'success' })
        this.setData({ showNew: false })
        this.loadMats()
        this.loadLogs()
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
    }
  }
})
