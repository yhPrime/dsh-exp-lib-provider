/**
 * Provider 存储与语义：一个 JSON 文件 = 一个「经验库」空间。
 *
 * 与 Source 方案的 store 不同点：
 *  - 写入是 upsert：重复就地更新、近似替换写新条并标记旧条 superseded_by、其余追加；
 *  - 软删是墓碑：deleted_at + tombstoneDays 后物理清理；
 *  - 读时过滤 deleted_at 与 superseded_by，排序仍用 JitRL（Â × confidence）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

// 内核随包自带（与 dsh-exp-lib-source/kernel.js 同源），Provider 不依赖别的插件包。
import { abstractState, estimateAdvantages, stateSimilarity, tokenize } from './kernel.js'

const DEFAULT_TYPES = [
  { id: 'ty_ppt', name: 'PPT / 课件', description: '做幻灯片、课件类任务：研学课、常规课 PPT、插页、改版式。写入记做法/页数/模板/坑；召回看同类页面怎么做的。' },
  { id: 'ty_doc', name: '文档 / 教案', description: '写或改 Word 文档、教案、讲义、学习任务单。' },
  { id: 'ty_sheet', name: '表格 / 数据', description: 'Excel、CSV、表格整理与数据报表。' },
  { id: 'ty_code', name: '代码 / 插件', description: '写代码、改插件、修 bug、重构、跑测试。' },
  { id: 'ty_research', name: '调研 / 资料', description: '查资料、读论文、做调研与总结。' },
  { id: 'ty_image', name: '图片 / 视觉', description: '图片、图标、海报与视觉稿。' },
  { id: 'ty_web', name: '网页 / 抓取', description: '网页、站点、抓取与浏览器操作。' },
  { id: 'ty_writing', name: '文案 / 写作', description: '写文案、润色、改写稿件。' },
  { id: 'ty_ops', name: '环境 / 部署', description: '装环境、部署、改配置。' },
  { id: 'ty_other', name: '未分类', description: '暂时不确定归哪类；确认后改到具体类型。' },
]

export const FILE_NAME = 'exp-lib.json'
export const SPACE_NAME = '经验库'
export const SPACE_DESCRIPTION = '存放工作的经验：每条记录做法与结果，按 JitRL 优势召回，供接同类任务前参考。'
export const DEFAULT_MERGE_THRESHOLD = 0.9
export const DEFAULT_REPLACE_THRESHOLD = 0.9
export const DEFAULT_TOMBSTONE_DAYS = 30

/** 默认数据目录：配置优先，其次工作区下的 .exp/exp-lib-provider（可用 EXP_LIB_PROVIDER_DIR 覆盖）。 */
export function resolveDataDir(config = {}) {
  const configured = String(config.dataDir || process.env.EXP_LIB_PROVIDER_DIR || '').trim()
  if (configured !== '') return path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()))
  return path.join(process.cwd(), '.exp', 'exp-lib-provider')
}

/**
 * 从记忆插件的 Provider 服务设置里读 exp-lib 的数据目录。
 *
 * 这是「工具跟随配置」的关键：用户在记忆引擎里改了「经验库」的数据目录，
 * 工具不需要重新打包/改 profile，直接读同一份服务设置。
 * 候选位置：显式 providerStateFile → mnemonDataDir → DSH_MNEMON_DATA_DIR → 工作区/.mnemon → 家目录/.mnemon。
 */
export function dataDirFromProviderState(config = {}) {
  const files = []
  if (typeof config.providerStateFile === 'string' && config.providerStateFile.trim() !== '') {
    files.push(path.resolve(config.providerStateFile))
  }
  const roots = [
    config.mnemonDataDir,
    process.env.DSH_MNEMON_DATA_DIR,
    path.join(process.cwd(), '.mnemon'),
    path.join(os.homedir(), '.mnemon'),
  ]
  for (const root of roots) {
    if (typeof root === 'string' && root.trim() !== '') {
      files.push(path.join(root.trim(), 'state', 'memory-providers.json'))
    }
  }
  for (const file of files) {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'))
      const dir = state && state.services && state.services['exp-lib'] && state.services['exp-lib'].dataDir
      if (typeof dir === 'string' && dir.trim() !== '') {
        return path.resolve(dir.trim().replace(/^~(?=$|[\\/])/, os.homedir()))
      }
    } catch {
      // 该候选不存在或不可读，继续下一个。
    }
  }
  return ''
}

/** 工具用：优先跟随记忆插件里的 Provider 设置，读不到再退回插件自己的配置。 */
export function resolveToolDataDir(config = {}) {
  return dataDirFromProviderState(config) || resolveDataDir(config)
}

export function storeFile(dataDir) {
  return path.join(dataDir, FILE_NAME)
}

export function readStore(dataDir) {
  const file = storeFile(dataDir)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const types = Array.isArray(raw.types) && raw.types.length > 0 ? raw.types : DEFAULT_TYPES
    const experiences = Array.isArray(raw.experiences) ? raw.experiences.filter((item) => item && typeof item === 'object') : []
    return { version: Number(raw.version) || 1, types, experiences }
  } catch {
    return { version: 1, types: DEFAULT_TYPES.map((type) => ({ ...type })), experiences: [] }
  }
}

export function writeStore(dataDir, store) {
  const file = storeFile(dataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    types: Array.isArray(store.types) && store.types.length > 0 ? store.types : DEFAULT_TYPES,
    experiences: Array.isArray(store.experiences) ? store.experiences : [],
  }
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
  return payload
}

export function revisionOf(store) {
  return `exp-${createHash('sha1').update(JSON.stringify({ types: store.types, experiences: store.experiences })).digest('hex').slice(0, 16)}`
}

export function findType(types, value) {
  const key = String(value || '').trim().toLowerCase()
  if (key === '') return null
  return (types || []).find((type) => String(type.id).toLowerCase() === key || String(type.name).toLowerCase() === key) || null
}

function actionKeyOf(action) {
  return String(action || '').trim().toLowerCase()
}

function newId() {
  return `ex_${createHash('sha1').update(`${Date.now()}|${Math.random()}`).digest('hex').slice(0, 12)}`
}

/** 回报：显式 1..-1，或按结果推断。 */
export function scoreOf(outcome, explicit) {
  if (Number.isFinite(Number(explicit))) return Math.max(-1, Math.min(1, Number(explicit)))
  switch (String(outcome || 'unknown')) {
    case 'accepted':
    case 'success':
      return 1
    case 'partial':
      return 0.3
    case 'failed':
    case 'corrected':
      return -0.6
    case 'aborted':
      return -0.3
    default:
      return 0
  }
}

/**
 * 写入一条经验（upsert）。
 * @returns {{experience: object, action: 'updated'|'superseded'|'added', supersededId?: string}}
 */
export function upsertExperience(store, input, options = {}) {
  const intent = String(input.intent || '').trim()
  const action = String(input.action || '').trim()
  if (intent === '' || action === '') throw new Error('intent 与 action 必填')
  const mergeThreshold = Number.isFinite(Number(options.mergeThreshold)) ? Number(options.mergeThreshold) : DEFAULT_MERGE_THRESHOLD
  const replaceThreshold = Number.isFinite(Number(options.replaceThreshold)) ? Number(options.replaceThreshold) : DEFAULT_REPLACE_THRESHOLD
  const outcome = String(input.outcome || 'unknown')
  const requestedType = findType(store.types, input.type)
  const type = requestedType || findType(store.types, '未分类')
  const state = abstractState(intent, action)
  const now = new Date().toISOString()
  const reward = scoreOf(outcome)
  const active = store.experiences.filter((item) => !item.deleted_at)

  // 1) 重复：同做法 + 状态相似度达阈值 → 就地更新
  const duplicate = active.find((item) => actionKeyOf(item.action) === actionKeyOf(action)
    && stateSimilarity(state, item.state || {}) >= mergeThreshold)
  if (duplicate !== undefined) {
    duplicate.hits = (Number(duplicate.hits) || 1) + 1
    duplicate.lastSeenAt = now
    duplicate.outcome = outcome
    duplicate.G = reward
    duplicate.step_rewards = [reward]
    if (input.note !== undefined && String(input.note).trim() !== '') duplicate.note = String(input.note).trim()
    if (requestedType !== null) {
      duplicate.typeId = requestedType.id
      duplicate.typeName = requestedType.name
    }
    return { experience: duplicate, action: 'updated' }
  }

  // 2) 近似替换：同类型、做法不同、意图相似度达阈值 → 新条 + 旧条 superseded_by
  const replaceTarget = type === null ? undefined : active.find((item) => item.typeId === type.id
    && actionKeyOf(item.action) !== actionKeyOf(action)
    && stateSimilarity(abstractState(intent), abstractState(item.intent)) >= replaceThreshold)
  const experience = {
    id: newId(),
    ts: now,
    lastSeenAt: now,
    hits: 1,
    intent,
    action,
    state,
    step_rewards: [reward],
    G: reward,
    outcome,
    note: input.note === undefined ? '' : String(input.note).trim(),
    origin: input.origin === 'auto' ? 'auto' : input.origin === 'external' ? 'external' : 'manual',
    typeId: type === null ? 'ty_other' : type.id,
    typeName: type === null ? '未分类' : type.name,
    deleted_at: null,
    superseded_by: null,
  }
  if (replaceTarget !== undefined) {
    experience.supersedes = replaceTarget.id
    replaceTarget.superseded_by = experience.id
  }
  store.experiences.push(experience)
  return { experience, action: replaceTarget === undefined ? 'added' : 'superseded', supersededId: replaceTarget === undefined ? undefined : replaceTarget.id }
}

/** 软删一条（墓碑）。 */
export function forgetExperience(store, id) {
  const experience = store.experiences.find((item) => item.id === id)
  if (experience === undefined) return false
  if (experience.deleted_at) return true
  experience.deleted_at = new Date().toISOString()
  return true
}

/** 物理清理超过 TTL 的墓碑，返回清理条数。 */
export function purgeTombstones(store, tombstoneDays = DEFAULT_TOMBSTONE_DAYS, now = Date.now()) {
  const ttl = Math.max(0, Number(tombstoneDays) || 0) * 24 * 60 * 60 * 1000
  const before = store.experiences.length
  store.experiences = store.experiences.filter((item) => {
    if (!item.deleted_at) return true
    const deletedAt = Date.parse(item.deleted_at)
    return Number.isFinite(deletedAt) ? now - deletedAt < ttl : true
  })
  return before - store.experiences.length
}

/** 可见经验（未删、未被取代）。 */
export function visibleExperiences(store, options = {}) {
  return store.experiences.filter((item) => {
    if (item.deleted_at && !options.includeDeleted) return false
    if (item.superseded_by && !options.includeSuperseded) return false
    return true
  })
}

/** 按意图做 JitRL 排序。 */
export function rankExperiences(store, intent, limit = 8, options = {}) {
  const experiences = visibleExperiences(store, options)
  if (experiences.length === 0) return { intent, V: 0, neighbor_count: 0, candidates: [] }
  const k = Math.max(1, Math.trunc(Number(limit) || 8))
  const result = estimateAdvantages(experiences, intent, { k })
  const byId = new Map(experiences.map((item) => [item.id, item]))
  const candidates = result.candidates.map((candidate) => {
    const row = byId.get((candidate.evidence[0] || {}).id) || null
    return {
      action: candidate.action,
      advantage: candidate.advantage,
      advantage_norm: candidate.advantage_norm,
      confidence: candidate.confidence,
      rank_score: candidate.rank_score,
      support: candidate.support,
      mean_similarity: candidate.mean_similarity,
      typeName: row ? row.typeName : '未分类',
      evidence: candidate.evidence.map((evidence) => {
        const experience = byId.get(evidence.id)
        return {
          id: evidence.id,
          intent: experience ? experience.intent : '',
          action: experience ? experience.action : evidence.action,
          outcome: evidence.outcome,
          G: evidence.G,
          note: evidence.note,
          similarity: evidence.similarity,
          typeName: experience ? experience.typeName : '',
        }
      }),
    }
  })
  return { intent, V: result.V, neighbor_count: result.neighbor_count, candidates }
}

/** Insight 视图：给 Provider 的 list / search / graph 用。 */
export function toInsight(experience, score) {
  const tokens = tokenize(`${experience.intent} ${experience.action}`)
  return {
    id: experience.id,
    content: `[${experience.typeName}] ${experience.intent} → ${experience.action}（${experience.outcome}${experience.note ? `；${experience.note}` : ''}）`,
    category: 'insight',
    importance: 3,
    tags: [experience.typeName, experience.origin].filter(Boolean),
    entities: tokens.slice(0, 6),
    source: experience.origin === 'manual' ? 'user' : experience.origin === 'auto' ? 'agent' : 'external',
    score: Number.isFinite(score) ? score : undefined,
  }
}

export function listInsights(store, options = {}) {
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 100))
  const query = String(options.query || '').trim().toLowerCase()
  const rows = visibleExperiences(store, options)
    .filter((item) => query === '' || `${item.intent} ${item.action} ${item.note} ${item.typeName}`.toLowerCase().includes(query))
    .slice(-limit)
    .reverse()
  return rows.map((item) => toInsight(item))
}

export function graphSnapshot(store) {
  const rows = visibleExperiences(store)
  const nodes = rows.map((item) => ({ ...toInsight(item), color: '#818cf8', kind: 'memory' }))
  const edges = []
  for (const item of rows) {
    if (item.supersedes) {
      edges.push({ sourceId: item.supersedes, targetId: item.id, label: '取代', color: '#fb8f44', type: 'semantic' })
    }
  }
  return { nodes, edges, generatedAt: new Date().toISOString() }
}

export function entityIndex(store) {
  const memories = visibleExperiences(store).map((item) => toInsight(item))
  return { memories, complete: true }
}

export function statsOf(store, dataDir) {
  const rows = store.experiences
  const active = rows.filter((item) => !item.deleted_at && !item.superseded_by)
  const byType = {}
  for (const item of active) byType[item.typeName || '未分类'] = (byType[item.typeName || '未分类'] || 0) + 1
  const counts = new Map()
  for (const item of active) for (const token of new Set(tokenize(item.intent))) counts.set(token, (counts.get(token) || 0) + 1)
  const topEntities = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([entity, count]) => ({ entity, count }))
  let size = 0
  try {
    size = fs.statSync(storeFile(dataDir)).size
  } catch {
    size = 0
  }
  return {
    totalInsights: active.length,
    deletedInsights: rows.filter((item) => item.deleted_at).length,
    edgeCount: rows.filter((item) => item.supersedes).length,
    oplogCount: 0,
    dbSizeBytes: size,
    byCategory: byType,
    topEntities,
  }
}

/** 供模型看的简短说明（工具描述/管理页用）。 */
export function describeSpace() {
  return `${SPACE_NAME}：${SPACE_DESCRIPTION}`
}
