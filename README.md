# dsh-exp-lib-provider

把「经验库」做成 **dsh-mnemon 的一个记忆空间 Provider**：空间由一个 JSON 文件存储，面板可观可管，模型的写入只走 `exp_record`，读取走 `exp_recall` 或记忆插件的通用检索（内部同一套 JitRL 排序）。

## 它提供什么

| 项 | 值 |
|---|---|
| `typeId` / 包名 | `exp-lib` / `dsh-exp-lib-provider` |
| 形态 | 本地 Provider（`locality: local`，`workspaceBinding: optional-override`） |
| 能力 | search / browse / graph / entities / forget；**remember: false**；`writeMode: exact`、`deletionMode: soft` |
| 配置字段 | `dataDir`（必填，工作台内的绝对路径） |
| 工具 | `exp_record`、`exp_recall`（与本 Provider 共用同一份数据） |
| 数据 | `<dataDir>/exp-lib.json`：`{ version, types[], experiences[] }` |

## 安装

```powershell
# 1) 打包并安装（tarball，避免 pnpm link 导致运行时依赖解析不到）
cd "<插件目录>\dsh-exp-lib-provider"
npm pack
dsh plugin --profile desktop add "<插件目录>\dsh-exp-lib-provider\dist\dsh-exp-lib-provider-0.1.0.tgz"
```

> 为什么用 tarball：`dsh plugin add <目录>` 会做 pnpm link，运行时按真实路径解析依赖，宿主提供的 `dsh-mnemon-source-memory-spaces` 会找不到。tarball 安装的是包副本，依赖从 profile 的 `node_modules` 解析。**改完代码要重新 pack + add 才会生效。**


2) 在 profile 的 `cordis.patch.yml` 里把 Provider 挂进 memory-spaces 的 providers 列表（**一次性配置**；改前备份）：

```yaml
- id: mnemon-source-memory-spaces
  name: dsh-mnemon-source-memory-spaces
  config:
    providers:
      - use: dsh-mnemon-provider-mnemon-native
        instanceId: mnemon-native
      - use: dsh-mnemon-provider-openviking
        instanceId: openviking
      - use: dsh-mnemon-provider-honcho
        instanceId: honcho
      - use: dsh-mnemon-provider-mem0
        instanceId: mem0
      - use: dsh-mnemon-provider-hindsight
        instanceId: hindsight
      - use: dsh-mnemon-provider-holographic
        instanceId: holographic
      - use: dsh-mnemon-provider-retaindb
        instanceId: retaindb
      - use: dsh-mnemon-provider-byterover
        instanceId: byterover
      - use: dsh-mnemon-provider-supermemory
        instanceId: supermemory
      - use: dsh-exp-lib-provider
        instanceId: exp-lib
        config:
          dataDir: <dataDir>
```

3) 重启 DSH。

## 两层开关（都能在界面里启停）| 层 | 位置 | 控制什么 ||---|---|---|| **DSH 插件** | 插件管理（bundles 里能看到 `dsh-exp-lib-provider`） | 工具面：`exp_recall` / `exp_record` 是否可用 || **记忆 Provider** | 记忆引擎 → Provider 列表里的「经验库」 | 存储/空间：这个 Provider 是否参与记忆空间 | 装好后两处都要开：插件管理里启用插件；记忆引擎里把「经验库」的开关打开。Provider 卡片显示「未启用」是正常的，点右侧开关即可。\n\n## 数据目录从哪来（优先级）\n\n工具面与 Provider 读的是同一份配置：\n\n1. 记忆引擎里「经验库」Provider 的数据目录（`memory-providers.json` 的 `services[\"exp-lib\"].dataDir`）——改了它，工具自动跟随；\n2. 读不到时退回本插件在 `cordis.patch.yml` 里的 `dataDir`；\n3. 再退回工作区下 `.exp/exp-lib-provider`。\n\n所以不必为了改路径重新打包；改 Provider 设置即可。\n\n## 创建空间

重启后：**记忆插件 → 记忆空间 → 新建**，选 Provider「经验库」，名称填 `经验库`，描述用默认或自己写：

> 存放工作的经验：每条记录做法与结果，按 JitRL 优势召回，供接同类任务前参考。

启用后，模型的数据会写在 `<dataDir>/exp-lib.json`。

## 每轮提示层\n\n插件启用时会向系统提示追加一段有界文本（`order: 160`）：类型目录 + 用法提示（`exp_recall` / `exp_record`）。内容每轮动态读当前数据文件，条数会跟着变；`config.hint: false` 可关掉。它不经过记忆组合（不需要 scoped 策略），**禁用插件即消失**。\n\n## 类型：不预设，按需创建 + 四道限制

安装后只有系统兜底类型「未分类」。业务类型由模型在 `exp_record` 时给名字，必要时自动创建；为防止「无限分类」有四道限制：

1. **规范化与长度**：NFKC、去控制字符、压缩空白，2–16 字符；
2. **近似合并**：与已有类型互为子串，或字符二元组 Jaccard ≥ 0.8 → 归到已有类型，不新建；
3. **泛化名归兜底**：其他 / 其它 / 杂项 / 随便 / 未分类… 直接归「未分类」；
4. **数量与频率**：业务类型上限 24 个（`config.maxTypes`），每天最多新建 6 个（`config.newTypesPerDay`），超限归「未分类」并在返回里给 `typeWarning`。

`exp_record` 新增可选 `typeDescription`（≤120 字）：新建类型时写清“收什么、召回怎么用”；复用已有类型时忽略。返回里带 `typeCreated` / `typeMergedInto` / `typeWarning` / `typeCount` / `typeLimit`。

> 已有库里的 10 个类型是历史数据（17 条经验在用），不会因为升级被删；新环境从「未分类」开始。

### 类型管理工具 `exp_type`

| action | 作用 |
|---|---|
| `list` | 列出类型与使用条数（system 排最后） |
| `create` | 新建类型（`name` + 可选 `description`） |
| `rename` | 改名，引用它的经验同步更新 |
| `merge` | `names[]` 合并到 `newName`（不存在会新建），经验批量改挂、源类型删除 |
| `delete` | 删除类型，经验归「未分类」；系统类型不可删 |
## 语义

- **写入唯一入口**：`exp_record(intent, action, outcome?, type?, note?)`
  - 重复（同做法、相似度 ≥ 0.9）→ 就地更新 `hits / outcome / note`；
  - 近似替换（同意图、同类型、不同做法）→ 新条 + 旧条 `superseded_by`；
  - 其他 → 追加。
- **读取**：`exp_recall(intent, limit?)` → 邻居检索 → `Â = Q̂ − V̂` → `rank_score = Â × confidence`；默认过滤已删与已被取代的旧条。
- **通用 `remember` 被禁用**：面板不出现通用写入入口；若宿主仍调用，返回错误提示改用 `exp_record`。
- **契约：adapter 方法一律 async**（返回 Promise）——`discover / status / search / list / graph / entityIndex / remember / forget`。memory-spaces 会把返回值直接当 Promise 用（`untilAborted(discover())`、`status().catch(...)`），同步值会报 `… is not a function`；这类坑已踩过两次（2026-10-29 的 discover 与本日的 status）。
- **忘记 = 软删墓碑**：`deleted_at` 置位，保留 30 天后启动时清理；`forget` 后检索与内容页都不再显示。

## 面板能看到的

| 位置 | 数据 |
|---|---|
| 记忆 Provider 列表 | 经验库（exp-lib）开关与 `dataDir` 配置 |
| 记忆空间 → 检索 | JitRL 优势排序结果 |
| 记忆空间 → 内容 | 全部可见经验（类型、结果、备注） |
| 记忆空间 → 实体 | 意图/做法里的高频词 |
| 记忆空间 → 图谱 | 经验节点 + 「取代」边 |
| 删除 | 软删（可恢复；TTL 后物理清理） |

## 测试

```powershell
npm test
```

62 项全绿：kernel 19 / store 11 / provider 13 / tools 7 / plugin 5 / type-tool 7。

内核（JitRL 数学）随包自带，Provider 不依赖其他插件包。

## 边界

- 只做**一个空间**：所有数据写同一个 `exp-lib.json`；多空间共用会混在一起。
- 没有单条「编辑」入口（协议没有 update）；改内容 = 再记一次（就地更新或取代）。
- `dataDir` 由你配置。建议放工作台内便于 Git 与备份，但宪法 v2.4 不强制——插件数据位置由插件自己决定。
