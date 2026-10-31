// 前端导出链路定向验证：utils/export.js 的「演示数据」警示。
// 注入 api 桩（控制云端返回 src）与 wx 桩（捕获 showModal），验证：
//   ① 云端 src='mock'（USE_MOCK 仍开）→ 成功弹窗必须标注「演示数据」
//   ② 云端 src='cloud'（真实腾讯文档）→ 弹窗不得出现演示字样（避免误报打扰）
'use strict'
const path = require('path')

let pass = 0, fail = 0
const A = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')) }
}

// —— wx 桩 ——
let lastModal = null
global.wx = {
  showLoading: () => {},
  hideLoading: () => {},
  showModal: (o) => { lastModal = o },
  setClipboardData: (o) => (o.success ? o.success({}) : o.fail && o.fail(new Error('x'))),
  env: { USER_DATA_PATH: '/tmp' },
  getFileSystemManager: () => ({ writeFile: (o) => (o.success ? o.success({}) : o.fail && o.fail(new Error('x'))) }),
  shareFileMessage: (o) => (o.success ? o.success({}) : o.fail && o.fail(new Error('x')))
}

// —— api 桩：cloudSrc 决定云端返回的数据来源标记 ——
let cloudSrc = 'mock'
const apiPath = require.resolve(path.join(__dirname, '..', 'utils', 'api.js'))
require.cache[apiPath] = {
  id: apiPath, filename: apiPath, loaded: true,
  exports: {
    callFull: async () => ({ code: 0, src: cloudSrc, data: { filename: '耗材库存清单_20261025.csv', csv: '\uFEFF耗材ID,名称\nM001,电阻包\n', count: 2 } }),
    isDemoData: () => cloudSrc === 'mock'
  }
}

const exporter = require(path.join(__dirname, '..', 'utils', 'export.js'))

;(async () => {
  console.log('=== 前端导出：演示数据必须被标注 ===')
  cloudSrc = 'mock'
  lastModal = null
  await exporter.run('materials', false, '导出中…')
  A('导出后弹出了结果框', !!lastModal, 'lastModal=' + lastModal)
  A('标题标注「演示数据」', !!lastModal && lastModal.title.indexOf('演示数据') >= 0, lastModal && lastModal.title)
  A('正文提示勿用于上报核对', !!lastModal && lastModal.content.indexOf('演示') >= 0 && lastModal.content.indexOf('上报') >= 0,
    lastModal && lastModal.content)
  A('仍告知文件名（用户可核对）', !!lastModal && lastModal.content.indexOf('耗材库存清单_20261025.csv') >= 0)

  console.log('\n=== 前端导出：真实数据不得误报演示 ===')
  cloudSrc = 'cloud'
  lastModal = null
  await exporter.run('materials', false, '导出中…')
  A('弹出了结果框', !!lastModal)
  A('标题不含「演示数据」', !!lastModal && lastModal.title.indexOf('演示') < 0, lastModal && lastModal.title)
  A('正文不含演示提示', !!lastModal && lastModal.content.indexOf('演示') < 0, lastModal && lastModal.content)

  console.log('\n=== 结果 ===')
  console.log('pass=' + pass + ' fail=' + fail)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('运行异常:', e); process.exit(2) })
