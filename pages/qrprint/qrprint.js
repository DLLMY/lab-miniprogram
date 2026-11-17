const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')
const codeUtil = require('../../utils/code.js')
const drawQr = require('../../utils/qrcode.js')

// 二维码批量打印（教师 / 管理员）
// 单品详情页已有二维码，但逐个打开→保存→打印效率极低。本页一次性勾选多件耗材/工具，
// 在 canvas 上按 A4 网格批量绘制「ITEM:<ID>」码 + 名称/位置标签，导出图片存相册后打印。
// 码内容与扫码端（utils/code.js parseItemCode）严格同构，打印出来的标签扫码即可直达详情。
//
// ⚠ 打印标签会直接贴到真实设备上，因此取数必须是【真实云端数据】：
//   · 列表读取用 noFallback（云端失败不回落 mock），失败即报错；
//   · 云函数自身跑在演示模式（USE_MOCK=true）时同样禁止生成——
//     否则会把 M001 这类演示物品的码打印出来贴到真机上，扫出来查无此物。
const PAGE_W = 700
const PAGE_H = 990
const COLS = 3
const ROWS = 5
const PER_PAGE = COLS * ROWS

Page({
  data: {
    allow: false,
    roleText: '未登录',
    tab: 'material',
    keyword: '',
    list: [],
    // 按存放位置分组视图（贴标签时按货架分组是刚需：一次印一个柜子的标签）
    groupByLoc: false,
    locGroups: [],
    selected: [],
    pageImages: [],
    busy: false,
    loadErr: false,
    demo: false
  },
  onLoad() {
    this.refreshRole()
  },
  onShow() {
    // 身份可能被切换（切号/退出重登），显示时必须重新校验并重取数据，
    // 否则会残留上一个教师视角下的清单与勾选状态。
    this.refreshRole()
    if (this.data.allow) this.load()
  },
  refreshRole() {
    identity.syncGlobal()
    const i = identity.current()
    const allow = identity.isStaff()
    this.setData({ allow, roleText: i ? identity.roleText(i.role) : '未登录' })
    if (!allow) this.setData({ list: [], selected: [], pageImages: [] })
  },
  switchAccount() { identity.switchAccount() },

  async load() {
    this.setData({ loadErr: false })
    const [mr, tr] = await Promise.all([
      api.callFull('listMaterials', {}, { noFallback: true }),
      api.callFull('listTools', {}, { noFallback: true })
    ])
    const mats = mr && mr.code === 0 && Array.isArray(mr.data) ? mr.data : null
    const tools = tr && tr.code === 0 && Array.isArray(tr.data) ? tr.data : null
    if (!mats && !tools) {
      this.setData({ loadErr: true, list: [], demo: false })
      return
    }
    const materials = (mats || []).map(x => ({
      key: 'M:' + x.id, id: x.id, name: x.name, loc: x.loc || '', spec: x.spec || '', type: 'material'
    }))
    const toolList = (tools || []).map(x => ({
      key: 'T:' + x.id, id: x.id, name: x.name, loc: x.loc || '', spec: x.spec || '', type: 'tool'
    }))
    // 演示数据判定：云函数回 src=mock，或全局数据源被标记为 mock
    const demo = (mr.src === 'mock') || (tr.src === 'mock') || api.isDemoData()
    this.setData({ demo, _all: { material: materials, tool: toolList } }, () => this.applyFilter())
  },
  applyFilter() {
    const all = (this.data._all && this.data._all[this.data.tab]) || []
    const kw = (this.data.keyword || '').trim().toUpperCase()
    const list = kw ? all.filter(x =>
      ('' + x.id).toUpperCase().indexOf(kw) >= 0 ||
      ('' + x.name).toUpperCase().indexOf(kw) >= 0 ||
      ('' + x.loc).toUpperCase().indexOf(kw) >= 0) : all
    // 按位置分组：同位置的物品聚在一起，便于「一次印一个柜子」
    const gmap = {}
    list.forEach(x => {
      const k = ('' + (x.loc || '')).trim() || '未设置位置'
      if (!gmap[k]) gmap[k] = { loc: k, items: [] }
      gmap[k].items.push(x)
    })
    const locGroups = Object.keys(gmap).sort().map(k => {
      // ⚠ gmap[k] 是分组对象 { loc, items }，真正要的是它的 items 数组。
      //   此前误写成 const items = gmap[k] → items.filter 直接抛
      //   「items.filter is not a function」→ 一键切到「按位置分组」就崩、白屏，
      //   该功能从上线起就没被真正执行过（静态扫描只查 class 与事件绑定，查不到运行时异常）。
      const items = gmap[k].items || []
      const selCount = items.filter(x => this.data.selected.indexOf(x.key) >= 0).length
      return {
        loc: k,
        count: items.length,
        keys: items.map(x => x.key),
        selCount,
        allSel: selCount === items.length
      }
    })
    this.setData({ list, locGroups })
  },
  onGroupToggle(e) {
    this.setData({ groupByLoc: !this.data.groupByLoc }, () => this.applyFilter())
  },
  // 整组选中/取消（传分组下标而非 key 数组：dataset 传数组在低版本基础库上不可靠）
  toggleLocGroup(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const g = (this.data.locGroups || [])[gi]
    if (!g) return
    const keys = g.keys || []
    const sel = this.data.selected.slice()
    const allIn = keys.length && keys.every(k => sel.indexOf(k) >= 0)
    const next = allIn ? sel.filter(k => keys.indexOf(k) < 0) : Array.from(new Set(sel.concat(keys)))
    this.setData({ selected: next }, () => this.applyFilter())
  },
  onTab(e) { this.setData({ tab: e.currentTarget.dataset.tab, keyword: '' }, () => this.applyFilter()) },
  onKeyword(e) { this.setData({ keyword: e.detail.value }, () => this.applyFilter()) },
  toggleOne(e) {
    const key = e.currentTarget.dataset.key
    const sel = this.data.selected.slice()
    const i = sel.indexOf(key)
    if (i >= 0) sel.splice(i, 1)
    else sel.push(key)
    // 同步刷新分组的已选计数（组标题上的「已选/总数」不能滞后）
    this.setData({ selected: sel }, () => this.applyFilter())
  },
  selectAll() {
    const keys = this.data.list.map(x => x.key)
    const sel = this.data.selected.slice()
    // 若当前页已全选则取消这些，否则追加未选的
    const allIn = keys.every(k => sel.indexOf(k) >= 0)
    const next = allIn ? sel.filter(k => keys.indexOf(k) < 0) : Array.from(new Set(sel.concat(keys)))
    this.setData({ selected: next }, () => this.applyFilter())
  },
  clearSel() { this.setData({ selected: [] }, () => this.applyFilter()) },

  // 按 A4 网格分页绘制：3 列 × 5 行 = 每页 15 个标签
  async generate() {
    if (this.data.busy) return
    if (this.data.demo) {
      wx.showModal({
        title: '当前是演示数据',
        content: '云端返回的是演示数据（USE_MOCK=true 或云函数未部署），物品清单不是真实台账。\n打印出来的标签会贴到真实设备上却查无此物，请先让管理员确认云函数环境变量后再打印。',
        showCancel: false
      })
      return
    }
    if (!this.data.selected.length) { wx.showToast({ title: '请先勾选物品', icon: 'none' }); return }
    const all = this.data._all || {}
    const chosen = []
    ;['material', 'tool'].forEach(t => {
      (all[t] || []).forEach(x => { if (this.data.selected.indexOf(x.key) >= 0) chosen.push(x) })
    })
    if (!chosen.length) { wx.showToast({ title: '所选物品已不存在，请重新读取', icon: 'none' }); return }

    this.setData({ busy: true, pageImages: [] })
    wx.showLoading({ title: '生成二维码…', mask: true })
    try {
      const ctx = wx.createCanvasContext('qrBatch', this)
      const totalPages = Math.ceil(chosen.length / PER_PAGE)
      const images = []
      for (let p = 0; p < totalPages; p++) {
        const slice = chosen.slice(p * PER_PAGE, (p + 1) * PER_PAGE)
        ctx.clearRect(0, 0, PAGE_W, PAGE_H)
        ctx.setFillStyle('#FFFFFF')
        ctx.fillRect(0, 0, PAGE_W, PAGE_H)
        // 先画每个标签的边框与文字（weapp-qrcode 的 draw(false) 会保留已有内容）
        slice.forEach((item, idx) => {
          const col = idx % COLS, row = Math.floor(idx / COLS)
          const cw = PAGE_W / COLS, ch = PAGE_H / ROWS
          const x = col * cw, y = row * ch
          ctx.setStrokeStyle('#CBD5E1')
          ctx.setLineWidth(1)
          ctx.strokeRect(x + 6, y + 6, cw - 12, ch - 12)
          // 名称与 ID 文字放在码下方；过长截断，避免溢出到相邻标签
          const label = ('' + (item.name || '')).slice(0, 12)
          ctx.setFillStyle('#0F2350')
          ctx.setFontSize(18)
          ctx.fillText(label, x + 18, y + ch - 42, cw - 36)
          ctx.setFillStyle('#64748B')
          ctx.setFontSize(15)
          ctx.fillText((item.type === 'tool' ? 'T/' : 'M/') + item.id + (item.loc ? ' · ' + item.loc.slice(0, 8) : ''), x + 18, y + ch - 18, cw - 36)
        })
        // 再逐格绘制二维码本体，位置在标签上半区
        for (let idx = 0; idx < slice.length; idx++) {
          const item = slice[idx]
          const col = idx % COLS, row = Math.floor(idx / COLS)
          const cw = PAGE_W / COLS, ch = PAGE_H / ROWS
          const qrSize = Math.min(cw - 40, ch - 80)
          await new Promise(res => {
            drawQr({
              ctx,
              x: col * cw + (cw - qrSize) / 2,
              y: row * ch + 16,
              width: qrSize, height: qrSize,
              text: codeUtil.parseItemCode('ITEM:' + item.id),
              background: '#FFFFFF', foreground: '#0F2350',
              callback: res
            })
          })
        }
        await new Promise(res => ctx.draw(false, res))
        const filePath = await new Promise((res, rej) => {
          wx.canvasToTempFilePath({ canvasId: 'qrBatch', destWidth: PAGE_W * 2, destHeight: PAGE_H * 2, success: r => res(r.tempFilePath), fail: rej })
        })
        images.push({ path: filePath, index: p + 1, count: slice.length })
      }
      wx.hideLoading()
      this.setData({ busy: false, pageImages: images })
      wx.showToast({ title: '已生成 ' + images.length + ' 页', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      this.setData({ busy: false })
      wx.showModal({
        title: '生成失败',
        content: (e && e.errMsg) || (e && e.message) || '二维码绘制失败，请减少勾选数量后重试',
        showCancel: false
      })
    }
  },
  preview(e) {
    const idx = Number(e.currentTarget.dataset.idx) || 0
    const urls = this.data.pageImages.map(x => x.path)
    wx.previewImage({ current: urls[idx], urls })
  },
  saveAll() {
    const imgs = this.data.pageImages
    if (!imgs.length) return
    if (this.data._saveBusy) return
    this.setData({ _saveBusy: true })
    let done = 0, failed = 0
    let denied = false   // 相册权限被拒：整批都存不了，只提示一次
    let told = false
    const finish = () => {
      this.setData({ _saveBusy: false })
      if (denied && !told) {
        told = true
        wx.showModal({
          title: '需要相册权限',
          content: '请在小程序设置中允许「保存到相册」，或长按预览图手动保存。',
          showCancel: false
        })
        return
      }
      wx.showToast({ title: failed ? ('保存 ' + done + ' 张，失败 ' + failed + ' 张') : ('已保存 ' + done + ' 张到相册'), icon: 'none' })
    }
    imgs.forEach(im => {
      wx.saveImageToPhotosAlbum({
        filePath: im.path,
        success: () => { done++; if (done + failed === imgs.length) finish() },
        fail: (e) => {
          failed++
          if (/auth deny|authorize|deny/i.test((e && e.errMsg) || '')) denied = true
          if (done + failed === imgs.length) finish()
        }
      })
    })
  }
})
