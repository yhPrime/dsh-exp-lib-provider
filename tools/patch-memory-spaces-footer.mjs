#!/usr/bin/env node
/**
 * patch-memory-spaces-footer — 让记忆空间卡片页脚对我们这种「三方本地 Provider」也显示统计。
 *
 * 背景（2026-10-30）：
 *   dsh-mnemon-source-memory-spaces 的卡片页脚是二选一——
 *     origin === 'native'  → 「N 条记忆 / N 条连接 / 大小」
 *     其他（三方 Provider） → 「第三方本地记忆 / 数据目录」
 *   但经验库 Provider 的 status() 本来就返回 stats（条数、连接、文件大小），宿主会把
 *   stats 合并进卡片数据（lib/index.js 的 collectSpaces：{ ...metadata, ...status }），
 *   只是客户端按 origin 分叉，把 stats 丢掉了。
 *
 * 本补丁只改页脚那一个三元条件：
 *   有 stats 就按统计显示（原 native 那支），没有 stats 才退回「类型 + 目录」；
 *   并把经验库（provider id = exp-lib）的计数文案写成「N 条经验」，其余空间仍是「N 条记忆」。
 *
 * 为什么必须单独打补丁而不是改自己的插件：
 *   Provider 只提供数据面，卡片是 memory-spaces 包的客户端 bundle 渲染的；
 *   Provider 侧没有「页脚显示什么」的扩展点。
 *
 * 注意：
 *   - profile 里装好的包文件是 pnpm store 的**硬链接**，原地写会污染全局 store；
 *     本脚本写临时文件后 rename 覆盖，断开硬链接（新 inode），store 原文件不动。
 *   - 重装 / 升级 dsh-mnemon（会带回新版 memory-spaces）后补丁丢失，重跑本脚本即可。
 *     上游改了页脚实现时，脚本会因为找不到锚点而**报错退出**，不会静默改错地方。
 *   - 原文件备份到 `./备份/<日期>/`（可用 `EXP_PATCH_BACKUP_DIR` 指定别处）。
 *
 * 用法（在包目录或安装目录运行）：
 *   node tools/patch-memory-spaces-footer.mjs                    # 默认 desktop profile
 *   node tools/patch-memory-spaces-footer.mjs --profile desktop
 *   node tools/patch-memory-spaces-footer.mjs <client.js 绝对路径>
 *   node tools/patch-memory-spaces-footer.mjs --check-only       # 只报告状态，不写
 *   node tools/patch-memory-spaces-footer.mjs --no-backup
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

export const PACKAGE_NAME = 'dsh-mnemon-source-memory-spaces'
export const CLIENT_RELATIVE_PATH = 'node_modules/dsh-mnemon-source-memory-spaces/lib/client.js'

/** 页脚三元条件的原锚点（三方分支） */
export const FOOTER_ANCHOR = '!nativeSpaceProvider(body.provider) ?'
/** 打完补丁后的条件：有 stats 才优先走统计分支 */
export const PATCHED_CONDITION = 'body.stats === void 0 && !nativeSpaceProvider(body.provider) ?'
/** 计数文案的原文（footer 里出现两次：title 与 children） */
const MEMORY_TEXT = 't("common.memories", { count: body.stats?.totalInsights ?? 0 })'
/** 经验库专用文案：同一个数，但叫「条经验」 */
export const EXPERIENCE_TEXT = `(body.provider.id === "exp-lib" ? \`\${body.stats?.totalInsights ?? 0} 条经验\` : ${MEMORY_TEXT})`

/** 页脚起点标记（`className: sidebarCss.bodyCardStats`） */
const FOOTER_START_MARKER = 'bodyCardStats'
/** 页脚结束标记（动作区紧跟页脚之后） */
const FOOTER_END_MARKER = 'bodyCardActions'
/** 统计分支里一定有的类名，用来确认锚点在页脚内 */
const FOOTER_BLOCK_MARKER = 'bodyFooterBlock'

function countOf(text, needle) {
  return text.split(needle).length - 1
}

function alreadyPatched(text) {
  return text.includes(PATCHED_CONDITION) && text.includes(EXPERIENCE_TEXT)
}

/**
 * 纯函数：改文本。失败抛 Error（带原因），成功返回 { text, changed }。
 * @param {string} text
 * @returns {{ text: string, changed: boolean }}
 */
export function patchText(text) {
  if (alreadyPatched(text)) return { text, changed: false }

  // 不能直接 indexOf('bodyCardStats')：类名映射表里也有一份 "bodyCardStats": "IIa07q_..."，
  // 会先命中。改为围着每个锚点看前后窗口，同时命中「页脚统计容器 + 统计块 + 动作区」才算页脚。
  const anchorIndexes = []
  for (let index = text.indexOf(FOOTER_ANCHOR); index >= 0; index = text.indexOf(FOOTER_ANCHOR, index + 1)) {
    anchorIndexes.push(index)
  }
  if (anchorIndexes.length === 0) throw new Error(`找不到锚点 ${FOOTER_ANCHOR}：memory-spaces 的卡片实现可能变了`)

  const candidates = anchorIndexes.filter((index) => {
    const before = text.slice(Math.max(0, index - 400), index)
    const after = text.slice(index, index + 2500)
    return before.includes(FOOTER_START_MARKER) && after.includes(FOOTER_BLOCK_MARKER) && after.includes(FOOTER_END_MARKER)
  })
  if (candidates.length !== 1) {
    throw new Error(`页脚条件应恰好命中 1 处，实际 ${candidates.length} 处：memory-spaces 的卡片实现可能变了`)
  }
  const anchor = candidates[0]

  const footerEnd = text.indexOf(FOOTER_END_MARKER, anchor)
  if (footerEnd < 0) throw new Error(`找不到页脚结束标记 ${FOOTER_END_MARKER}：中止`)

  const footer = text.slice(anchor, footerEnd)
  const memoryTexts = countOf(footer, MEMORY_TEXT)
  if (memoryTexts < 2) throw new Error(`页脚里只找到 ${memoryTexts} 处「条记忆」文案（应为 2 处）：中止`)

  const patchedFooter = footer
    .replace(FOOTER_ANCHOR, PATCHED_CONDITION)
    .split(MEMORY_TEXT)
    .join(EXPERIENCE_TEXT)

  return { text: text.slice(0, anchor) + patchedFooter + text.slice(footerEnd), changed: true }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function defaultDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** 找出要补丁的 client.js：显式路径 > 指定 profile > 逐个 profile 探测 */
export function resolveTarget(options = {}) {
  if (options.target !== undefined) {
    const target = path.resolve(options.target)
    if (!fs.existsSync(target)) throw new Error(`文件不存在：${target}`)
    return target
  }
  const dshHome = options.dshHome ?? defaultDshHome()
  const profilesRoot = path.join(dshHome, 'profiles')
  const profile = options.profile ?? 'desktop'
  const direct = path.join(profilesRoot, profile, CLIENT_RELATIVE_PATH)
  if (fs.existsSync(direct)) return direct
  if (!fs.existsSync(profilesRoot)) throw new Error(`找不到 profile 目录：${profilesRoot}`)
  for (const name of fs.readdirSync(profilesRoot)) {
    const candidate = path.join(profilesRoot, name, CLIENT_RELATIVE_PATH)
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(`没有任何 profile 装了 ${PACKAGE_NAME}：${profilesRoot}`)
}

function backupPathFor(target) {
  const configured = String(process.env.EXP_PATCH_BACKUP_DIR || '').trim()
  const root = configured === '' ? path.join(process.cwd(), '备份') : path.resolve(configured)
  const day = new Date().toISOString().slice(0, 10)
  const version = readJson(path.join(path.dirname(target), '..', 'package.json'))?.version ?? 'unknown'
  return path.join(root, day, `${PACKAGE_NAME}-${version}-${path.basename(target)}.orig`)
}

/**
 * 应用到文件：读 → 备份（可选）→ 写临时文件 → rename 覆盖（断开硬链接）→ 校验。
 * @returns {{ target: string, changed: boolean, version: string, nlinkBefore: number, nlinkAfter: number, bytesBefore: number, bytesAfter: number, backup?: string }}
 */
export function patchFile(target, options = {}) {
  const stat = fs.statSync(target)
  const original = fs.readFileSync(target, 'utf8')
  const version = readJson(path.join(path.dirname(target), '..', 'package.json'))?.version ?? 'unknown'

  const { text, changed } = patchText(original)
  const summary = {
    target,
    changed,
    version,
    nlinkBefore: stat.nlink,
    bytesBefore: stat.size,
    nlinkAfter: stat.nlink,
    bytesAfter: stat.size,
  }
  if (!changed || options.checkOnly === true) return summary

  if (options.backup !== false) {
    const backup = backupPathFor(target)
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, 'utf8')
    summary.backup = backup
  }

  // 关键：不能原地 writeFileSync（那会顺着硬链接写穿 pnpm store）。
  // 先写同目录临时文件（新 inode），再 rename 覆盖目录项。
  const temp = path.join(path.dirname(target), `${path.basename(target)}.patch-tmp-${process.pid}`)
  fs.writeFileSync(temp, text, 'utf8')
  try {
    fs.renameSync(temp, target)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // 忽略清理失败
    }
    throw error
  }

  const after = fs.statSync(target)
  summary.nlinkAfter = after.nlink
  summary.bytesAfter = after.size
  return summary
}

function parseArgs(argv) {
  const options = { backup: true, checkOnly: false }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') {
      options.profile = argv[index + 1]
      index += 1
    } else if (arg === '--no-backup') {
      options.backup = false
    } else if (arg === '--check-only') {
      options.checkOnly = true
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数：${arg}`)
    } else {
      rest.push(arg)
    }
  }
  if (rest.length > 0) options.target = rest[0]
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const target = resolveTarget(options)
  const summary = patchFile(target, options)
  console.log(JSON.stringify(summary, null, 2))
  if (summary.changed === true && summary.nlinkAfter > 1) {
    console.error('警告：补丁后文件仍是硬链接（nlink > 1），可能写穿了 pnpm store，请检查。')
    process.exitCode = 1
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(`补丁失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
