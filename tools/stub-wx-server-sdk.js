/**
 * wx-server-sdk 本地桩（仅供 tools 下的 node 脚本在本地跑云函数用）
 * 云函数在云端运行时用的是真实的 wx-server-sdk，不会加载本文件。
 * 只需要 index.js 里真实用到的两个入口：init / getWXContext。
 */
const cloud = {
  DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
  init() {},
  getWXContext() { return { OPENID: '' } }
}
module.exports = cloud
