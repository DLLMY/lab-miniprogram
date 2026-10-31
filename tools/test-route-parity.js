// 云函数路由对齐检查：mockHandler 有的 action，prodHandler 必须也有。
// ---------------------------------------------------------------------------
// 为什么要有这个脚本：
//   「库存盘点 / 期初建账」功能实现了 tencentdocs.stocktake 与 mockHandler 两处，
//   却漏了 prodHandler 路由 → 生产环境点该页面必然落到 default 分支返回
//   {code:404, msg:'unknown action'}，功能在生产完全不可用。
//   mock 与 prod 两套路由是手写两份，天然会漂移；本脚本把漂移变成可自动拦截的失败。
//   另一个漂移方向同样致命：prod 里的某个 action 忘了加鉴权闸（gStaff/gAdmin），
//   演示模式（无鉴权）看不出来，生产却会越权 —— 故一并检查。
// 用法：node tools/test-route-parity.js
'use strict'
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'cloudfunctions', 'docsProxy', 'index.js')
const src = fs.readFileSync(FILE, 'utf8')
const lines = src.split('\n')

// 切分 mockHandler / prodHandler 两段
const mockStart = lines.findIndex(l => /function mockHandler\(/.test(l))
const prodStart = lines.findIndex(l => /async function prodHandler\(/.test(l))
if (mockStart < 0 || prodStart < 0) { console.error('未能定位 mockHandler / prodHandler'); process.exit(2) }

function casesIn(from, to) {
  const out = []
  for (let i = from; i < to && i < lines.length; i++) {
    const m = /case '([^']+)':/.exec(lines[i])
    if (m) out.push({ action: m[1], line: i + 1, text: lines[i] })
  }
  return out
}
const mockCases = casesIn(mockStart, prodStart)
const prodCases = casesIn(prodStart, lines.length)

// prodHandler 入口处还有「前置于 switch 的 if (action === 'xxx')」分支（如 fresh），
// 也要算作路由，否则会误报「mock 有 prod 缺」。
const prodPre = []
for (let i = prodStart; i < prodStart + 90 && i < lines.length; i++) {
  const m = /if \(action === '([^']+)'\)/.exec(lines[i])
  if (m) prodPre.push({ action: m[1], line: i + 1, text: lines[i] })
}
const prodAll = prodCases.concat(prodPre)

let pass = 0, fail = 0
const A = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')) }
}

console.log('=== 云函数路由对齐（mockHandler ↔ prodHandler）===')
console.log('  mockHandler action: ' + mockCases.length + ' 个 | prodHandler action: ' + prodCases.length + ' 个')

// ① mock 有而 prod 缺 → 生产不可用
const prodActions = prodAll.map(c => c.action)
const missing = mockCases.filter(c => !prodActions.includes(c.action))
A('mock 有的 action 在 prod 全部有路由', missing.length === 0,
  missing.map(m => m.action + '(mock@' + m.line + ')').join(', '))

// ② prod 有的 action 在 mock 缺 → 演示模式会 404，验收现场难解释
const mockActions = mockCases.map(c => c.action)
const onlyProd = prodCases.filter(c => !mockActions.includes(c.action))
A('prod 有的 action 在 mock 全部有实现', onlyProd.length === 0,
  onlyProd.map(m => m.action + '(prod@' + m.line + ')').join(', '))

// ③ 写路径必须有鉴权闸：写 action 在 prod 中必须出现 gStaff/gAdmin/!me/身份覆盖
//    （鉴权既可能在 case 内，也可能在 switch 之前的入口统一处理，两者都算通过）
//    注：bindLogin 本身就是登录入口，其安全由 tencentdocs.bindLogin 内的
//    「工号+姓名校验 + openid 1:1 双向唯一 + 409 冲突保护」保证，不要求路由层加闸。
const WRITE_ACTIONS = ['requisition', 'toolRequisition', 'approve', 'io', 'batchIo', 'borrow',
  'returnTool', 'reverseIO', 'cancelReq', 'stocktake', 'addMaterial', 'adminUpsertUser',
  'adminDeleteUser', 'access', 'fresh',
  // 实训室归属管理体系写路径
  'addLab', 'updateLab', 'deleteLab', 'addRepair', 'updateRepair', 'addInspection', 'updateInspection']
const gateIn = (from, to) => lines.slice(from, to).join(' ')
const preGate = gateIn(prodStart, prodStart + 90)
const noGate = []
for (const a of WRITE_ACTIONS) {
  const c = prodAll.find(x => x.action === a)
  if (!c) { noGate.push(a + '(无路由)'); continue }
  const seg = lines.slice(c.line - 1, c.line + 3).join(' ') + ' ' + preGate
  if (!/gStaff|gAdmin|!me|deny\(|data\.user = me\.id|data\.actor = me\.id/.test(seg)) {
    noGate.push(a + '(prod@' + c.line + ')')
  }
}
A('写路径 action 均有鉴权闸或身份覆盖', noGate.length === 0, noGate.join(', '))

// ④ 管理员专属数据不得从 staff 级接口漏出
const exportCase = prodAll.find(x => x.action === 'exportData')
const exportSeg = exportCase ? lines.slice(exportCase.line - 1, exportCase.line + 8).join(' ') : ''
A('exportData 按 kind 分级鉴权（logs/access 需管理员）',
  !!exportCase && /adminOnly/.test(exportSeg) && /gAdmin/.test(exportSeg),
  exportSeg.trim().slice(0, 110))

// ⑤ diag 必须鉴权（否则匿名可打生产腾讯文档 API 配额）
const diagIdx = lines.findIndex(l => /action === 'diag'/.test(l))
const diagSeg = diagIdx >= 0 ? lines.slice(diagIdx, diagIdx + 12).join(' ') : ''
A('diag 需登录后才能调用', /!diagMe|!me/.test(diagSeg), diagSeg.slice(0, 90))

console.log('\npass=' + pass + ' fail=' + fail)
process.exit(fail ? 1 : 0)
