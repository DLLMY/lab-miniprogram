// utils/export.js —— CSV 导出（前端部分）
//
// 云函数侧已把数据拼成 CSV 文本（tencentdocs.js exportData），这里负责在小程序里交付给用户。
// 小程序不能直接"下载到手机相册/文件管理"，实际可交付的三条路：
//   1) 复制到剪贴板 —— 粘贴进 Excel/WPS 即用，最省事、成功率最高（默认走这条）
//   2) 写入本地临时文件后转发给微信好友/文件传输助手（wx.shareFileMessage）
//   3) 失败降级：把前若干行预览出来，至少能看到内容
// 注意：CSV 在 OpenDocument 的 fileType 白名单里没有，不能走 wx.openDocument 预览。
const api = require('./api.js')

// kind: materials | tools | stock_io | requisitions | borrow | logs
async function fetchCsv(kind) {
  // 用 callFull + noFallback：导出失败时给明确错误。
  // 更要紧的是——传输失败时绝不回退到 mock，否则导出的会是演示数据，
  // 用户却以为是真实台账拿去上报，这种"看起来成功"的错误比报错严重得多。
  const r = await api.callFull('exportData', { kind }, { noFallback: true })
  if (!r || r.code !== 0) throw new Error((r && r.data && r.data.msg) || (r && r.msg) || '导出失败：云端未返回数据')
  const d = r.data || {}
  if (!d.csv) throw new Error('导出失败：返回内容为空')
  // 数据来源判定：云函数已部署但仍是 USE_MOCK（src='mock'）时，云端会正常返回 code=0，
  // 导出内容是演示台账而非真实腾讯文档数据。这种情况必须随交付一起告知——
  // 用户要把 CSV 粘进 Excel 交给教务核对，弹一句「导出成功」是不够的。
  const demo = (r.src === 'mock') || api.isDemoData()
  return { filename: d.filename || (kind + '.csv'), csv: d.csv, count: d.count || 0, demo }
}

// 方式一：复制到剪贴板（默认）
async function copy(kind) {
  const { filename, csv, count, demo } = await fetchCsv(kind)
  await new Promise((res, rej) => wx.setClipboardData({ data: csv, success: res, fail: rej }))
  return { filename, count, via: 'clipboard', demo }
}

// 方式二：写临时文件并拉起转发（发给文件传输助手/微信好友，电脑上另存为即可）
async function share(kind) {
  const { filename, csv, count, demo } = await fetchCsv(kind)
  const path = wx.env.USER_DATA_PATH + '/' + filename
  await new Promise((res, rej) => {
    const fs = wx.getFileSystemManager()
    fs.writeFile({ filePath: path, data: csv, encoding: 'utf8', success: res, fail: rej })
  })
  // writeFile 有 10MB 上限，超限报错提前，避免用户对着一个空转发界面发懵
  await new Promise((res, rej) => wx.shareFileMessage({ filePath: path, success: res, fail: rej }))
  return { filename, count, via: 'share', demo }
}

// 带 loading 的统一入口：让用户知道在忙，也防止连点
async function run(kind, viaShare, title) {
  wx.showLoading({ title: title || '导出中…', mask: true })
  try {
    const r = viaShare ? await share(kind) : await copy(kind)
    wx.hideLoading()
    // 演示数据必须在成功弹窗里显式标注：CSV 一旦粘进 Excel 交给教务核对，
    // 用户就没有机会再分辨它是演示台账还是真实台账了。
    const demoTip = r.demo
      ? '【演示模式】本次导出来自演示数据，不是真实腾讯文档台账，请勿直接用于上报核对。\n\n'
      : ''
    wx.showModal({
      title: (r.demo ? '导出成功（演示数据 ' : '导出成功（') + r.count + ' 条）',
      content: demoTip + (viaShare
        ? '文件 ' + r.filename + ' 已准备好，可在弹出的转发里发给「文件传输助手」或微信好友。'
        : '内容已复制到剪贴板，打开电脑上的 Excel / WPS 表格粘贴即可。文件名：' + r.filename),
      showCancel: false,
      confirmText: '知道了'
    })
    return r
  } catch (e) {
    wx.hideLoading()
    const msg = e && e.errMsg && /auth deny|permission/.test(e.errMsg) ? '需要允许粘贴板权限' : (e.message || '导出失败')
    wx.showModal({ title: '导出失败', content: msg, showCancel: false, confirmText: '知道了' })
    throw e
  }
}

module.exports = { run, copy, share, fetchCsv }
