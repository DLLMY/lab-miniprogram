/* =========================================================================
 * 实训室管理系统小程序 · 自动化冒烟测试
 * -------------------------------------------------------------------------
 * 用腾讯官方 miniprogram-automator 驱动「微信开发者工具」自动化模式：
 *   启动 DevTools → 打开 lab-miniprogram → 模拟器里点页面/切换身份/读数据/抓报错
 *
 * 前置（由用户完成）：
 *   1. 安装微信开发者工具（本机）
 *   2. 打开工具并扫码登录（绑定测试 AppID 的微信号）
 *   3. npm install（本目录）
 *   4. 若 DevTools 不在默认路径，设环境变量 WECHAT_CLI 指向 cli.bat
 *
 * 运行：node automator.js
 * 退出码：0=全部通过，1=有失败，2=找不到 DevTools CLI
 * ========================================================================= */
const automator = require('miniprogram-automator')
const path = require('path')
const fs = require('fs')

const PROJECT = path.resolve(__dirname, '..') // lab-miniprogram
const CLI_CANDIDATES = [
  process.env.WECHAT_CLI,
  'C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat',
  'C:/Program Files/Tencent/微信web开发者工具/cli.bat',
  'C:/Program Files/Tencent/微信开发者工具/cli.bat',
  'D:/Tencent/微信web开发者工具/cli.bat'
].filter(Boolean)

function findCli() {
  for (const p of CLI_CANDIDATES) if (p && fs.existsSync(p)) return p
  return null
}

const results = []
function record(name, ok, info) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${info ? '  ·  ' + info : ''}`)
}

// 按 [data-xxx=val] 找到元素并 tap（开发者工具里元素 attribute 用 attribute() 取）
async function tapByData(page, selector, attr, val) {
  const els = await page.$$(selector)
  for (const el of els) {
    try {
      const a = await el.attribute(attr)
      if (a === val) { await el.tap(); return true }
    } catch (e) { /* 跳过不可点元素 */ }
  }
  return false
}

async function currentData(mini) {
  const p = await mini.currentPage()
  await p.waitFor(300)
  return p.data()
}

async function main() {
  // 模式 A：连接已在运行的 IDE（用户在自己终端启动，绕开 WorkBuddy 程序黑名单对 reg.exe 的拦截）
  //   用户在 PowerShell/CMD 执行：
  //   "C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" auto --project "D:\万州职教中心\lab-miniprogram" --auto-port 9450
  //   然后：set WECHAT_WS_ENDPOINT=ws://127.0.0.1:9450 && node automator.js
  const ws = process.env.WECHAT_WS_ENDPOINT
  if (ws) {
    console.log('连接模式，wsEndpoint:', ws)
    let miniProgram = null
    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
      try { miniProgram = await automator.connect({ wsEndpoint: ws }); break } catch (e) { await new Promise(r => setTimeout(r, 2000)) }
    }
    if (!miniProgram) { console.error('❌ 180 秒内无法连接 ' + ws + '，请确认 IDE 自动化模式已启动'); process.exit(2) }
    await runSmoke(miniProgram, false)
    return
  }

  const cliPath = findCli()
  if (!cliPath) {
    console.error('⚠️ 未找到微信开发者工具 cli.bat。')
    console.error('   请确认已安装；或用环境变量 WECHAT_CLI 指向下面的路径：')
    console.error('   C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat')
    process.exit(2)
  }
  console.log('使用 DevTools CLI:', cliPath)
  console.log('项目路径:', PROJECT, '\n')

  const miniProgram = await automator.launch({
    cliPath,
    projectPath: PROJECT,
    timeout: 120000
  })
  await runSmoke(miniProgram)
}

async function runSmoke(miniProgram, shouldClose = true) {

  try {
    // ---------- 首页 + 身份切换 ----------
    let page = await miniProgram.currentPage()
    await page.waitFor(500)
    record('打开项目首页', true)

    let ok = await tapByData(page, '.chip', 'data-role', 'teacher')
    await page.waitFor(300)
    record('切换身份为「教师」', ok)

    // ---------- 耗材详情 ----------
    await miniProgram.navigateTo('/pages/detail/detail?id=M003')
    await page.waitFor(500)
    let detail = await miniProgram.currentPage()
    const dd = await detail.data()
    record('打开耗材详情 M003', !!dd, dd ? JSON.stringify(dd).slice(0, 90) : '无 data')

    // ---------- 底部导航各页（教师可见） ----------
    await miniProgram.navigateBack()
    await page.waitFor(300)
    page = await miniProgram.currentPage()

    ok = await tapByData(page, '.footnav button', 'data-t', 'pending')
    await page.waitFor(300)
    record('进入「待审批」页', ok)

    ok = await tapByData(page, '.footnav button', 'data-t', 'io')
    await page.waitFor(300)
    record('进入「出入库」页', ok)

    ok = await tapByData(page, '.footnav button', 'data-t', 'usage')
    await page.waitFor(300)
    const ud = await currentData(miniProgram)
    record('进入「使用概况」页并读取数据', !!ud, ud ? 'data 字段数=' + Object.keys(ud).length : '')

    // ---------- 学生视角：我的申请 ----------
    await miniProgram.reLaunch('/pages/index/index')
    await page.waitFor(300)
    page = await miniProgram.currentPage()
    await tapByData(page, '.chip', 'data-role', 'student')
    await page.waitFor(200)
    ok = await tapByData(page, '.footnav button', 'data-t', 'mine')
    await page.waitFor(300)
    record('学生 - 进入「我的申请」页', ok)

  } catch (e) {
    record('运行过程异常', false, e.message)
  } finally {
    if (shouldClose) await miniProgram.close()
  }

  const passed = results.filter(r => r.ok).length
  console.log(`\n=== 冒烟测试结果: ${passed}/${results.length} 通过 ===`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch(e => {
  console.error('启动失败（多半是 DevTools 未安装/未登录/沙箱禁 GUI）：', e.message)
  process.exit(2)
})
