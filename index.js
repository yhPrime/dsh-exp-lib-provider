/**
 * dsh-exp-lib-provider — 经验库作为记忆空间 Provider（热插拔，不改记忆插件代码）。
 *
 * 挂载方式：memory-spaces Source 的 `config.providers` 里加一条
 * `{ use: "dsh-exp-lib-provider", instanceId: "exp-lib", config: { dataDir: "<工作台内目录>" } }`。
 *
 * 本模块同时注册两个工具 exp_record / exp_recall，与 Provider 共用同一份数据与语义。
 */

import { MEMORY_SPACE_PROVIDER_API_VERSION, defineMemorySpaceProvider, defineMemorySpaceProviderDefinition } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { PROVIDER_ID, buildProvider } from './provider.js'
import { buildTools } from './tools.js'

export { PROVIDER_ID, buildProvider } from './provider.js'
export { buildTools } from './tools.js'
export { SPACE_DESCRIPTION, SPACE_NAME } from './store.js'

export const id = PROVIDER_ID

const SDK = {
  apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION,
  defineMemorySpaceProviderDefinition,
}

export default defineMemorySpaceProvider({
  id: PROVIDER_ID,
  apply(ctx, host, config = {}) {
    host.install(ctx, buildProvider(SDK, config))

    // 工具注册失败不影响 Provider 本身（例如在纯存储/无工具上下文中被装载）。
    try {
      ctx.inject(['tools'], (toolCtx) => {
        for (const tool of buildTools(defineTool, config)) toolCtx.tools.register(tool)
      })
    } catch {
      // 工具服务不可用时忽略：面板与管理仍可用。
    }
  },
})
