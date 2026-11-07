/**
 * 工具面：exp_record / exp_recall / exp_feedback / exp_type。
 *
 * 同一份数据、同一套语义；写入只走 exp_record（Provider 的通用 remember 被禁用）。
 * SDK 由 index.js 注入，测试用桩。
 */

import {
  FEEDBACK_ETA,
  applyFeedback,
  assignType,
  createType,
  deleteType,
  findType,
  listTypes,
  mergeTypes,
  rankExperiences,
  readStore,
  renameType,
  resolveToolDataDir,
  scoreOf,
  upsertExperience,
  writeStore,
} from './store.js'
import { routeCluster } from './cluster.js'

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * @param {Function} defineTool - `@deepseek-ai/dsh-tools` 的 defineTool
 * @param {{dataDir?: string, mergeThreshold?: number, replaceThreshold?: number}} config
 */
export function buildTools(defineTool, config = {}) {
  // 跟随记忆插件里的 Provider 服务设置（用户改数据目录后工具自动跟随），读不到才退回插件配置。
  const dataDirOf = () => resolveToolDataDir(config)

  const record = defineTool({
    name: 'exp_record',
    description: '记录一条工作经验（做法 + 结果）。同一做法会就地更新 hits，近似替换会写新条并标记旧条被取代。',
    parameters: {
      intent: { type: 'string', required: true, description: '要做的任务/意图。' },
      action: { type: 'string', required: true, description: '采取的做法或方案名。' },
      outcome: { type: 'string', enum: ['accepted', 'success', 'partial', 'unknown', 'failed', 'corrected', 'aborted'], description: '结果；影响回报 G。' },
      type: { type: 'string', description: '类型名（可选）。不填归「未分类」；填了新名字会按需新建类型（受上限与近似合并限制）。' },
      typeDescription: { type: 'string', description: '新建类型时的描述（≤120 字）：这个类型收什么、召回时怎么用。复用已有类型时忽略。' },
      note: { type: 'string', description: '关键步骤、为什么有效、踩了什么坑。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const store = readStore(dataDir)
      // 没给类型时按簇路由自动归族（config.routing='off' 或 autoAssign=false 可关）；落不进任何簇就保持「未分类」。
      const autoAssign = config.autoAssign !== false && config.routing !== 'off'
      let typeName = args.type
      let routedCluster = null
      if ((typeName === undefined || typeName === null || String(typeName).trim() === '') && autoAssign) {
        const route = routeCluster(store, String(args.intent || ''))
        if (!route.fallback) {
          typeName = route.name
          routedCluster = { clusterId: route.clusterId, name: route.name, score: route.score }
        }
      }
      const result = upsertExperience(store, {
        intent: args.intent,
        action: args.action,
        outcome: args.outcome,
        type: typeName,
        typeDescription: args.typeDescription,
        note: args.note,
      }, {
        mergeThreshold: config.mergeThreshold,
        replaceThreshold: config.replaceThreshold,
        maxTypes: config.maxTypes,
        newTypesPerDay: config.newTypesPerDay,
        typeSimilarity: config.typeSimilarity,
      })
      writeStore(dataDir, store)
      const typeInfo = result.type || {}
      const sanitized = result.sanitized || {}
      const active = store.experiences.filter((item) => !item.deleted_at && !item.superseded_by)
      const negativeSamples = active.filter((item) => Number(item.G) < 0).length
      return {
        action: result.action,
        id: result.experience.id,
        hits: result.experience.hits,
        outcome: result.experience.outcome,
        G: result.experience.G,
        typeName: result.experience.typeName,
        typeCreated: typeInfo.created === true,
        typeMergedInto: typeInfo.mergedInto || null,
        typeWarning: typeInfo.rejected ? `${typeInfo.reason}（已归「未分类」）` : null,
        typeRecoveredFromNote: result.typeRecoveredFromNote === true,
        noteSanitized: sanitized.note === true || sanitized.intent === true || sanitized.action === true,
        clusterName: result.experience.typeName,
        routedCluster,
        typeCount: store.types.filter((type) => type.system !== true && type.id !== 'ty_other').length,
        typeLimit: Math.max(1, Math.trunc(Number(config.maxTypes) || 24)),
        supersededId: result.supersededId || null,
        count: active.length,
        negativeSamples,
        qualityHint: negativeSamples === 0 && active.length >= 4
          ? '库里目前没有失败/纠正样本：召回会标 mode=evidence（Â 不具区分度）。遇到返工、被纠正或失败，请用 corrected/failed 记一条，负样本才让排序有信息量。'
          : null,
      }
    },
  })

  const recall = defineTool({
    name: 'exp_recall',
    description: '按任务意图召回历史经验。默认先做簇路由（确定性的簇内检索，无同族回退全库）；返回 brief（记忆简报）、route（路由结果）与 candidates。mode=advantage：按 JitRL 优势排序；mode=evidence：无成败对照，Â 不具区分度，改按相似度×证据强度排序。',
    parameters: {
      intent: { type: 'string', required: true, description: '当前任务意图。' },
      limit: { type: 'number', description: '返回几条候选做法，默认 8。' },
      cluster: { type: 'string', description: '可选：直接指定簇（类型名或 id），跳过路由。' },
      all: { type: 'boolean', description: '可选：强制全库检索，忽略路由。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const store = readStore(dataDir)
      const routing = args.all === true
        ? 'off'
        : (config.routing === 'shadow' ? 'shadow' : config.routing === 'off' ? 'off' : 'on')
      let clusterId
      if (args.cluster !== undefined && args.cluster !== null && String(args.cluster).trim() !== '') {
        const type = findType(store.types, String(args.cluster))
        if (type === null) throw new Error(`没有这个簇：${String(args.cluster)}（用 exp_type list 看现有类型）`)
        clusterId = type.id
      }
      return rankExperiences(store, String(args.intent || ''), args.limit || 8, { routing, clusterId })
    },
  })

  const feedback = defineTool({
    name: 'exp_feedback',
    description: '用过一条召回的经验之后回报结果：helped（靠它做成了）/ hurt（用了反而返工、被纠正或没帮上）/ neutral（用了但没影响）。反馈按 EMA 修正该条的回报 G（排序依据），不动 hits、不新建条目、不改 outcome；下次召回按新回报排序。',
    parameters: {
      id: { type: 'string', required: true, description: '经验 id（exp_recall 结果里 evidence[].id）。' },
      result: { type: 'string', enum: ['helped', 'hurt', 'neutral'], required: true, description: '用后结果：helped / hurt / neutral。' },
      intent: { type: 'string', description: '可选：当时任务的意图（只进审计日志，不动经验内容）。' },
      note: { type: 'string', description: '可选：怎么用的、结果如何（≤200 字，只进审计日志）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const store = readStore(dataDir)
      const result = applyFeedback(store, args.id, { result: args.result, intent: args.intent, note: args.note }, { eta: config.feedbackEta })
      writeStore(dataDir, store)
      const active = store.experiences.filter((item) => !item.deleted_at && !item.superseded_by)
      const covered = active.filter((item) => item.feedback !== null && typeof item.feedback === 'object'
        && (Number(item.feedback.helped) || 0) + (Number(item.feedback.hurt) || 0) + (Number(item.feedback.neutral) || 0) > 0).length
      return {
        action: 'feedback',
        ...result,
        hint: result.result === 'neutral'
          ? 'neutral 只计数，G 不变（没有证据说明这条更有效或更差）。'
          : `G ${result.G_before} → ${result.G_after}（EMA η=${FEEDBACK_ETA}）：下次召回按新回报排序；outcome 仍记的是首次结果。`,
        feedbackCovered: covered,
        count: active.length,
      }
    },
  })

  const typeTool = defineTool({
    name: 'exp_type',
    description: '管理经验类型：list 列表（含条数）/ create 新建 / rename 改名 / merge 合并（经验批量改挂，源类型删除）/ delete 删除（经验归「未分类」）/ assign 把单条经验改挂到指定类型（定点修脏数据，不动 hits）。',
    parameters: {
      action: { type: 'string', enum: ['list', 'create', 'rename', 'merge', 'delete', 'assign'], required: true, description: '要执行的动作。' },
      name: { type: 'string', description: 'create/rename/delete 时的类型名或 id（rename 时是旧名）；assign 时的目标类型名。' },
      newName: { type: 'string', description: 'rename 的新名；merge 的目标类型名（不存在会新建）。' },
      names: { type: 'array', description: 'merge 时的来源类型名/id 列表。' },
      id: { type: 'string', description: 'assign 时的经验 id（exp_recall 证据里的 id）。' },
      description: { type: 'string', description: 'create/rename 时可选写描述（≤120 字）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const store = readStore(dataDir)
      const action = String(args.action || '').trim()
      let result
      if (action === 'list') {
        result = { action, types: listTypes(store) }
      } else if (action === 'create') {
        const type = createType(store, args.name, args.description)
        result = { action, created: type.name, typeId: type.id }
      } else if (action === 'rename') {
        const renamed = renameType(store, args.name, args.newName, args.description)
        result = { action, from: renamed.oldName, to: renamed.type.name }
      } else if (action === 'merge') {
        result = { action, ...mergeTypes(store, args.names, args.newName, args.description) }
      } else if (action === 'delete') {
        result = { action, ...deleteType(store, args.name) }
      } else if (action === 'assign') {
        result = { action, ...assignType(store, args.id, args.name) }
      } else {
        throw new Error(`不支持的类型动作：${action}`)
      }
      writeStore(dataDir, store)
      result.typeCount = store.types.filter((type) => type.system !== true && type.id !== 'ty_other').length
      result.typeLimit = Math.max(1, Math.trunc(Number(config.maxTypes) || 24))
      return result
    },
  })

  return [record, recall, feedback, typeTool]
}

/** 供外部（如管理/调试）复用的回报推断。 */
export { scoreOf }
