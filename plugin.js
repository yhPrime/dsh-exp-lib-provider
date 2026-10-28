/**
 * DSH 插件入口（可安装/开启/禁用）：只注册两个工具。
 *
 * Provider 本身由 memory-spaces 作为子 Fiber 挂载（在「记忆引擎 → Provider」里开关）；
 * 这个入口让本包同时是一个普通的 DSH 插件，出现在插件管理里，可整体启停工具面。
 */

import fs from 'node:fs'
import path from 'node:path'

import { buildTools } from './tools.js'

export const name = 'dsh-exp-lib-provider'
// Cordis 标准：等 tools 服务就绪后再 apply（和宿主其它注册工具的插件一致）。
export const inject = ['tools']

/** 启动审计：apply 是否真的跑过、工具注册到哪一步。写小文件，失败不影响加载。 */
function audit(config, line) {
  try {
    const dir = String(config.dataDir || '').trim() || path.join(process.cwd(), '.exp', 'exp-lib-provider')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'plugin-apply.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // 审计失败不影响插件加载。
  }
}

export async function apply(ctx, config = {}) {
  let defineTool = (definition) => definition
  try {
    const toolsSdk = await import('@deepseek-ai/dsh-tools')
    if (toolsSdk && typeof toolsSdk.defineTool === 'function') defineTool = toolsSdk.defineTool
  } catch {
    // 宿主未暴露该入口时保持纯对象定义。
  }

  const register = (target) => {
    for (const tool of buildTools(defineTool, config)) target.tools.register(tool)
  }

  try {
    if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
      register(ctx)
      audit(config, 'apply: registered via ctx.tools')
      return
    }
    if (ctx && typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (toolCtx) => {
        register(toolCtx)
        audit(config, 'apply: registered via ctx.inject')
      })
      audit(config, 'apply: waiting for tools service')
      return
    }
    throw new Error('tools service unavailable')
  } catch (error) {
    audit(config, `apply failed: ${error && error.message ? error.message : String(error)}`)
    throw error
  }
}
