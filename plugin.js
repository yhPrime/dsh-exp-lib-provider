/**
 * DSH 插件入口（可安装/开启/禁用）：只注册两个工具。
 *
 * Provider 本身由 memory-spaces 作为子 Fiber 挂载（在「记忆引擎 → Provider」里开关）；
 * 这个入口让本包同时是一个普通的 DSH 插件，出现在插件管理里，可整体启停工具面。
 */

import { buildTools } from './tools.js'

export const name = 'dsh-exp-lib-provider'

// @deepseek-ai/dsh-tools 由宿主提供；拿不到就退回纯对象定义。
let defineTool = (definition) => definition
try {
  const toolsSdk = await import('@deepseek-ai/dsh-tools')
  if (toolsSdk && typeof toolsSdk.defineTool === 'function') defineTool = toolsSdk.defineTool
} catch {
  // 宿主未暴露该入口时保持纯对象定义。
}

export function apply(ctx, config = {}) {
  ctx.inject(['tools'], (toolCtx) => {
    for (const tool of buildTools(defineTool, config)) toolCtx.tools.register(tool)
  })
}
