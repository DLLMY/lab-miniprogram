const identity = require('../../utils/identity.js')
const api = require('../../utils/api.js')

Page({
  data: {
    me: null,
    meInitial: '?',
    roleText: '未登录',
    qid: '',
    isStaff: false,
    isDemo: false,
    greet: '你好',
    matCount: 0,
    toolCount: 0,
    pendingCount: 0,
    // 库存预警（P2-⑳）：此前只有库存页显示数字，教师不点进去永远不会知道缺货
    lowCount: 0,
    lowList: [],
    suggest: [],
    showSuggest: false,
    // 新手引导（P3-㉙）：首次进入按角色给一次操作指引，看过即不再打扰
    showGuide: false,
    guideTitle: '',
    guideSteps: []
  },
  onShow() {
    const i = identity.current()
    this.setData({
      me: i,
      meInitial: i && i.name ? i.name.charAt(0) : '?',
      roleText: i ? identity.roleText(i.role) : '未登录',
      isStaff: identity.isStaff(),
      isDemo: api.isDemoData(),
      greet: this.greeting()
    })
    this.checkGuide()
    this.loadStats()
  },
  // 首次使用引导：按角色给出"你现在能做什么"，避免新用户面对一堆入口无从下手。
  // 只弹一次（按角色分别记），之后不再打扰；在「我的」页可随时重新查看。
  checkGuide() {
    const role = this.data.isStaff ? 'staff' : 'student'
    let seen = ''
    try { seen = wx.getStorageSync('lab_guide_' + role) || '' } catch (e) { seen = '' }
    if (seen === '1') return
    const g = role === 'staff'
      ? {
        title: '教师 / 管理员快速上手',
        steps: [
          '① 扫码或搜索查到物品 → 详情页可直接「扫码入库 / 出库」',
          '② 批量到货用「连续扫码批量登记」，一次扫多件',
          '③ 学生领用申请在「领用审批」处理，可勾选批量通过',
          '④ 每月做一次「库存盘点」校正账面，导出 CSV 用于上报'
        ]
      }
      : {
        title: '同学快速上手',
        steps: [
          '① 扫物品上的二维码或搜索名称，查看库存与位置',
          '② 点「申请领用」填数量与用途，等老师审批',
          '③ 工具借出后在「我的」里点「归还我的工具」自助归还',
          '④ 申请提交错了，待审批状态下可以「撤回申请」'
        ]
      }
    this.setData({ showGuide: true, guideTitle: g.title, guideSteps: g.steps })
  },
  closeGuide() {
    const role = this.data.isStaff ? 'staff' : 'student'
    try { wx.setStorageSync('lab_guide_' + role, '1') } catch (e) { /* 存不下也不影响使用 */ }
    this.setData({ showGuide: false })
  },
  // 按当前时段给出问候语
  greeting() {
    const h = new Date().getHours()
    if (h < 6) return '凌晨好'
    if (h < 12) return '上午好'
    if (h < 14) return '中午好'
    if (h < 18) return '下午好'
    return '晚上好'
  },
  // 顶部统计瓦片：耗材数 / 工具数 / 待审批数（教师可见）
  async loadStats() {
    const staff = this.data.isStaff
    const [mats, tools, pending] = await Promise.all([
      api.call('listMaterials', {}),
      api.call('listTools', {}),
      staff ? api.call('pending', {}) : Promise.resolve(null)
    ])
    // 低于安全线的耗材：只取最紧俏的 3 条做摘要，详情页看全量
    const low = (mats || [])
      .filter(m => (Number(m.safe) || 0) > 0 && (Number(m.stock) || 0) < (Number(m.safe) || 0))
      .sort((a, b) => (Number(a.stock) / Math.max(1, Number(a.safe))) - (Number(b.stock) / Math.max(1, Number(b.safe))))
    this.setData({
      matCount: (mats && mats.length) || 0,
      toolCount: (tools && tools.length) || 0,
      pendingCount: (pending && pending.length) || 0,
      lowCount: low.length,
      lowList: low.slice(0, 3).map(m => ({
        id: m.id, name: m.name, stock: Number(m.stock) || 0, safe: Number(m.safe) || 0,
        unit: m.unit || ''
      }))
    })
  },
  switchAccount() {
    // 与「我的」页一致：直接退出并回登录页（旧实现依赖 wx.showModal，弹窗不弹时表现为点了没反应）
    identity.switchAccount()
  },
  // 下拉刷新：先让云端清掉读缓存（20s TTL）再重取，避免看到别处几秒前写入的旧值
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    api.call('fresh', {}).then(() => this.loadStats()).then(done, done)
  },
  scan() {
    wx.scanCode({
      success: (r) => {
        const raw = (r.result || '').trim()
        const id = this.parseCode(raw)
        // encodeURIComponent：二维码内容可能是 URL/含 & # ? 的串，不编码会把 query 结构破坏
        if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) })
        else wx.showToast({ title: '未识别到物品ID', icon: 'none' })
      },
      fail: () => {
        // 开发者工具模拟器无摄像头，扫码会静默失败；给明确引导而非“点了无效”
        wx.showToast({ title: '模拟器不支持扫码，请手动输入ID', icon: 'none' })
      }
    })
  },
  // 解析扫码内容（P3-㉘）：支持两类码
  //   ① 本系统生成的码：ITEM:M001 —— 带前缀，直接取 ID
  //   ② 物品自带条形码/第三方码：原始值就是 ID 或含 ID 的 URL —— 去协议/参数后大写归一
  // 大小写一律归一：实物标签印刷、第三方生成器都可能给出小写，不归一就查不到。
  parseCode(raw) {
    let s = ('' + (raw || '')).trim()
    if (!s) return ''
    // URL 形式的码（如 http://xxx/?id=M001）优先取 query 里的 id
    const m = s.match(/[?&]id=([^&]+)/i)
    if (m) s = decodeURIComponent(m[1])
    // 本系统前缀
    const p = s.match(/^ITEM[:：]\s*(.+)$/i)
    if (p) s = p[1]
    return s.trim().toUpperCase()
  },
  // 模糊搜索：输入即触发，220ms 防抖后向云函数 search 取候选，下拉实时展示
  onSearch(e) {
    const v = (e.detail.value || '').trim()
    this.setData({ qid: v })
    if (this._st) clearTimeout(this._st)
    if (!v) { this.setData({ suggest: [], showSuggest: false }); return }
    this._st = setTimeout(async () => {
      // 仅当输入与最新一次一致才渲染，避免快速输入时旧请求覆盖新结果
      const list = await api.call('search', { kw: v })
      if ((this.data.qid || '').trim() === v) {
        this.setData({ suggest: (list || []), showSuggest: true })
      }
    }, 220)
  },
  onFocus() {
    // 已有候选时重新聚焦直接展开下拉，无需重新输入
    if (this.data.suggest.length) this.setData({ showSuggest: true })
  },
  // 点击候选项：直达该物品详情（与扫码/精确查询同一落点）
  pickItem(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ showSuggest: false })
    if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(('' + id).toUpperCase()) })
  },
  closeSuggest() { this.setData({ showSuggest: false }) },
  clearSearch() {
    if (this._st) clearTimeout(this._st)
    this.setData({ qid: '', suggest: [], showSuggest: false })
  },
  go() {
    const id = (this.data.qid || '').trim().toUpperCase()
    if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) })
    else wx.showToast({ title: '请输入物品ID', icon: 'none' })
  },
  // 统一跳转：库存一览 / 教师功能页都走这里，url 由 wxml 的 data-url 给定
  goStaff(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  },
  // 预警卡片：点进去看库存全景（按入库 lower_bound 排序在库存页已实现）
  goInventory() {
    wx.navigateTo({ url: '/pages/inventory/inventory' })
  },
  // 「物品入库」直达：进入出入库页并直接展开新建物品弹层
  goNewItem() {
    wx.navigateTo({ url: '/pages/io/io?tab=new' })
  },
  noop() {}
})
