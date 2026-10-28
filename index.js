/**
 * dsh-exp-lib-provider — 经验库作为记忆空间 Provider（热插拔，不改记忆插件代码）。
 *
 * 这个入口是 **Provider 子模块**：由 memory-spaces Source 的 `config.providers` 挂载
 * （`{ use: "dsh-exp-lib-provider", instanceId: "exp-lib", config: { dataDir: "..." } }`）。
 *
 * 普通 DSH 插件入口（工具面、可在插件管理里启停）在 `plugin.js`，由 `cordis.patch.yml` 注册。
 */

import { MEMORY_SPACE_PROVIDER_API_VERSION, defineMemorySpaceProvider, defineMemorySpaceProviderDefinition } from 'dsh-mnemon-source-memory-spaces/provider-sdk'

import { PROVIDER_ID, buildProvider } from './provider.js'

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
  },
})
