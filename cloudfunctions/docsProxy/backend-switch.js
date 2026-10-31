// backend-switch.js —— 数据后端选择与冗余回退（纯逻辑，无任何外部依赖，可单测）
//
// 职责：解析云函数环境变量 → 选择「主后端」→ 构建「冗余回退链」。
// 真实的后端模块加载（require tencentdocs / clouddb）由 loadBackend 完成，
// 缺失（如 clouddb.js 尚未创建）或加载失败时返回 null，保证上层 index.js 不崩溃。
//
// 三个后端：
//   tencent  —— 腾讯文档（云文档），tencentdocs.js（当前生产默认）
//   cloud    —— 微信云数据库（云函数内 clouddb.js），免 token 永久运维（迁移方案 C）
//   mock     —— 云函数内内存演示数据（mockHandler）
//
// 三个开关（云函数环境变量，免改代码即可热切换）：
//   USE_MOCK     'true' → 强制 mock；'false' → 强制真实后端且关闭自动回退；未设置 → 自动模式
//   DATA_BACKEND 真实后端选择：tencent(默认) | cloud。仅走真实路径时生效
//   FALLBACK     'off' → 关闭自动回退（调试想看真实报错）；其他/未设置 → 自动回退开启
//
// 自动回退链（核心：避免单后端崩溃拖垮整次请求）：
//   tencent → mock        cloud → tencent → mock        mock → (无)
// 任一后端抛异常（如腾讯文档 token 过期、云库集合未建）都会被下一个后端接管；
// 全部失败时由 index.js 返回结构化 500，进程不崩。

function resolveEnv() {
  const RAW_USE_MOCK = process.env.USE_MOCK
  const RAW_DATA_BACKEND = ('' + (process.env.DATA_BACKEND || 'tencent')).trim().toLowerCase()
  const RAW_FALLBACK = ('' + (process.env.FALLBACK || 'on')).trim().toLowerCase()
  const HAS_CREDENTIAL = !!(process.env.TENCENT_DOCS_FILE_ID &&
    process.env.TENCENT_DOCS_CLIENT_ID &&
    process.env.TENCENT_DOCS_ACCESS_TOKEN &&
    process.env.TENCENT_DOCS_OPEN_ID)
  // 可信机器通道（WorkBuddy 自然语言操作）：外部 HTTP 调用携带 robotKey 且命中本变量时，
  // 以 ROBOT_ACTOR_ID 身份执行。未配置则通道关闭（fail-closed，外部调用只能走公开接口）。
  const ROBOT_KEY = ('' + (process.env.ROBOT_KEY || '')).trim()
  const ROBOT_ACTOR_ID = ('' + (process.env.ROBOT_ACTOR_ID || 'T001')).trim()
  const FORCE_MOCK = (RAW_USE_MOCK !== undefined && String(RAW_USE_MOCK).trim() !== '' &&
    String(RAW_USE_MOCK).trim().toLowerCase() === 'true')
  const FORCE_REAL = (RAW_USE_MOCK !== undefined && String(RAW_USE_MOCK).trim() !== '' &&
    String(RAW_USE_MOCK).trim().toLowerCase() === 'false')
  const AUTO_FALLBACK = RAW_FALLBACK !== 'off'
  return { RAW_USE_MOCK, RAW_DATA_BACKEND, RAW_FALLBACK, HAS_CREDENTIAL, FORCE_MOCK, FORCE_REAL, AUTO_FALLBACK, ROBOT_KEY, ROBOT_ACTOR_ID }
}

// 解析主后端：自动模式下若选 tencent 但无凭证，自动降级为 mock（避免无谓打失效 token）
function resolvePrimary(env) {
  if (env.FORCE_MOCK) return 'mock'
  let p = env.RAW_DATA_BACKEND
  if (p !== 'tencent' && p !== 'cloud' && p !== 'mock') p = 'tencent'
  if (p === 'tencent' && !env.HAS_CREDENTIAL) p = 'mock'
  return p
}

// 加载单个后端；mock 不需要模块。缺失/失败返回 null，绝不抛错。
function loadBackend(kind, requireFn) {
  try {
    if (kind === 'mock') return { kind: 'mock', td: null, src: 'mock' }
    if (kind === 'tencent') {
      const mod = requireFn('./tencentdocs.js')
      return { kind: 'tencent', td: mod, src: 'cloud' }
    }
    if (kind === 'cloud') {
      const mod = requireFn('./clouddb.js')
      return { kind: 'cloud', td: mod, src: 'cloud' }
    }
  } catch (e) {
    // 吞掉加载错误：clouddb.js 尚未创建、或 tencentdocs 缺依赖时，返回 null 让上层跳过
  }
  return null
}

// 构建有序回退链
function buildChain(env, requireFn) {
  const PRIMARY = resolvePrimary(env)
  const chain = []
  const seen = {}
  const push = (k) => {
    if (seen[k]) return
    const b = loadBackend(k, requireFn)
    if (b) { chain.push(b); seen[k] = true }
  }
  push(PRIMARY)
  // 仅自动模式或 force-real 下允许回退；force-mock 不再回退
  const allowFb = env.AUTO_FALLBACK && !env.FORCE_MOCK
  if (allowFb) {
    if (PRIMARY === 'cloud') { push('tencent'); push('mock') }
    else if (PRIMARY === 'tencent') { push('mock') }
  }
  // 兜底：极端情况下链为空，至少挂一个 mock，保证进程不崩
  if (!chain.length) {
    const m = loadBackend('mock', requireFn)
    if (m) chain.push(m)
  }
  return { PRIMARY, chain, kinds: chain.map(b => b.kind) }
}

module.exports = { resolveEnv, resolvePrimary, loadBackend, buildChain }
