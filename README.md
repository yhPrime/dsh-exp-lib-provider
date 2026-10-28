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
# 1) 装包（本地目录）
dsh plugin --profile desktop add "C:\Users\yh\WorkDeepSeek\插件\dsh-exp-lib-provider"
```

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
          dataDir: C:\Users\yh\WorkDeepSeek\插件\经验库\provider-data
```

3) 重启 DSH。

## 创建空间

重启后：**记忆插件 → 记忆空间 → 新建**，选 Provider「经验库」，名称填 `经验库`，描述用默认或自己写：

> 存放工作的经验：每条记录做法与结果，按 JitRL 优势召回，供接同类任务前参考。

启用后，模型的数据会写在 `<dataDir>/exp-lib.json`。

## 语义

- **写入唯一入口**：`exp_record(intent, action, outcome?, type?, note?)`
  - 重复（同做法、相似度 ≥ 0.9）→ 就地更新 `hits / outcome / note`；
  - 近似替换（同意图、同类型、不同做法）→ 新条 + 旧条 `superseded_by`；
  - 其他 → 追加。
- **读取**：`exp_recall(intent, limit?)` → 邻居检索 → `Â = Q̂ − V̂` → `rank_score = Â × confidence`；默认过滤已删与已被取代的旧条。
- **通用 `remember` 被禁用**：面板不出现通用写入入口；若宿主仍调用，返回错误提示改用 `exp_record`。
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
cd dsh-exp-lib-provider
node tests/store.test.mjs      # 9 项：upsert 三分支 / 墓碑 / 过滤 / 排序 / 观测
node tests/provider.test.mjs   # 10 项：manifest / status / discover / 拒收 remember / search / graph / forget
node tests/tools.test.mjs      # 6 项：两工具与 Provider 同一文件同一语义
```

内核（JitRL 数学）与 `dsh-exp-lib-source/kernel.js` 同源，Provider 不依赖其他插件包。

## 边界

- 只做**一个空间**：所有数据写同一个 `exp-lib.json`；多空间共用会混在一起。
- 没有单条「编辑」入口（协议没有 update）；改内容 = 再记一次（就地更新或取代）。
- `dataDir` 必须落在工作台目录内（家规硬约束），不要放到 `C:\Users\...`。
