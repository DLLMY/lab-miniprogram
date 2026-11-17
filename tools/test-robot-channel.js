'use strict'
// ============================================================
// WorkBuddy 机器通道身份安全 回归套件
// ============================================================
// 目标：确保「老师用密钥绑定 WorkBuddy」时只能操作本人权限内数据，
//       杜绝误用超级钥匙 / 无效密钥 / 已吊销密钥造成的越权。
//
// 覆盖：
//   A 机器通道 fail-closed：带 robotKey 却解析不到身份 → 401，绝不降级为 full 全通
//   B robotIdentity 四套实现一致（云函数生产/mock、前端 mock、MCP 工具）
//   C 身份裁决：super/key/微信三通道的角色与可见范围标签正确
//   D MCP 连接器：超级钥匙启动警告 + lab_whoami 工具存在
//   E 密钥管理动作禁止在机器人通道远程改写
//
// 运行：node tools/test-robot-channel.js

const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'cloudfunctions', 'docsProxy')
const ds = require(path.join(SRC, 'data-scope.js'))

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}
function section(t) { console.log('\n--- ' + t + ' ---') }

const idx = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8')
const mockJs = fs.readFileSync(path.join(ROOT, 'utils', 'mock.js'), 'utf8')
const mcpJs = fs.readFileSync(path.join(ROOT, 'mcp', 'docs-proxy-server.js'), 'utf8')
const integMd = path.join(ROOT, 'docs', 'workbuddy-integration.md')

section('A 机器通道 fail-closed（核心越权闸）')
// 定位 prodHandler 中身份解析后的 fail-closed 块，必须存在于两个反查分支之后、scopeOf 之前
const afterKeyLookup = idx.indexOf("if (!me && robotMode === 'key')")
const failClosedAt = idx.indexOf('if (robotMode && !me)')
const scopeAt = idx.indexOf('const scope = ds.scopeOf(me)', afterKeyLookup)
ok('存在 robotMode && !me 的 fail-closed 判断', failClosedAt > 0)
ok('fail-closed 位于身份反查之后', failClosedAt > afterKeyLookup)
ok('fail-closed 位于 scopeOf 之前', failClosedAt > 0 && scopeAt > failClosedAt)
const fcBlock = idx.slice(failClosedAt, failClosedAt + 700)
ok('无效密钥返回 401', /code:\s*401/.test(fcBlock))
ok('已吊销密钥有明确文案（重新生成个人密钥）', /重新生成个人密钥|密钥无效或已吊销/.test(fcBlock))
ok('拒绝时写审计日志', /console\.warn/.test(fcBlock))

section('B robotIdentity 四套实现一致')
ok('生产 dispatch 实现 robotIdentity', /case 'robotIdentity':/.test(idx.slice(idx.indexOf('async function prodDispatch'))))
ok('云端 mockHandler 实现 robotIdentity',
  /case 'robotIdentity':/.test(idx.slice(idx.indexOf('function mockHandler'), idx.indexOf('async function prodHandler'))))
ok('前端 mock.js 实现 robotIdentity', /case 'robotIdentity'/.test(mockJs))
ok('MCP 暴露 lab_whoami 工具', /name: 'lab_whoami'/.test(mcpJs))
ok('MCP lab_whoami 映射到 robotIdentity', /lab_whoami'\)\s+out\s*=\s*await doCall\('robotIdentity'/.test(mcpJs))

section('C 身份裁决标签正确（super / key / 微信）')
const prodAt = idx.indexOf('async function prodDispatch')
const riBlock = idx.slice(idx.indexOf("case 'robotIdentity':", prodAt), idx.indexOf("case 'robotKeyStatus':", prodAt))
ok('super 通道标注为全局超级钥匙', /超级钥匙/.test(riBlock))
ok('key 通道标注为个人机器人密钥', /个人机器人密钥/.test(riBlock))
ok('scopeFull 由 scopeOf 推导（不硬编码）', /const sc = ds\.scopeOf\(me\)/.test(riBlock))
ok('super 通道给出醒目越权警告', /warning:[\s\S]{0,200}超级管理员通道/.test(riBlock))
ok('未配带班老师给出失明警告', /未配置带班班级|未配置带班/.test(riBlock))
// 用真实 scopeOf 校验标签底层数据一致
const teacher = { id: 'WT013', name: '彭满易', role: 'teacher', cls: '2024级电气1班', managedClasses: '2024级电气1班' }
const scT = ds.scopeOf(teacher)
ok('教师 scope 非 full（确实被隔离）', scT.full === false)
ok('教师可见班级=本人带班', JSON.stringify(scT.classes) === JSON.stringify(['2024级电气1班']))
const scSuper = ds.scopeOf({ id: 'T001', name: '超管', role: 'super', cls: '' })
ok('super scope full=true（super 全通是设计如此）', scSuper.full === true)
const scNull = ds.scopeOf(null)
ok('未登录 scope full=true —— 正是必须靠 fail-closed 拦截的原因', scNull.full === true)

section('D MCP 连接器超级钥匙警示')
const mainBlock = mcpJs.slice(mcpJs.indexOf('function main()'))
const looksPersonal = /const looksPersonal = \/\^\[0-9a-f\]\{48\}\$\/\.test\(ROBOT_KEY\)/.test(mainBlock)
ok('按 48 位 hex 识别个人密钥', looksPersonal)
ok('非个人密钥发出超级钥匙警告', /全局超级钥匙/.test(mainBlock))
ok('警告提示不可分发给普通教师', /绝不可把本配置|分发给普通教师/.test(mainBlock))
ok('警告提示先调用 lab_whoami', /lab_whoami/.test(mainBlock))

section('E 密钥生命周期仅微信端可改')
// 逐个 case 切片：从各自 case 起点到下一个 case，验证内部含 robotMode 拒绝
function caseBlock(name) {
  const start = idx.indexOf("case '" + name + "':", prodAt)
  if (start < 0) return ''
  const next = idx.indexOf("case '", start + 10)
  return idx.slice(start, next > 0 ? next : start + 800)
}
const GUARD = /if \(robotMode\)[\s\S]{0,80}密钥管理仅限在小程序/
ok('robotKeyStatus 禁止机器人通道', GUARD.test(caseBlock('robotKeyStatus')))
ok('genRobotKey 禁止机器人通道', GUARD.test(caseBlock('genRobotKey')))
ok('revokeRobotKey 禁止机器人通道', GUARD.test(caseBlock('revokeRobotKey')))
ok('密钥哈希反查存在', /findUserByRobotKey/.test(idx))

section('F 文档口径')
if (fs.existsSync(integMd)) {
  const doc = fs.readFileSync(integMd, 'utf8')
  ok('文档区分个人密钥与超级钥匙', /教师个人密钥/.test(doc) && /全局超级钥匙/.test(doc))
  ok('文档明确超级钥匙不分发教师', /绝不共享超级钥匙|不发教师/.test(doc))
} else {
  ok('集成文档存在', false, integMd)
}

console.log('\n' + '='.repeat(52))
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败')
console.log('='.repeat(52))
process.exit(fail ? 1 : 0)
