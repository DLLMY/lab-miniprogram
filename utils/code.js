// 物品码统一解析：本系统生成的二维码是 "ITEM:<ID>"，第三方条码/二维码可能是
// 纯 ID 或带 ?id= 的 URL。大小写与首尾空格一律归一，否则实物标签印成小写、
// 机器人传参带空格时都会查不到物品。
// 首页扫码、出入库连续扫码、二维码批量打印后的回扫校验共用同一份规则。
function parseItemCode(raw) {
  let s = ('' + (raw || '')).trim()
  if (!s) return ''
  const m = s.match(/[?&]id=([^&]+)/i)
  if (m) {
    try { s = decodeURIComponent(m[1]) } catch (e) { s = m[1] }
  }
  const p = s.match(/^ITEM[:：]\s*(.+)$/i)
  if (p) s = p[1]
  return s.trim().toUpperCase()
}

module.exports = { parseItemCode }
