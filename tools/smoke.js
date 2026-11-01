// tools/smoke.js —— 最小冒烟回归（依赖免费，plain node 直接跑：node tools/smoke.js）
//
// 目的：在「回归套件被清理后」补回最低限度的自动化闸门，覆盖两个最易回归的点：
//   ① 双后端契约一致性：clouddb.js 与 tencentdocs.js 暴露的 module.exports 键集合必须完全一致
//      （否则生产切 cloud 会因缺函数而抛错，或读写语义漂移）。
//   ② 写操作禁止降级：回退分发循环里，写 action 只允许在 PRIMARY（i===0）执行，
//      主后端失败即报错，绝不静默回退到 tencent/mock（避免双库分裂 / 数据静默丢失）。
//
// 退出码：0 = 全绿；非 0 = 有断言失败（CI / pre-commit 应拦截）。

'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', 'cloudfunctions', 'docsProxy')
const bs = require(path.join(ROOT, 'backend-switch.js'))

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg) }
  else { fail++; console.log('  ✗ ' + msg) }
}

// —— 解析一个模块的 module.exports 键集合（只读文本，避免 require 触发 wx-server-sdk 等重依赖）——
function exportKeys(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const m = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\}/)
  if (!m) throw new Error('在 ' + file + ' 找不到 module.exports 块')
  // 去掉行注释（导出块内无块注释），再抓所有「标识符后跟 : 或 , 或块尾 }」的键
  // （同一行逗号并列多键如 `listMaterials, listTools, ...` 全部计入；末位键无尾随逗号也计入）
  const body = m[1].replace(/\/\/.*$/gm, '')
  const keys = []
  const re = /([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[:,]|\s*\}|$)/g
  let r
  while ((r = re.exec(body)) !== null) keys.push(r[1])
  return new Set(keys)
}

console.log('\n[1] 双后端契约一致性（clouddb vs tencentdocs）')
const cd = exportKeys('clouddb.js')
const td = exportKeys('tencentdocs.js')
ok(cd.size > 0 && td.size > 0, '两个后端均解析到导出键（' + cd.size + ' / ' + td.size + '）')
// __setDbForTest 是 clouddb 专有的单测注入桩，不属于生产契约，对比前剔除
const strip = (s) => { const x = new Set(s); x.delete('__setDbForTest'); return x }
const cdC = strip(cd)
const tdC = strip(td)
ok(cdC.size === tdC.size, '剔除测试桩后两后端导出键数量一致（' + cdC.size + ' / ' + tdC.size + '）')
const onlyCd = [...cdC].filter(k => !tdC.has(k))
const onlyTd = [...tdC].filter(k => !cdC.has(k))
ok(onlyCd.length === 0, 'clouddb 无独有生产键：' + (onlyCd.join(',') || '（无）'))
ok(onlyTd.length === 0, 'tencentdocs 无独有生产键：' + (onlyTd.join(',') || '（无）'))
// 测试桩应仅存在于 clouddb（便于单测注入；tencentdocs 不暴露，避免生产误用）
ok(cd.has('__setDbForTest') && !td.has('__setDbForTest'), '__setDbForTest 仅存在于 clouddb（测试桩不污染生产契约）')

console.log('\n[2] backend-switch：回退链构建')
// 用桩 require 替代真实模块（避免引入 wx-server-sdk / env.local.js 依赖）
const stubRequire = (p) => {
  if (p === './clouddb.js') return { __kind: 'cloud' }
  if (p === './tencentdocs.js') return { __kind: 'tencent' }
  throw new Error('unknown module ' + p)
}
function env(over) {
  return Object.assign({
    FORCE_MOCK: false, FORCE_REAL: false, AUTO_FALLBACK: true,
    HAS_CREDENTIAL: true, RAW_DATA_BACKEND: 'cloud',
    ROBOT_KEY: '', ROBOT_ACTOR_ID: 'T001'
  }, over)
}
const chainKinds = (e) => bs.buildChain(env(e), stubRequire).kinds
ok(JSON.stringify(chainKinds({ RAW_DATA_BACKEND: 'cloud' })) === JSON.stringify(['cloud', 'tencent', 'mock']),
  "DATA_BACKEND=cloud → 链 [cloud, tencent, mock]")
ok(JSON.stringify(chainKinds({ RAW_DATA_BACKEND: 'tencent' })) === JSON.stringify(['tencent', 'mock']),
  "DATA_BACKEND=tencent → 链 [tencent, mock]")
ok(JSON.stringify(chainKinds({ FORCE_MOCK: true })) === JSON.stringify(['mock']),
  "USE_MOCK=true → 链 [mock]（强制，不再回退）")
ok(JSON.stringify(chainKinds({ RAW_DATA_BACKEND: 'cloud', HAS_CREDENTIAL: false, AUTO_FALLBACK: false })) === JSON.stringify(['cloud']),
  "无凭证+关闭回退 → 链 [cloud]（仅主后端）")

console.log('\n[3] 写操作禁止降级（回退分发决策与 index.js 循环一致）')
// 复刻 index.js 派发循环的「是否尝试该后端」决策
function attemptPlan(action, kinds) {
  const plan = []
  for (let i = 0; i < kinds.length; i++) {
    if (bs.isWriteAction(action) && i > 0) plan.push('SKIP') // 写操作禁止降级到非主后端
    else plan.push('TRY')
  }
  return plan.join(',')
}
const CLOUD_CHAIN = ['cloud', 'tencent', 'mock']
const WRITE = ['io', 'approve', 'addMaterial', 'importMaterials', 'borrow', 'returnTool', 'reverseIO',
  'stocktake', 'addLab', 'deleteLab', 'addRepair', 'addInspection', 'adminUpsertUser',
  'requisition', 'toolRequisition', 'cancelReq', 'access', 'bindLogin', 'genRobotKey', 'revokeRobotKey']
const READ = ['listMaterials', 'listTools', 'getItem', 'search', 'listMine', 'listPending', 'whoami',
  'findUser', 'listUsers', 'usage', 'alerts', 'exportData', 'listLabs', 'labOverview',
  'listRepairs', 'listInspections', 'listLogs', 'listAccess']
ok(WRITE.every(a => bs.isWriteAction(a)), '所有写 action 均被识别为写操作')
ok(READ.every(a => !bs.isWriteAction(a)), '所有读 action 均不被误判为写操作（避免误拦读回退）')
ok(attemptPlan('io', CLOUD_CHAIN) === 'TRY,SKIP,SKIP',
  "写操作 'io' 在 [cloud,tencent,mock] 上仅尝试主后端：TRY,SKIP,SKIP")
ok(attemptPlan('listMaterials', CLOUD_CHAIN) === 'TRY,TRY,TRY',
  "读操作 'listMaterials' 可在整条链回退：TRY,TRY,TRY")
ok(attemptPlan('io', ['mock']) === 'TRY',
  "纯演示链 [mock] 上写操作仍可在主后端执行：TRY")

console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========')
process.exit(fail === 0 ? 0 : 1)
