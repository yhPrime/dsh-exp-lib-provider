/**
 * 经验库 Provider 定义：被 memory-spaces Source 作为子 Fiber 挂载。
 * 存储语义全部在 store.js；这里只做契约适配。
 *
 * 契约（memory-spaces 的 MemoryProviderAdapter）：除 `scoreSemantics` / `invalidateStatus` /
 * `dispose` 外，数据面方法一律返回 Promise。宿主有两处直接按 Promise 用返回值，同步值会崩：
 *   - `untilAborted(provider.discover(...))` → `.then is not a function`
 *   - `this.providerFor(body).status(body).catch(...)` → `.catch is not a function`
 * 所以这里所有方法都写成 async，别再图省事返回裸对象。
 */

import {
  SPACE_DESCRIPTION,
  SPACE_NAME,
  entityIndex,
  forgetExperience,
  graphSnapshot,
  listInsights,
  purgeTombstones,
  rankExperiences,
  readStore,
  resolveToolDataDir,
  statsOf,
  toInsight,
  writeStore,
} from './store.js'

export const PROVIDER_ID = 'exp-lib'
export const PACKAGE_NAME = 'dsh-exp-lib-provider'
export const API_VERSION = 'dsh-mnemon.memory-space-provider/v1'

export const DATA_DIR_FIELD = {
  key: 'dataDir',
  label: '数据目录',
  scope: 'service',
  role: 'global-location',
  input: 'path',
  required: false,
  placeholder: '默认 $DSH_HOME/exp-lib/provider-data，例如 ~/.dsh/exp-lib/provider-data',
  help: '留空即用默认目录（宿主未注入 DSH_HOME 时用 ~/.dsh）；也可以填 ~ 开头的路径。',
}

/**
 * @param {{apiVersion?: string, defineMemorySpaceProviderDefinition: Function}} sdk
 * @param {{dataDir?: string, tombstoneDays?: number}} config
 */
export function buildProvider(sdk, config = {}) {
  const apiVersion = sdk.apiVersion || API_VERSION
  const configured = Object.freeze({ ...config })

  return sdk.defineMemorySpaceProviderDefinition({
    manifest: {
      apiVersion,
      kind: 'provider',
      typeId: PROVIDER_ID,
      packageName: PACKAGE_NAME,
      version: '0.2.3',
      label: SPACE_NAME,
      summary: 'JitRL 经验记忆：记录做法与结果，按优势召回。',
      origin: 'third-party',
      locality: 'local',
      workspaceBinding: 'optional-override',
      capabilities: {
        search: true,
        browse: true,
        graph: true,
        entities: true,
        related: false,
        remember: false,
        link: false,
        forget: true,
        writeMode: 'exact',
        deletionMode: 'soft',
      },
      fields: [DATA_DIR_FIELD],
      secrets: [],
      scoreSemantics: 'provider-native',
    },
    create(context = {}) {
      const merged = { ...configured, ...(context.configuration || {}) }
      // 每次调用都重新解析：跟随「记忆引擎 → 经验库」里保存的数据目录（memory-providers.json），
      // 不把路径钉死在 create 时的快照上——否则用户在面板改目录后这里会一直读旧路径。
      const dataDirOf = () => resolveToolDataDir(merged)
      const initial = readStore(dataDirOf())
      if (purgeTombstones(initial, merged.tombstoneDays, Date.now()) > 0) writeStore(dataDirOf(), initial)

      return {
        // 契约要求：工厂返回的 adapter.id 必须等于 manifest.typeId（否则报 "factory returned undefined"）。
        id: PROVIDER_ID,

        async discover() {
          const store = readStore(dataDirOf())
          if (store.experiences.length === 0) return []
          return [{
            externalId: 'exp-lib',
            name: SPACE_NAME,
            description: SPACE_DESCRIPTION,
            connection: { id: PROVIDER_ID, label: SPACE_NAME, fields: { dataDir: dataDirOf() } },
          }]
        },

        async status() {
          const dir = dataDirOf()
          const store = readStore(dir)
          return { healthy: true, stats: statsOf(store, dir) }
        },

        async search(body, request = {}) {
          const store = readStore(dataDirOf())
          const query = String(request.query || '').trim()
          const limit = Math.max(1, Math.trunc(Number(request.limit) || 8))
          if (query === '') return { results: listInsights(store, { limit }), hint: '空查询：列出最近的可见经验' }
          const ranked = rankExperiences(store, query, limit)
          const results = ranked.candidates.map((candidate) => {
            const evidence = candidate.evidence[0]
            const experience = store.experiences.find((item) => item.id === (evidence && evidence.id))
            return experience ? toInsight(experience, candidate.rank_score) : null
          }).filter(Boolean)
          return { results, hint: `JitRL 优势排序（Â × 置信度）；邻居 ${ranked.neighbor_count} 条` }
        },

        async list(body, request = {}) {
          const store = readStore(dataDirOf())
          return listInsights(store, { query: request.query, limit: request.limit })
        },

        async graph() {
          return graphSnapshot(readStore(dataDirOf()))
        },

        async entityIndex() {
          return entityIndex(readStore(dataDirOf()))
        },

        async remember() {
          throw new Error('经验库只接受 exp_record 写入：请调用 exp_record(intent, action, outcome, type?, note?) 记录做法与结果。')
        },

        async forget(body, id) {
          const dir = dataDirOf()
          const store = readStore(dir)
          if (!forgetExperience(store, id)) throw new Error(`没有这条经验：${String(id)}`)
          writeStore(dir, store)
          return { status: 'deleted', id }
        },

        dispose() {},
      }
    },
  })
}
