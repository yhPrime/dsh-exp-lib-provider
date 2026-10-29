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

/** 只有系统兜底类型；业务类型不再预设，由模型在记录时按需创建（带防膨胀限制）。 */
export const SYSTEM_TYPE = Object.freeze({
  id: 'ty_other',
  name: '未分类',
  description: '兜底：没给类型或新类型被拒绝/超限时归到这里。',
  system: true,
})

/** 类型防膨胀：上限、每天新增上限、名称近似判定阈值。 */
export const DEFAULT_MAX_TYPES = 24
export const DEFAULT_NEW_TYPES_PER_DAY = 6
export const DEFAULT_TYPE_SIMILARITY = 0.8

/** 这些名字太泛，直接归「未分类」，不新建类型。 */
const GENERIC_TYPE_NAMES = new Set(['其他', '其它', '杂项', '别的', '临时', '随便', '未分类', 'other', 'misc'])

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
  // 兜底：从配置的数据目录往上找 `.mnemon`（宿主没把存储根传进来时也能定位到服务设置）。
  const configuredDir = typeof config.dataDir === 'string' ? config.dataDir.trim() : ''
  if (configuredDir !== '') {
    let current = path.resolve(configuredDir)
    for (let i = 0; i < 6; i += 1) {
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
      files.push(path.join(current, '.mnemon', 'state', 'memory-providers.json'))
      files.push(path.join(current, 'state', 'memory-providers.json'))
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
    const types = (Array.isArray(raw.types) && raw.types.length > 0 ? raw.types : [{ ...SYSTEM_TYPE }]).map((type) => (type && type.id === SYSTEM_TYPE.id ? { ...type, system: true } : type))
    const experiences = Array.isArray(raw.experiences) ? raw.experiences.filter((item) => item && typeof item === 'object') : []
    return { version: Number(raw.version) || 1, types, experiences }
  } catch {
    return { version: 1, types: [{ ...SYSTEM_TYPE }], experiences: [] }
  }
}

export function writeStore(dataDir, store) {
  const file = storeFile(dataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    types: Array.isArray(store.types) && store.types.length > 0 ? store.types : [{ ...SYSTEM_TYPE }],
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

/** 类型名规范化：NFKC、去控制字符、压空白、限长。返回 '' 表示无效。 */
export function normalizeTypeName(raw) {
  if (typeof raw !== 'string') return ''
  const cleaned = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ')
  if (cleaned.length < 2) return ''
  return cleaned.slice(0, 16)
}

function typeBigrams(name) {
  const text = normalizeTypeName(name).toLowerCase().replace(/\s+/g, '')
  const set = new Set()
  if (text.length <= 1) {
    if (text !== '') set.add(text)
    return set
  }
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2))
  return set
}

/** 两个类型名的字符二元组 Jaccard 相似度。 */
export function typeNameSimilarity(left, right) {
  const a = typeBigrams(left)
  const b = typeBigrams(right)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const gram of a) if (b.has(gram)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function ensureSystemType(types) {
  if (!types.some((type) => type.system === true || type.id === SYSTEM_TYPE.id)) types.push({ ...SYSTEM_TYPE })
}

function startOfToday(now) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * 决定一条经验该用哪个类型；没有就按需创建，但有四道防膨胀限制：
 *  1. 规范化 + 长度限制（2–16 字符）；
 *  2. 与现有类型近似（二元组 Jaccard ≥ similarity）→ 归到已有的，不新建；
 *  3. 泛化名（其他/杂项/随便…）→ 未分类；
 *  4. 数量上限（maxTypes）与每日新增上限（newTypesPerDay）→ 超限归未分类并给出原因。
 * @returns {{type: object, created: boolean, mergedInto?: string, rejected?: string, reason?: string}}
 */
export function resolveTypeForRecord(store, rawName, options = {}) {
  ensureSystemType(store.types)
  const fallback = store.types.find((type) => type.id === SYSTEM_TYPE.id)
  const name = normalizeTypeName(rawName)
  if (name === '') return { type: fallback, created: false, reason: name === '' && String(rawName || '').trim() !== '' ? 'invalid-name' : 'no-type' }
  if (GENERIC_TYPE_NAMES.has(name.toLowerCase())) return { type: fallback, created: false, reason: 'generic-name' }

  const existing = findType(store.types, name)
  if (existing !== null) return { type: existing, created: false }

  const similarity = Number.isFinite(Number(options.similarity)) ? Number(options.similarity) : DEFAULT_TYPE_SIMILARITY
  const lowered = name.toLowerCase()
  for (const type of store.types) {
    if (type.system === true || type.id === SYSTEM_TYPE.id) continue
    const existingName = String(type.name).toLowerCase()
    if (existingName !== '' && (existingName.includes(lowered) || lowered.includes(existingName))) {
      return { type, created: false, mergedInto: type.name, reason: 'similar-name' }
    }
  }
  let nearest = null
  let nearestScore = 0
  for (const type of store.types) {
    if (type.system === true || type.id === SYSTEM_TYPE.id) continue
    const score = typeNameSimilarity(name, type.name)
    if (score > nearestScore) {
      nearestScore = score
      nearest = type
    }
  }
  if (nearest !== null && nearestScore >= similarity) {
    return { type: nearest, created: false, mergedInto: nearest.name, reason: 'similar-name' }
  }

  const userTypes = store.types.filter((type) => type.system !== true && type.id !== SYSTEM_TYPE.id)
  const maxTypes = Math.max(1, Math.trunc(Number(options.maxTypes) || DEFAULT_MAX_TYPES))
  if (userTypes.length >= maxTypes) {
    return { type: fallback, created: false, rejected: 'limit', reason: `已达到类型上限 ${maxTypes}` }
  }
  const perDay = Math.max(1, Math.trunc(Number(options.newTypesPerDay) || DEFAULT_NEW_TYPES_PER_DAY))
  const today = startOfToday(Date.now())
  const createdToday = userTypes.filter((type) => {
    const at = Date.parse(type.createdAt || '')
    return Number.isFinite(at) && at >= today
  }).length
  if (createdToday >= perDay) {
    return { type: fallback, created: false, rejected: 'rate', reason: `每天最多新建 ${perDay} 个类型` }
  }

  const type = {
    id: `ty_${createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 8)}`,
    name,
    description: String(options.typeDescription || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 120),
    createdAt: new Date().toISOString(),
    source: 'model-created',
  }
  store.types.push(type)
  return { type, created: true }
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
  const resolved = resolveTypeForRecord(store, input.type, {
    typeDescription: input.typeDescription,
    maxTypes: options.maxTypes,
    newTypesPerDay: options.newTypesPerDay,
    similarity: options.typeSimilarity,
  })
  const type = resolved.type
  const hasExplicitType = String(input.type || '').trim() !== ''
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
    if (hasExplicitType && type !== undefined) {
      duplicate.typeId = type.id
      duplicate.typeName = type.name
    }
    return { experience: duplicate, action: 'updated', type: resolved }
  }

  // 2) 近似替换：同类型、做法不同、意图相似度达阈值 → 新条 + 旧条 superseded_by
  const replaceTarget = type === undefined ? undefined : active.find((item) => item.typeId === type.id
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
    typeId: type === undefined ? SYSTEM_TYPE.id : type.id,
    typeName: type === undefined ? SYSTEM_TYPE.name : type.name,
    typeSource: resolved.created ? 'created' : 'existing',
    deleted_at: null,
    superseded_by: null,
  }
  if (replaceTarget !== undefined) {
    experience.supersedes = replaceTarget.id
    replaceTarget.superseded_by = experience.id
  }
  store.experiences.push(experience)
  return { experience, action: replaceTarget === undefined ? 'added' : 'superseded', supersededId: replaceTarget === undefined ? undefined : replaceTarget.id, type: resolved }
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

/** Insight 视图：给 Provider 的 list / search / graph 用。所有字段都必须是 JSON 值（不能出现 undefined）。 */
export function toInsight(experience, score) {
  const tokens = tokenize(`${experience.intent} ${experience.action}`)
  const insight = {
    id: experience.id,
    content: `[${experience.typeName}] ${experience.intent} → ${experience.action}（${experience.outcome}${experience.note ? `；${experience.note}` : ''}）`,
    category: 'insight',
    importance: 3,
    tags: [experience.typeName, experience.origin].filter(Boolean),
    entities: tokens.slice(0, 6),
    source: experience.origin === 'manual' ? 'user' : experience.origin === 'auto' ? 'agent' : 'external',
  }
  // 关键：无分数时**不要**写 `score: undefined`——宿主会报 "management result contains a non-JSON value"。
  if (Number.isFinite(score)) insight.score = score
  return insight
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

/** 类型列表（含使用条数）；system 类型排在最后。 */
export function listTypes(store) {
  const counts = new Map()
  for (const item of store.experiences) {
    if (item.deleted_at) continue
    counts.set(item.typeId, (counts.get(item.typeId) || 0) + 1)
  }
  return store.types
    .map((type) => ({
      id: type.id,
      name: type.name,
      description: type.description || '',
      system: type.system === true || type.id === SYSTEM_TYPE.id,
      source: type.source || 'preset',
      createdAt: type.createdAt || '',
      count: counts.get(type.id) || 0,
    }))
    .sort((left, right) => Number(left.system) - Number(right.system) || right.count - left.count || left.name.localeCompare(right.name, 'zh'))
}

function requireEditableType(store, nameOrId) {
  const type = findType(store.types, nameOrId)
  if (type === null) throw new Error(`没有这个类型：${String(nameOrId)}`)
  if (type.system === true || type.id === SYSTEM_TYPE.id) throw new Error('「未分类」是系统类型，不能改名/删除')
  return type
}

function ensureUniqueName(store, name, exceptId) {
  const existing = store.types.find((type) => type.id !== exceptId && String(type.name).toLowerCase() === name.toLowerCase())
  if (existing !== undefined) throw new Error(`类型名已存在：${name}（要合并请用 merge）`)
}

/** 新建一个管理动作显式指定的类型（不走每日创建配额）。 */
export function createType(store, rawName, description = '') {
  const name = normalizeTypeName(rawName)
  if (name === '') throw new Error('类型名无效（2–16 个字符）')
  if (findType(store.types, name) !== null) throw new Error(`类型已存在：${name}`)
  const type = {
    id: `ty_${createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 8)}`,
    name,
    description: String(description || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 120),
    createdAt: new Date().toISOString(),
    source: 'model-created',
  }
  store.types.push(type)
  return type
}

/** 改名；同步更新引用它的经验。 */
export function renameType(store, nameOrId, rawNewName, description) {
  const type = requireEditableType(store, nameOrId)
  const newName = normalizeTypeName(rawNewName)
  if (newName === '') throw new Error('新类型名无效（2–16 个字符）')
  ensureUniqueName(store, newName, type.id)
  const oldName = type.name
  type.name = newName
  if (description !== undefined) type.description = String(description || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 120)
  for (const item of store.experiences) {
    if (item.typeId === type.id) item.typeName = newName
  }
  return { type, oldName }
}

/** 合并多个类型到一个目标类型；经验批量改挂，源类型删除。 */
export function mergeTypes(store, names, rawTargetName, description) {
  ensureSystemType(store.types)
  const sources = [...new Set((Array.isArray(names) ? names : [names]).map((name) => findType(store.types, name)).filter((type) => type !== null))]
  if (sources.length === 0) throw new Error('没有找到要合并的类型')
  if (sources.some((type) => type.system === true || type.id === SYSTEM_TYPE.id)) throw new Error('「未分类」是系统类型，不能作为合并来源')

  const targetName = normalizeTypeName(rawTargetName) || sources[0].name
  let target = findType(store.types, targetName)
  if (target === null) target = createType(store, targetName, description || '')
  else if (target.system === true) throw new Error('不能合并到「未分类」；请指定一个业务类型作为目标')

  let moved = 0
  const sourceIds = new Set(sources.map((type) => type.id).filter((id) => id !== target.id))
  for (const item of store.experiences) {
    if (sourceIds.has(item.typeId)) {
      item.typeId = target.id
      item.typeName = target.name
      moved += 1
    }
  }
  store.types = store.types.filter((type) => !sourceIds.has(type.id))
  return { target: target.name, targetId: target.id, moved, removed: sourceIds.size }
}

/** 删除类型；经验归「未分类」。 */
export function deleteType(store, nameOrId) {
  const type = requireEditableType(store, nameOrId)
  ensureSystemType(store.types)
  const fallback = store.types.find((item) => item.id === SYSTEM_TYPE.id)
  let moved = 0
  for (const item of store.experiences) {
    if (item.typeId === type.id) {
      item.typeId = fallback.id
      item.typeName = fallback.name
      moved += 1
    }
  }
  store.types = store.types.filter((item) => item.id !== type.id)
  return { deleted: type.name, moved }
}



/** 每轮提示段的文本：类型目录 + 用法提示（有界，读当前配置的数据文件）。 */
export function renderHint(config = {}, maxCharacters = 900) {
  let store
  try {
    store = readStore(resolveToolDataDir(config))
  } catch {
    store = { types: [{ ...SYSTEM_TYPE }], experiences: [] }
  }
  const active = store.experiences.filter((item) => !item.deleted_at && !item.superseded_by).length
  const userTypes = store.types.filter((type) => type.system !== true && type.id !== SYSTEM_TYPE.id)
  const maxTypes = Math.max(1, Math.trunc(Number(config.maxTypes) || DEFAULT_MAX_TYPES))
  const lines = [
    "【经验库】接同类任务前用 exp_recall(intent) 查历史做法（按 JitRL 优势排序）；做完一个做法用 exp_record 记结果（同一做法会自动合并）；类型可用 exp_type 管理（list/create/rename/merge/delete）。",
    `当前 ${active} 条经验；类型 ${userTypes.length}/${maxTypes}。类型不预设：记经验时可给新类型名（会自动建，但会先做近似合并，泛化名归「未分类」）。`,
    "类型（名称用于识别；描述越具体，写入与召回越准）：",
  ]
  for (const type of store.types) {
    const description = String(type.description || "").replace(/\s+/g, " ").trim()
    lines.push(`- ${type.name}${description === "" ? "" : `：${description.length > 60 ? `${description.slice(0, 59)}…` : description}`}`)
  }
  let text = lines.join("\n")
  if (text.length > maxCharacters) text = `${text.slice(0, Math.max(0, maxCharacters - 1))}…`
  return text
}

