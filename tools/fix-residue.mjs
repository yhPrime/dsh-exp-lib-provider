#!/usr/bin/env node
/**
 * 残渣修复工具（2026-11-07）：把 intent / action / note 里混进的工具调用残渣剥掉。
 *
 *   node tools/fix-residue.mjs [dataDir] [--write]
 *
 * 默认 **dry-run**，只打印将要改什么；加 `--write` 才落盘，且先备份
 * `<dataDir>/exp-lib.json.bak-<时间戳>`，写后复查残渣数量。
 *
 * 只做两件事：剥 `</note>` 这类标签、在 `<parameter …>` 处截断；**不改** outcome / G / 类型 /
 * hits，也不删条目。清洗规则与 exp_record 写入时用的是同一个 `sanitizeField`，不会引入第二套口径。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  readStore,
  resolveToolDataDir,
  sanitizeField,
  storeFile,
  visibleExperiences,
  writeStore,
} from '../store.js'

/** 与 audit.mjs 同一口径：note 标签或工具参数残渣。 */
export const RESIDUE_RE = /<\/?\s*note\s*>|<\s*parameter\b/i

const hasResidue = (item) => RESIDUE_RE.test(`${item.intent || ''}\n${item.action || ''}\n${item.note || ''}`)

/**
 * 就地清洗所有可见经验里的残渣（纯函数式：只改传入的 store 对象，落盘由调用方决定）。
 * 清洗后 intent / action 为空说明原来只有残渣——保留原值并报告，不把条目弄成非法。
 * @returns {{changed: Array<{id: string, fields: string[]}>, skipped: Array<{id: string, reason: string}>}}
 */
export function fixResidue(store) {
  const changed = []
  const skipped = []
  for (const item of visibleExperiences(store)) {
    if (!hasResidue(item)) continue
    const next = {
      intent: sanitizeField(item.intent).text,
      action: sanitizeField(item.action).text,
      note: sanitizeField(item.note).text,
    }
    if (next.intent === '' || next.action === '') {
      skipped.push({ id: item.id, reason: '清洗后 intent/action 为空（原值只剩残渣）' })
      continue
    }
    const fields = []
    for (const key of ['intent', 'action', 'note']) {
      if (key === 'note' && (item.note || '') === next.note) continue
      if (key !== 'note' && item[key] === next[key]) continue
      item[key] = next[key]
      fields.push(key)
    }
    if (fields.length > 0) changed.push({ id: item.id, fields })
  }
  return { changed, skipped }
}

function main() {
  const argv = process.argv.slice(2)
  const write = argv.includes('--write')
  const dataDir = path.resolve(argv.find((item) => !item.startsWith('--')) || resolveToolDataDir({}))
  const store = readStore(dataDir)
  const targets = visibleExperiences(store).filter(hasResidue)

  console.log(`残渣体检：${dataDir}`)
  console.log(`可见经验 ${visibleExperiences(store).length} 条｜含残渣 ${targets.length} 条`)
  if (targets.length === 0) {
    console.log('结论：没有残渣条目。')
    return
  }
  const { changed, skipped } = fixResidue(store)
  for (const item of changed) console.log(`  · ${item.id}：清洗 ${item.fields.join(' / ')}`)
  for (const item of skipped) console.log(`  ! ${item.id}：${item.reason}（跳过）`)

  if (!write) {
    console.log('\n这是 dry-run；确认无误后加 --write 落盘（会先备份到 exp-lib.json.bak-<时间戳>）。')
    return
  }

  const file = storeFile(dataDir)
  const backup = `${file}.bak-${Date.now()}`
  fs.copyFileSync(file, backup)
  writeStore(dataDir, store)
  const left = visibleExperiences(readStore(dataDir)).filter(hasResidue)
  console.log(`\n已写回：${changed.length} 条；备份 ${backup}；复查剩余残渣 ${left.length} 条。`)
  if (left.length > 0) process.exitCode = 1
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/fix-residue.mjs')) main()
