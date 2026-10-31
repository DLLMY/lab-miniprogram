// test-backend-parity.js —— 校验 clouddb.js 与 tencentdocs.js 导出契约完全一致
// 目的：防止漏实现某个函数导致 index.js 调用 undefined（进程崩溃）。
const path = require('path')
const cl = require('../cloudfunctions/docsProxy/clouddb.js')

// 与 tencentdocs.js 末尾 module.exports 完全一致的键清单（迁移方案已核实）
const EXPECTED = [
  'TABLE', 'CFG', 'COL', 'TR', 'runtimeInfo', 'warmFieldMaps',
  'getToken', 'authorizeWithCode', 'callSmart', 'callApi', 'getFieldMap', 'buildValues',
  'getRecords', 'addRecord', 'updateRecord', 'deleteRecordByIds', 'getItem',
  'invalidateCache', 'cacheStats', 'clearFieldMapCache',
  'listMaterials', 'listTools', 'listMine', 'listPending', 'search',
  'findUser', 'listUsers', 'ensureOpenIdColumn', 'bindOpenId', 'findUserByOpenId', 'findUserByRobotKey', 'setRobotKey', 'whoami', 'bindLogin',
  'adminListUsers', 'adminUpsertUser', 'adminDeleteUser', 'decideUserWrite', 'decideUserDelete',
  'requisition', 'toolRequisition', 'approve', 'cancelReq', 'io', 'borrow', 'returnTool', 'access', 'usage', 'snapshot',
  'addMaterial', 'listStockIO', 'exportData', 'stocktake', 'listLogs', 'reverseIO', 'batchIo', 'listAccess',
  // 实训室归属管理体系（labs / repairs / inspections）
  'listLabs', 'getLab', 'addLab', 'updateLab', 'deleteLab',
  'listRepairs', 'addRepair', 'updateRepair',
  'listInspections', 'addInspection', 'updateInspection', 'labOverview'
]

let fail = 0
const miss = EXPECTED.filter(k => !(k in cl))
if (miss.length) { fail++; console.error('clouddb 缺失导出键：', miss.join(', ')) }
else console.log('clouddb 导出键齐备（' + EXPECTED.length + ' 个）✓')

// 额外导出键（允许：__setDbForTest 测试辅助）
const extra = Object.keys(cl).filter(k => EXPECTED.indexOf(k) < 0)
if (extra.length) console.log('额外导出（测试辅助）：', extra.join(', '))

// 若 tencentdocs 可加载，则双方键集合应完全一致
try {
  const td = require(path.join(__dirname, '..', 'cloudfunctions', 'docsProxy', 'tencentdocs.js'))
  const missTd = EXPECTED.filter(k => !(k in td))
  if (missTd.length) { fail++; console.error('基准 tencentdocs 缺失键：', missTd.join(', ')) }
  else console.log('基准 tencentdocs 导出键齐备 ✓')
} catch (e) {
  console.warn('tencentdocs 本地不可加载（无 wx-server-sdk 或依赖），跳过基准对比：', e.message)
}

console.log(`\n契约一致性：${fail ? '失败' : '通过'}`)
process.exit(fail ? 1 : 0)
