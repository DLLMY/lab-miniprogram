// utils/idem.js
// 幂等命中提示（纯函数，不依赖 wx / getApp，便于云函数、前端与测试共用同一实现）。
//
// 背景（2026-11-17 第十七轮）：后端在 5 秒幂等窗口内判定为「重复提交（相同内容）」时，
// 会给结果带上 idem/deduped 标记。此时绝不能让前端显示成普通的"成功"——
// 老师会看到两次「入库成功」，实际只入了一次（并发双击 / 弱网重试），
// 账面与实物就此对不上。所以必须明确告知「本次未重复执行」。
//
// 标记位置：后端同时放在结果顶层与 data 里（各 action 的载荷位置不统一），
// 这里两处都读，任一命中即认为是重复提交。
function idemWarn(res) {
  if (!res || typeof res !== 'object') return ''
  const d = res.data
  const inData = !!(d && typeof d === 'object' && (d.idem || d.deduped))
  const inTop = !!(res.idem || res.deduped)
  if (!inData && !inTop) return ''
  const w = (d && typeof d === 'object' && d.warn) || res.warn
  return w || '检测到重复提交（相同内容），本次未重复执行'
}

module.exports = { idemWarn }
