/**
 * 经验库 Provider 定义：被 memory-spaces Source 作为子 Fiber 挂载。
 * 存储语义全部在 store.js；这里只做契约适配。
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
  resolveDataDir,
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
  required: true,
  placeholder: '例如 C:\\Users\\<你>\\WorkDeepSeek\\插件\\经验库\\provider-data',
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
      version: '0.1.0',
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
      const dataDir = resolveDataDir(merged)
      const initial = readStore(dataDir)
      if (purgeTombstones(initial, merged.tombstoneDays, Date.now()) > 0) writeStore(dataDir, initial)

      return {
        // 契约要求：工厂返回的 adapter.id 必须等于 manifest.typeId（否则报 "factory returned undefined"）。
        id: PROVIDER_ID,

        discover() {
          const store = readStore(dataDir)
          if (store.experiences.length === 0) return []
          return [{
            externalId: 'exp-lib',
            name: SPACE_NAME,
            description: SPACE_DESCRIPTION,
            connection: { id: PROVIDER_ID, label: SPACE_NAME, fields: merged.dataDir ? { dataDir: merged.dataDir } : {} },
          }]
        },

        status() {
          const store = readStore(dataDir)
          return { healthy: true, stats: statsOf(store, dataDir) }
        },

        search(body, request = {}) {
          const store = readStore(dataDir)
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

        list(body, request = {}) {
          const store = readStore(dataDir)
          return listInsights(store, { query: request.query, limit: request.limit })
        },

        graph() {
          return graphSnapshot(readStore(dataDir))
        },

        entityIndex() {
          return entityIndex(readStore(dataDir))
        },

        remember() {
          throw new Error('经验库只接受 exp_record 写入：请调用 exp_record(intent, action, outcome, type?, note?) 记录做法与结果。')
        },

        forget(body, id) {
          const store = readStore(dataDir)
          if (!forgetExperience(store, id)) throw new Error(`没有这条经验：${String(id)}`)
          writeStore(dataDir, store)
          return { status: 'deleted', id }
        },

        dispose() {},
      }
    },
  })
}
