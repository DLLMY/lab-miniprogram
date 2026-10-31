// tools/test-backend-switch.js
// 校验 backend-switch.js 的后端选择与冗余回退链（纯逻辑，零外部依赖、零网络）。
// 重点：① 默认/强制/凭证缺失的组合解析正确；② 选 cloud 但 clouddb.js 不存在时优雅跳过，不崩溃。
'use strict'
const bs = require('../cloudfunctions/docsProxy/backend-switch.js')

let pass = 0, fail = 0
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + ' → 期望 ' + w + ' 实际 ' + g) }
}

// 模拟 require：tencentdocs / clouddb 存在（返回占位模块），其余抛错
function reqAll(p) { return {} }
// clouddb 缺失的 require：碰到 clouddb.js 抛错，其余正常
function reqNoCloud(p) { if (p.indexOf('clouddb') >= 0) throw new Error('Cannot find module ' + p); return {} }

function build(envObj, requireFn) { return bs.buildChain(envObj, requireFn) }
function envObj(over) {
  const base = { RAW_USE_MOCK: undefined, RAW_DATA_BACKEND: 'tencent', RAW_FALLBACK: 'on',
    HAS_CREDENTIAL: false, FORCE_MOCK: false, FORCE_REAL: false, AUTO_FALLBACK: true }
  return Object.assign(base, over)
}

console.log('=== backend-switch 冗余回退链测试 ===')

// A. 默认（无凭证）→ 自动降级 mock
eq('A 默认无凭证→主后端mock', build(envObj({})).kinds, ['mock'])

// B. 强制 mock
eq('B USE_MOCK=true→mock', build(envObj({ RAW_USE_MOCK: 'true', FORCE_MOCK: true })).kinds, ['mock'])

// C. 强制真实+有凭证+tencent → tencent→mock
eq('C tencent+凭证→[tencent,mock]',
  build(envObj({ RAW_USE_MOCK: 'false', FORCE_MOCK: false, FORCE_REAL: true, HAS_CREDENTIAL: true }), reqAll).kinds,
  ['tencent', 'mock'])

// D. cloud+有凭证+clouddb存在 → cloud→tencent→mock
eq('D cloud+clouddb存在→[cloud,tencent,mock]',
  build(envObj({ RAW_DATA_BACKEND: 'cloud', HAS_CREDENTIAL: true }), reqAll).kinds,
  ['cloud', 'tencent', 'mock'])

// E. cloud+clouddb缺失 → 优雅跳过 cloud，落到 tencent→mock（不崩溃）
eq('E cloud但clouddb缺失→[tencent,mock]',
  build(envObj({ RAW_DATA_BACKEND: 'cloud', HAS_CREDENTIAL: true }), reqNoCloud).kinds,
  ['tencent', 'mock'])

// F. FALLBACK=off + tencent → 仅 [tencent]
eq('F FALLBACK=off→[tencent]',
  build(envObj({ RAW_USE_MOCK: 'false', FORCE_REAL: true, HAS_CREDENTIAL: true, RAW_FALLBACK: 'off', AUTO_FALLBACK: false }), reqAll).kinds,
  ['tencent'])

// G. cloud+clouddb存在+FALLBACK=off → 仅 [cloud]
eq('G cloud+FALLBACK=off→[cloud]',
  build(envObj({ RAW_DATA_BACKEND: 'cloud', HAS_CREDENTIAL: true, RAW_FALLBACK: 'off', AUTO_FALLBACK: false }), reqAll).kinds,
  ['cloud'])

// H. 未知 DATA_BACKEND 值 → 回退到 tencent
eq('H 非法DATA_BACKEND→tencent主后端',
  build(envObj({ RAW_DATA_BACKEND: 'xxxxx', HAS_CREDENTIAL: true })).PRIMARY, 'tencent')

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
