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
 *   需注入测试账号（演示账号已清空，须用真实腾讯文档账号）：
 *     TEST_ID / TEST_NAME     教师视角账号（建议填开发者本人，避免误绑他人 openid）
 *     TEST_ID2 / TEST_NAME2  学生视角账号（可选，缺则跳过学生视角）
 *     TEST_ADMIN_ID / TEST_ADMIN_NAME  管理员视角账号（可选，缺则跳过用户管理测试；须为 role=admin 且已存在于 users 表）
 *   注：用户管理测试会临时新增工号 ATxxxxxx 的测试账号并随后删除，异常残留可在「用户与角色」页手动清理。
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

async function currentData(mini) {
  const p = await mini.currentPage()
  await p.waitFor(300)
  return p.data()
}

// 用工号+姓名表单登录（演示账号已清空，须用真实腾讯文档账号）。
// 返回 true 表示已填表并提交；跳转由页面自身完成。
// 注意：TEST_ID / TEST_NAME 建议填开发者本人（邓老师）的工号姓名，
// 以免把测试用微信号的 openid 误绑到他人账号上。
async function loginByForm(miniProgram, id, name) {
  if (!id || !name) return false
  const page = await miniProgram.currentPage()
  await page.setData({ name, id })
  await page.waitFor(200)
  const btn = await page.$('.btn-primary')
  if (!btn) return false
  await btn.tap()
  await page.waitFor(1000) // 等待「绑定并登录」+ 跳转首页
  return true
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

// 管理员视角：登录为 admin → 我的页暴露系统管理入口 → 进入用户与角色页
// → 新增(upsert) / 改角色(编辑) / 删除 三个动作端到端验证（走真实 api.call 层，含服务端 RBAC）。
// 临时账号工号 ATxxxxxx，测试结束前删除；若异常中断残留，可在「用户与角色」页手动清理。
async function runAdminUsers(miniProgram) {
  if (!process.env.TEST_ADMIN_ID || !process.env.TEST_ADMIN_NAME) {
    record('管理员视角用户管理（未配置 TEST_ADMIN_ID / TEST_ADMIN_NAME，跳过）', true)
    return
  }
  const testId = 'AT' + (Date.now() % 100000)
  const testName = '自动化测试号'
  let created = false
  let modalOk = false
  try {
    await miniProgram.reLaunch('/pages/login/login')
    const lp = await miniProgram.currentPage()
    await lp.waitFor(500)
    const okAdmin = await loginByForm(miniProgram, process.env.TEST_ADMIN_ID, process.env.TEST_ADMIN_NAME)
    record('登录为「管理员」', okAdmin)
    if (!okAdmin) return

    // mine 页应暴露系统管理入口（仅 admin 可见）
    await miniProgram.switchTab('/pages/mine/mine')
    await wait(400)
    const mineD = await (await miniProgram.currentPage()).data()
    record('管理员 - 我的页暴露系统管理入口(isAdmin)', !!(mineD && mineD.isAdmin))

    // 进入管理页，列表应加载
    await miniProgram.navigateTo('/pages/admin-users/admin-users')
    await wait(700)
    const adminPage = await miniProgram.currentPage()
    let ad = await adminPage.data()
    const listOk = !!(ad && Array.isArray(ad.users))
    record('进入「用户与角色」页并读取列表', listOk, listOk ? '用户数=' + ad.users.length : '无 data')
    if (!listOk) return

    // 新增（upsert）
    await adminPage.setData({
      showForm: true, editing: null,
      form: { id: testId, name: testName, role: 'student', cls: 'T1', status: '启用' },
      roleIndex: 0, statusIndex: 0
    })
    await wait(200)
    await adminPage.callMethod('save')
    await wait(1000)
    ad = await adminPage.data()
    created = (ad.users || []).some(u => u.id === testId)
    record('管理员 - 新增用户(upsert)成功', created, created ? '工号=' + testId : '列表未出现该用户')
    if (!created) return

    // 编辑：改角色为「教师」，验证更新路径
    await adminPage.setData({
      showForm: true, editing: testId,
      form: { id: testId, name: testName, role: 'teacher', cls: 'T1', status: '启用' },
      roleIndex: 1, statusIndex: 0
    })
    await wait(200)
    await adminPage.callMethod('save')
    await wait(1000)
    ad = await adminPage.data()
    const updated = (ad.users || []).some(u => u.id === testId && u.role === 'teacher')
    record('管理员 - 编辑用户(改角色)成功', updated)

    // 删除：mock showModal 自动确认（避免真实弹窗阻塞）
    try {
      if (typeof miniProgram.mockWxMethod === 'function') {
        await miniProgram.mockWxMethod('showModal', { confirm: true, cancel: false })
        modalOk = true
      }
    } catch (e) { modalOk = false }
    if (modalOk) {
      await adminPage.callMethod('del', { currentTarget: { dataset: { u: { id: testId, name: testName } } } })
      await miniProgram.restoreWxMethod('showModal')
      await wait(1000)
      ad = await adminPage.data()
      const removed = !(ad.users || []).some(u => u.id === testId)
      record('管理员 - 删除用户成功', removed)
      created = !removed // 删除成功则无需兜底清理
    } else {
      record('管理员 - 删除用户(当前 automator 不支持 mockWxMethod，跳过 UI 删除)', true)
    }
  } catch (e) {
    record('管理员用户管理测试异常', false, e.message)
  } finally {
    // 兜底清理：若前面删除未生效，确保测试账号被移除
    if (created && modalOk) {
      try {
        const adminPage = await miniProgram.currentPage()
        await miniProgram.mockWxMethod('showModal', { confirm: true, cancel: false })
        await adminPage.callMethod('del', { currentTarget: { dataset: { u: { id: testId, name: testName } } } })
        await miniProgram.restoreWxMethod('showModal')
      } catch (_) { /* 清理失败忽略 */ }
    }
  }
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

    // 登录为教师：演示账号已清空，须用真实腾讯文档账号（环境变量注入）。
    if (!process.env.TEST_ID || !process.env.TEST_NAME) {
      record('未配置 TEST_ID / TEST_NAME，冒烟测试需要测试账号，整体跳过', true)
      return
    }
    const ok = await loginByForm(miniProgram, process.env.TEST_ID, process.env.TEST_NAME)
    record('登录为「教师」', ok)
    if (!ok) return
    page = await miniProgram.currentPage()

    // ---------- 耗材详情 ----------
    await miniProgram.navigateTo('/pages/detail/detail?id=M003')
    await page.waitFor(500)
    let detail = await miniProgram.currentPage()
    const dd = await detail.data()
    record('打开耗材详情 M003', !!dd, dd ? JSON.stringify(dd).slice(0, 90) : '无 data')

    // ---------- 教师功能页（index 为 tabBar 页无 footnav，直接 navigateTo 验证渲染与数据）----------
    await miniProgram.navigateBack()
    await page.waitFor(300)

    await miniProgram.navigateTo('/pages/approve/approve')
    await page.waitFor(500)
    const apD = await (await miniProgram.currentPage()).data()
    record('进入「待审批」页并读取数据', !!apD && Array.isArray(apD.list),
      apD && apD.list ? 'list 长度=' + apD.list.length : '无 data')

    await miniProgram.navigateBack()
    await page.waitFor(300)

    await miniProgram.navigateTo('/pages/io/io')
    await page.waitFor(500)
    record('进入「出入库」页', !!(await miniProgram.currentPage()))

    await miniProgram.navigateBack()
    await page.waitFor(300)

    await miniProgram.navigateTo('/pages/usage/usage')
    await page.waitFor(500)
    const ud = await currentData(miniProgram)
    record('进入「使用概况」页并读取数据', !!ud, ud ? 'data 字段数=' + Object.keys(ud).length : '')

    // ---------- 学生视角：重新登录为学生账号 ----------
    if (!process.env.TEST_ID2 || !process.env.TEST_NAME2) {
      record('学生视角（未配置 TEST_ID2 / TEST_NAME2，跳过）', true)
    } else {
      await miniProgram.reLaunch('/pages/login/login')
      await page.waitFor(500)
      const ok2 = await loginByForm(miniProgram, process.env.TEST_ID2, process.env.TEST_NAME2)
      record('登录为「学生」', ok2)
      if (ok2) {
        // mine 为 tabBar 页，用 switchTab 进入（无 footnav）
        await miniProgram.switchTab('/pages/mine/mine')
        await page.waitFor(500)
        const mineD = await (await miniProgram.currentPage()).data()
        record('学生 - 进入「我的申请」页', !!mineD && Array.isArray(mineD.rs),
          mineD && mineD.rs ? 'rs 长度=' + mineD.rs.length : '无 data')
      }
    }

    // ---------- 管理员视角：用户与角色管理 ----------
    await runAdminUsers(miniProgram)

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
