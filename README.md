# MyMem

> OpenClaw 的 LanceDB 长期记忆插件：自动捕捉、智能提取、混合检索、跨会话回忆与多智能体记忆隔离。

`MyMem` 让 OpenClaw 智能体拥有可持续演化的长期记忆。它会把对话中的用户偏好、项目事实、决策、实体、经验案例和可复用模式写入 LanceDB，并在后续对话中按作用域、相关性、时间衰减和治理规则自动召回。

---

## 目录

- [适合谁使用](#适合谁使用)
- [核心能力](#核心能力)
- [工作原理](#工作原理)
- [安装与快速开始](#安装与快速开始)
- [配置参考](#配置参考)
- [Agent 工具](#agent-工具)
- [CLI 命令](#cli-命令)
- [记忆模型](#记忆模型)
- [作用域与隔离](#作用域与隔离)
- [自动捕捉与自动召回](#自动捕捉与自动召回)
- [Hook 增强闭环](#hook-增强闭环)
- [智能提取与治理](#智能提取与治理)
- [检索、重排序与诊断](#检索重排序与诊断)
- [反思、自改进与学习文件](#反思自改进与学习文件)
- [迁移、备份与运维](#迁移备份与运维)
- [开发与测试](#开发与测试)
- [故障排查](#故障排查)

---

## 适合谁使用

如果你希望 OpenClaw 智能体具备下面任一能力，这个插件就适合你：

- 记住用户长期偏好，例如代码风格、沟通语言、工具选择。
- 记住项目上下文，例如仓库约定、模块职责、踩坑记录。
- 在新会话中自动召回旧信息，而不是依赖手动复制粘贴。
- 给不同智能体、团队、项目设置不同记忆边界。
- 将 `MEMORY.md` / `memory/YYYY-MM-DD.md` 中的历史 Markdown 记忆导入 LanceDB。
- 对记忆进行诊断、统计、迁移、压缩、重嵌入和治理。

---

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 自动捕捉 | 在会话结束或关键 hook 中从对话自动提取记忆，减少手动调用。 |
| 自动召回 | 在 prompt 构建前检索相关记忆并注入上下文，支持预算和去重。 |
| 智能提取 | 使用 LLM 将对话拆成 6 类智能记忆：profile、preferences、entities、events、cases、patterns。 |
| 混合检索 | 向量搜索 + BM25 全文搜索 + RRF 融合 + 可选重排序。 |
| 记忆治理 | 准入控制、噪声过滤、过期/取代、归档、抑制坏召回。 |
| Hook 增强闭环 | 默认开启坏召回反馈、纠错取代、工具错误 playbook、危险工具提示、隐私防护和上下文预算。 |
| 生命周期 | 访问强化、时间衰减、tier 晋升/降级、渐进式 compaction。 |
| 用域隔离 | 支持 global、agent、project、user、reflection 等作用域。 |
| 反思记忆 | 将智能体 reset/new 前的反思写入 LanceDB，并在之后继承规则。 |
| 自改进 | `.learnings/` 学习文件、错误扫描、噪声原型学习和类型先验自适应。 |
| 诊断工具 | `memory_doctor`、`memory_debug`、retrieval diagnostics、CLI stats/search。 |

---

## 工作原理

### 写入路径

```text
message / agent_end / manual tool
  → capture cleanup / noise filter
  → SmartExtractor or regex fallback
  → AdmissionControl / dedup / supersede
  → buildSmartMetadata
  → LanceDB
  → optional mdMirror / audit logs / feedback loop
```

### 读取路径

```text
before_prompt_build / memory_recall / CLI search
  → adaptive retrieval gate
  → embedding query
  → vector search + BM25 search
  → fusion / rerank / score shaping
  → governance filters / workspace boundary filters
  → hook enhancements / context budget
  → formatting
  → prompt injection or tool output
```

### 生命周期路径

```text
access tracking
  → recency / decay score
  → tier manager
  → compaction / archive
  → retrieval boost or suppression
```

### 主要模块

| 模块 | 职责 |
| --- | --- |
| `index.ts` | 插件入口，组装 store、retriever、hooks、tools、CLI、service。 |
| `src/store.ts` | LanceDB CRUD、文件锁、schema 兼容、批量写入。 |
| `src/embedder.ts` | Embedding 适配、chunking、缓存、Ollama/NIM provider profile。 |
| `src/retriever.ts` | 向量/BM25/混合检索、融合、重排序、诊断。 |
| `src/smart-extractor.ts` | LLM 智能提取、dedup、supersede、准入控制。 |
| `src/smart-metadata.ts` | SmartMemoryMetadata 解析、构建和兼容旧 schema。 |
| `src/auto-capture-hook.ts` | 自动捕捉 hook。 |
| `src/auto-recall-hook.ts` | 自动召回 hook。 |
| `src/hook-enhancements.ts` | Hook 级增强：召回反馈、纠错取代、工具提示、隐私防护、session primer。 |
| `src/scopes.ts` | 多作用域访问控制。 |
| `src/decay-engine.ts` | Weibull 衰减与知识/经验差异化评分。 |
| `src/recency-engine.ts` | 轻量级时间衰减。 |
| `src/tier-manager.ts` | core / working / peripheral 层级管理。 |
| `src/memory-compactor.ts` | 相似记忆聚类与渐进式合并。 |
| `src/reflection-store.ts` | 反思记忆持久化与切片加载。 |
| `src/feedback-loop.ts` | 错误与拒绝样本驱动的自适应反馈循环。 |
| `src/tools.ts` | Agent 工具注册。 |
| `src/memory-doctor-tool.ts` | 运行时诊断工具。 |
| `cli.ts` | `openclaw mymem ...` CLI。 |

---

## 安装与快速开始

### 环境要求

- Node.js：建议使用 OpenClaw 当前支持的 Node 版本。
- CPU：LanceDB 原生向量引擎通常要求现代 CPU，x86 机器建议支持 AVX/AVX2。

### 安装插件

把本仓库链接发给你的 Agent，安装 Plugins

如果插件是通过 Git/source path/容器 volume 放到 OpenClaw 插件目录，而不是通过会自动安装依赖的插件管理器安装，需要在运行 OpenClaw 的同一个环境里安装运行时依赖：

```bash
cd /root/.openclaw/workspace/plugins/mymem
npm ci --omit=dev
```

如果目标目录没有 `package-lock.json`，使用：

```bash
npm install --omit=dev
```

默认开启的能力：

| 能力 | 默认状态 |
| --- | --- |
| 自动捕捉 | 开启 |
| 自动召回 | 开启 |
| 智能提取 | 开启 |
| Memory Reflection | 开启 |
| 自改进 | 开启 |
| 管理工具 | 开启 |
| 生命周期维护 | 开启 |

### 推荐配置

```json
{
  "plugins": {
    "slots": {
      "memory": "mymem"
    },
    "entries": {
      "mymem": {
        "enabled": true,
        "config": {
          "embedding": {
            "baseURL": "${EMBEDDING_BASE_URL}",
            "apiKey": "${EMBEDDING_API_KEY}",
            "model": "${EMBEDDING_MODEL}"
          },
          "llm": {
            "baseURL": "${LLM_BASE_URL}",
            "apiKey": "${LLM_API_KEY}",
            "model": "${LLM_MODEL}"
          },
          "retrieval": {
            "rerankEndpoint": "${RERANK_ENDPOINT}",
            "rerankApiKey": "${RERANK_API_KEY}",
            "rerankModel": "${RERANK_MODEL}"
          }
        }
      }
    }
  }
}
```

### 验证配置

```bash
openclaw config validate
openclaw gateway restart
openclaw mymem version
```

查看日志：

```bash
openclaw logs --follow --plain | grep mymem
```

### 手动写入和检索

在智能体对话中可以直接使用工具：

```text
请把“我偏好 TypeScript strict 模式和小函数拆分”记到长期记忆。
```

也可以通过 CLI 检索：

```bash
openclaw mymem search "TypeScript strict" --json
openclaw mymem list --limit 20
openclaw mymem stats --json
```

---

### 常用可选配置

| 字段 | 默认值 | 什么时候改 |
| --- | --- | --- |
| `embedding.dimensions` | `2048` | 维度且不是默认维度时。 |
| `scopes` | `global` | 多 agent / 多项目需要隔离记忆时。 |
| `dbPath` | 默认数据目录 | 想把 LanceDB 放到自定义目录时。 |

### 默认开启的能力

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `autoCapture` | `true` | 自动从对话捕捉长期记忆。 |
| `autoRecall` | `true` | 自动在 prompt 中注入相关记忆。 |
| `smartExtraction` | `true` | 用 LLM 做结构化提取、去重、supersede。 |
| `sessionStrategy` | `memoryReflection` | `/new` 或 `/reset` 前做反思总结。 |
| `memoryReflection.storeToLanceDB` | `true` | 反思写入 LanceDB 参与召回。 |
| `enableManagementTools` | `true` | 注册管理工具，例如 promote/archive/compact/debug。 |
| `selfImprovement.enabled` | `true` | 维护 `.learnings/` 并启用自改进工具。 |
| `lifecycleMaintenance.enabled` | `true` | 启动时执行长期生命周期维护。 |
| `feedbackLoop.enabled` | `true` | 连接错误和拒绝样本到反馈学习。 |
| `hookEnhancements.*` | `true` | 默认开启 hook 级记忆增强；可逐项关闭。 |

### 自动召回预算

默认值适合多数场景，只有上下文过多或召回太少时再调。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `recallMode` | `full` | `full`、`summary`、`adaptive`、`off`。 |
| `autoRecallMaxItems` | `5` | 每轮最多注入记忆数。 |
| `autoRecallMaxChars` | `600` | 注入总字符预算。 |
| `autoRecallPerItemMaxChars` | `180` | 单条记忆字符预算。 |
| `autoRecallMinRepeated` | `8` | 同一会话中同一记忆重复注入间隔。 |
| `autoRecallTimeoutMs` | `8000` | 自动召回超时安全阀；避免 embedding/search/rerank 偶发慢请求拖慢交互前置钩子。 |

### 生命周期维护

默认启用，负责过期/被替代/低价值旧记忆归档，以及 core / working / peripheral 分层调整。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `lifecycleMaintenance.cooldownHours` | `6` | 自动维护冷却时间，单位小时。 |
| `lifecycleMaintenance.maxMemoriesToScan` | `300` | 每次扫描上限。 |
| `lifecycleMaintenance.archiveThreshold` | `0.15` | peripheral 且未访问记忆低于该生命周期分数时归档。 |
| `lifecycleMaintenance.dryRun` | `false` | 只报告维护动作，不写入元数据。 |

### 记忆压缩

`memoryCompaction` 用于相似旧记忆聚类合并。它默认不需要配置；记忆库变大后再按需开启。

```json
{
  "memoryCompaction": {
    "enabled": true,
    "minAgeDays": 14,
    "similarityThreshold": 0.88,
    "minClusterSize": 2,
    "maxMemoriesToScan": 200,
    "cooldownHours": 6
  }
}
```

---

## Agent 工具

插件会注册一组 OpenClaw 工具。核心工具和管理工具默认可用；只有想收窄工具面时才需要设置 `enableManagementTools: false`。

### 核心工具

| 工具 | 用途 |
| --- | --- |
| `memory_recall` | 按 query 检索相关记忆。 |
| `memory_store` | 手动写入记忆。 |
| `memory_forget` | 删除或遗忘指定记忆。 |
| `memory_update` | 更新记忆内容、重要性、分类、metadata。 |

### 管理工具

| 工具 | 用途 |
| --- | --- |
| `memory_stats` | 查看总量、分类、scope 分布。 |
| `memory_doctor` | 检查 storage、scope、retrieval、embedding、rerank 配置。 |
| `memory_debug` | 调试 store/retriever 状态。 |
| `memory_list` | 列出记忆。 |
| `memory_promote` | 提升记忆 tier。 |
| `memory_archive` | 归档记忆。 |
| `memory_compact` | 手动触发 compaction。 |
| `memory_explain_rank` | 解释检索排名和诊断信息。 |

### 自改进工具

| 工具 | 用途 |
| --- | --- |
| `self_improvement_log` | 写入 `.learnings/LEARNINGS.md` 或 `.learnings/ERRORS.md`。 |
| `self_improvement_extract_skill` | 从学习记录中抽取可复用规则。 |
| `self_improvement_review` | 审查当前学习/错误条目。 |
| `self_improvement_distill` | 将学习条目蒸馏成规则 patch。 |

---

## CLI 命令

所有命令位于：

```bash
openclaw mymem <command>
```

### 基础命令

```bash
openclaw mymem version
openclaw mymem list --limit 20
openclaw mymem list --scope global --json
openclaw mymem search "query" --scope global --limit 10 --debug
openclaw mymem stats --json
openclaw mymem delete <id> --scope global
```

### 导入导出

```bash
openclaw mymem export --scope global --output memories.json
openclaw mymem import memories.json --scope global --dry-run
openclaw mymem import memories.json --scope global
```

### Markdown 导入

从 `MEMORY.md` 和 `memory/YYYY-MM-DD.md` 导入：

```bash
openclaw mymem import-markdown /path/to/workspace --dry-run
openclaw mymem import-markdown /path/to/workspace --scope project:demo
openclaw mymem import-markdown "/workspaces/*" --min-text-length 20 --dedup
```

常见选项：

| 选项 | 说明 |
| --- | --- |
| `--dry-run` | 只展示将导入内容。 |
| `--scope <scope>` | 指定导入 scope。 |
| `--category <category>` | 指定分类。 |
| `--importance <n>` | 指定重要性。 |
| `--min-text-length <n>` | 过滤短文本。 |
| `--dedup` | 跳过同 scope 中重复内容。 |

### 批量删除

```bash
openclaw mymem delete-bulk --scope global --before 2026-01-01 --dry-run
openclaw mymem delete-bulk --scope global --before 2026-01-01
```

### 重嵌入

当 embedding 模型、维度或 provider 发生变化时使用：

```bash
openclaw mymem reembed /path/to/source-db /path/to/target-db --dry-run
openclaw mymem reembed /path/to/source-db /path/to/target-db --batch-size 64 --skip-existing
```

### 元数据升级

把旧记忆升级到 SmartMemoryMetadata：

```bash
openclaw mymem upgrade --dry-run
openclaw mymem upgrade --batch-size 20 --limit 100
openclaw mymem upgrade --scope global --no-llm
```

### 迁移旧数据库

```bash
openclaw mymem migrate check --source /path/to/legacy-db
openclaw mymem migrate run --source /path/to/legacy-db --default-scope global --dry-run
openclaw mymem migrate run --source /path/to/legacy-db --skip-existing
openclaw mymem migrate verify --source /path/to/legacy-db
```

### FTS 重建

```bash
openclaw mymem reindex-fts
```

---

## 记忆模型

### 6 类分类体系

| 类别 | 类型 | 说明 | 示例 |
| --- | --- | --- | --- |
| `profile` | knowledge | 用户身份、长期背景 | “用户主要使用 TypeScript。” |
| `preferences` | knowledge | 偏好、习惯、风格 | “用户喜欢先给计划再改代码。” |
| `entities` | knowledge | 项目、服务、人、模块等实体 | “agent-memory 使用 LanceDB。” |
| `events` | experience | 有时间性的事件或决策 | “2026-04-24 改为 strict typecheck。” |
| `cases` | experience | 具体问题与解决过程 | “修复 retriever diagnostics 输出空 latencyMs。” |
| `patterns` | knowledge | 可复用方法、规则、架构模式 | “CLI JSON 输出应保持稳定 schema。” |

### knowledge vs experience

插件把记忆进一步分成两类，用于衰减和检索权重：

- `knowledge`：偏稳定、可复用、可验证，衰减较慢。
- `experience`：一次性轨迹、案例、事件，衰减较快但可在相关场景召回。

### SmartMemoryMetadata

每条记忆的 metadata 会包含：

- L0/L1/L2 多层摘要：`l0_abstract`、`l1_overview`、`l2_content`。
- 分类：`memory_category`、`memory_type`。
- 生命周期：`tier`、`access_count`、`last_accessed_at`、`valid_from`、`valid_until`、`invalidated_at`。
- 治理：`state`、`memory_layer`、`bad_recall_count`、`suppressed_until_turn`。
- 关系：`supersedes`、`superseded_by`、`relations`、`canonical_id`。
- 来源：`source`、`source_session`。

---

## 作用域与隔离

记忆默认按 scope 隔离。常见 scope：

| scope | 用途 |
| --- | --- |
| `global` | 全局共享记忆。 |
| `agent:<id>` | 单个智能体私有记忆。 |
| `project:<id>` | 项目记忆。 |
| `user:<id>` | 用户级记忆。 |
| `reflection:agent:<id>` | 智能体反思记忆。 |

示例：

```json
{
  "scopes": {
    "default": "global",
    "definitions": {
      "global": { "description": "shared memory" },
      "project:api": { "description": "API project memory" },
      "project:web": { "description": "Web project memory" }
    },
    "agentAccess": {
      "backend": ["global", "project:api"],
      "frontend": ["global", "project:web"]
    }
  }
}
```

特殊说明：

- 系统/反思流程可使用 bypass scope filter。
- subagent session 默认跳过自动召回和反思注入，避免后台 agent 阻塞或污染上下文。
- `autoRecallIncludeAgents` / `autoRecallExcludeAgents` 可控制哪些 agent 接受自动召回。

---

## 自动捕捉与自动召回

### 自动捕捉

自动捕捉会在会话过程中收集输入/输出，并在合适时机写入长期记忆。它会尽量过滤：

- OpenClaw runtime wrapper。
- 飞书/Telegram 等消息 envelope metadata。
- 纯命令、纯问候、极短文本。
- USER.md 独占上下文。
- 噪声原型命中的低价值内容。

### 自动召回

自动召回会在 prompt 构建前执行：

1. 从最新用户输入生成 recall query。
2. 跳过太短、命令式或低价值 query。
3. 使用 scope filter 检索可访问记忆。
4. 过滤 archived/reflection/pending/expired/suppressed 记忆。
5. 根据字符预算格式化为 `<relevant-memories>` 块。
6. 标记为 untrusted historical data，避免把记忆内容当成指令执行。

可选调优：默认预算适合多数场景；如果想减少注入内容，可以按需覆盖。

```json
{
  "recallMode": "summary",
  "autoRecallMaxItems": 3,
  "autoRecallMaxChars": 500
}
```

---

## Hook 增强闭环

`hookEnhancements` 是默认开启的一组软干预 hook。它们会补强自动召回和自动捕捉的质量闭环，但不会阻断工具执行，也不会删除已有记忆。

| 能力 | 触发点 | 行为 |
| --- | --- | --- |
| 坏召回反馈 | auto-recall + `agent_end` | 记录本轮注入的 memory id；如果后续出现“记错/无关/过时”等纠正信号，增加 `bad_recall_count` 并短期抑制。 |
| 纠错取代 | `agent_end` | 识别“不是 A，是 B / 改成 B / 以后不要 A”等表达，检索相似旧记忆并创建 supersede 链路。 |
| 工具错误 playbook | `after_tool_call` + `before_prompt_build` | 工具失败后，在下一轮 prompt 构建前召回相似历史错误和 learning，注入 `<tool-error-playbook>`。 |
| 危险工具提示 | `before_tool_call` / `registerHook` | 对 `rm -rf`、`git reset --hard`、部署、迁移等高风险操作召回相关约束，只返回 advisory hint，不阻断。 |
| 隐私防护 | auto-capture 写入前 | 检测 API key、token、private key 等敏感内容，跳过入库并写 warning。 |
| Session primer | 首次 `before_prompt_build` | 新会话开始时优先恢复用户偏好、长期原则和助理行为约束，形成 `<session-primer>`。 |
| Workspace drift | `after_tool_call` + `agent_end` | 根据本轮触及文件给近期注入记忆补充 `workspace_files` 等 metadata。 |
| 陈旧记忆提示 | `before_prompt_build` | 对很旧的召回项注入“先验证再依赖”的轻提示。 |
| 上下文预算 | `before_prompt_build` | 对新增增强块做统一字符预算，优先保留错误/安全相关提示。 |

所有子能力默认开启。需要降低干预时可以逐项关闭：

```json
{
  "hookEnhancements": {
    "dangerousToolHints": false,
    "sessionPrimer": false,
    "privacyGuard": true
  }
}
```

注意：危险工具提示依赖宿主是否发出 `before_tool_call` 事件；如果当前 OpenClaw 运行时没有该事件，相关 hook 会保持注册但不会触发。

---

## 智能提取与治理

### SmartExtractor

启用 `smartExtraction` 后，插件会调用 LLM 将对话转换为结构化候选记忆：

- 提取 L0/L1/L2。
- 选择 6 类 memory category。
- 判断 memory type。
- 生成 fact key、relations、temporal 信息。
- 对相似偏好/实体执行 supersede，而不是直接删除历史。

### AdmissionControl

准入控制用于减少“什么都记”的问题。它会结合：

- utility：是否对未来有用。
- confidence：候选是否明确可靠。
- novelty：是否与已有记忆重复。
- recency gap：是否过于短期。
- type prior：不同类别的基础价值。

开启示例：

```json
{
  "admissionControl": {
    "enabled": true,
    "preset": "balanced",
    "rejectThreshold": 0.45,
    "admitThreshold": 0.6,
    "persistRejectedAudits": true
  }
}
```

### 噪声学习

`NoisePrototypeBank` 和 `feedbackLoop` 可以从错误文件和拒绝样本中学习噪声原型，降低 wrapper、日志噪声、模板文本等被写入记忆的概率。

---

## 检索、重排序与诊断

### 混合检索

`retrieval.mode = hybrid` 时，插件会并行运行：

- embedding vector search。
- BM25 full-text search。
- RRF/fusion。
- 可选 rerank。
- recency / importance / decay / length / diversity 调整。

### 调试检索

CLI：

```bash
openclaw mymem search "服务挂了" --debug
openclaw mymem search "服务挂了" --debug --json
```

Agent 工具：

- `memory_debug`
- `memory_explain_rank`
- `memory_doctor`

`memory_doctor` 会检查：

- 当前 agent 可访问 scopes。
- store 是否可读。
- FTS 是否可用。
- retriever 配置是否合理。
- rerank 配置是否缺 key/endpoint。
- 可选 embedding probe。

---

## 反思、自改进与学习文件

### Memory Reflection

默认策略 `sessionStrategy = memoryReflection` 会在 `/new` 或 `/reset` 前总结近期对话，产出：

- 稳定规则：后续作为 inherited rules 注入。
- 派生经验：按 agent 和 session 管理。
- 错误信号：用于自改进和提醒。

反思记忆默认写入 `reflection:agent:<id>` scope。

### `.learnings/`

插件会维护：

```text
.learnings/
  LEARNINGS.md
  ERRORS.md
```

相关工具：

```text
self_improvement_log
self_improvement_review
self_improvement_extract_skill
self_improvement_distill
```

典型用途：

- 记录“下次不要再犯”的错误。
- 记录用户纠正和最佳实践。
- 在 bootstrap 时把稳定学习注入上下文。
- 从学习条目蒸馏项目规则。

---

## 迁移、备份与运维

### MEMORY.md 与 LanceDB 的关系

这个插件把 LanceDB 作为主要可检索记忆源：

- LanceDB 插件记忆：用于 semantic search、auto recall、tools、CLI。
- `MEMORY.md` / `memory/YYYY-MM-DD.md`：更适合作为启动上下文、日志或导入源。

如果已有 Markdown 记忆，建议导入：

```bash
openclaw mymem import-markdown /path/to/workspace --dry-run
openclaw mymem import-markdown /path/to/workspace --dedup
```

### 备份

使用 CLI 导出：

```bash
openclaw mymem export --output backup.json
```

也可以直接备份 `dbPath` 所在目录。不要把本地数据库、OAuth 文件、API key 或审计日志提交到 Git。

### 模型或维度变更

embedding 模型或维度变化后，旧向量通常不能继续混用。建议重嵌入到新 DB：

```bash
openclaw mymem reembed old-db new-db --dry-run
openclaw mymem reembed old-db new-db --batch-size 64
```

### 压缩旧记忆

启用自动 compaction：

```json
{
  "memoryCompaction": {
    "enabled": true,
    "minAgeDays": 14,
    "similarityThreshold": 0.88,
    "minClusterSize": 2,
    "maxMemoriesToScan": 200,
    "cooldownHours": 6
  }
}
```

或通过管理工具手动触发 `memory_compact`。

---

## 开发与测试

### 项目结构

```text
.
├── index.ts                         插件入口
├── cli.ts                           CLI
├── openclaw.plugin.json             插件 manifest 和配置 schema
├── src/
│   ├── store.ts                     LanceDB 存储
│   ├── retriever.ts                 检索
│   ├── embedder.ts                  embedding
│   ├── smart-extractor.ts           智能提取
│   ├── auto-capture-hook.ts         自动捕捉
│   ├── auto-recall-hook.ts          自动召回
│   ├── hook-enhancements.ts         Hook 级记忆增强闭环
│   ├── tools.ts                     Agent 工具
│   └── memory-doctor-tool.ts        诊断工具
├── test/                            回归测试
├── scripts/ci-test-manifest.mjs      CI 测试清单
└── scripts/run-ci-tests.mjs          CI runner
```

### 常用命令

```bash
npm run typecheck
npm test
npm run test:core-regression
npm run test:cli-smoke
npm run test:storage-and-schema
npm run test:llm-clients-and-auth
npm run test:packaging-and-workflow
node scripts/verify-ci-test-manifest.mjs
```

### 单测

```bash
node test/smart-extractor-branches.mjs
node --test test/memory-doctor.test.mjs
node --test test/query-expander.test.mjs
```

### TypeScript

仓库没有传统 build step；OpenClaw/Jiti 直接运行 TypeScript。`tsconfig.json` 用于 strict typecheck，不输出构建产物。

如果 TypeScript 行为异常，可清理 Jiti cache：

```bash
rm -rf node_modules/.cache/jiti
```

---

## 故障排查

### 插件加载失败：`Cannot find module 'openai'`

这表示插件源码已经被 OpenClaw 找到，但插件目录里的运行时依赖没有安装。请在运行 OpenClaw 的同一台机器或同一个容器中执行：

```bash
cd /root/.openclaw/workspace/plugins/mymem
npm ci --omit=dev
node -e "import('openai').then(() => console.log('openai ok'))"
openclaw gateway restart
```

如果没有 `package-lock.json`，把 `npm ci --omit=dev` 换成 `npm install --omit=dev`。后续如果又报 `@lancedb/lancedb`、`apache-arrow` 或 `@sinclair/typebox` 缺失，原因相同，重新安装依赖即可。

### `openclaw mymem version` 前出现插件日志

CLI 模式下注册日志应降级为 debug。如果仍出现，请检查是否由其他插件或 shell wrapper 输出。

### LanceDB 加载失败或 CPU 指令错误

- 确认平台可用的 `@lancedb/lancedb-*` optional dependency 已安装。
- x86 机器确认 CPU 支持 AVX/AVX2。
- 删除 `node_modules` 后重新安装依赖。

### 搜不到刚写入的记忆

检查：

```bash
openclaw mymem stats --json
openclaw mymem search "你的关键词" --debug --json
```

常见原因：

- scope 不可访问。
- `minScore` 或 `hardMinScore` 太高。
- 记忆被 `state`、`memory_layer`、`valid_until`、`invalidated_at` 过滤。
- auto-capture 还没 flush。
- embedding 维度与旧 DB 不一致。

### 自动召回注入太多

调低：

```json
{
  "autoRecallMaxItems": 3,
  "autoRecallMaxChars": 500,
  "autoRecallPerItemMaxChars": 120,
  "recallMode": "summary"
}
```

### 自动捕捉写入噪声

建议：

```json
{
  "admissionControl": {
    "enabled": true,
    "preset": "conservative"
  },
  "feedbackLoop": {
    "enabled": true,
    "noiseLearning": {
      "fromErrors": true,
      "fromRejections": true
    }
  }
}
```

如果文本包含 token、API key 或 private key，默认 `hookEnhancements.privacyGuard = true` 会直接跳过自动捕捉写入。若需要调试，可查看插件 warning 日志。

### 工具错误后反复踩同一个坑

默认 `hookEnhancements.toolErrorPlaybook = true` 会在工具失败后的下一轮 prompt 中召回相似历史错误。若没有出现 `<tool-error-playbook>`，检查：

- 是否有 `after_tool_call` 错误信号。
- 相似错误是否已经被写入 `.learnings/ERRORS.md`、reflection 或 LanceDB。
- 当前 agent 是否能访问对应 scope。

### 运行诊断

启用管理工具后，让智能体调用：

```text
请运行 memory_doctor，testEmbedding=true，并报告有哪些 memory 配置问题。
```

或使用 CLI：

```bash
openclaw mymem search "诊断关键词" --debug --json
openclaw mymem stats --json
```

---

## 安全与隐私

- 不要提交 API key、OAuth token、本地数据库、审计日志或生成的 memory store。
- 自动召回注入的历史记忆被标记为不可信数据，模型不应执行其中的指令。
- 危险工具提示是 advisory-only：它会提醒模型查看相关记忆，但不会拦截或确认工具调用。
- 隐私防护默认跳过疑似 secret 的自动捕捉内容，避免 token/API key 写入 LanceDB。
- 使用 scope 隔离不同项目、用户和智能体。
- 对敏感项目建议开启 workspace boundary 和更严格的 admission control。

---

## License

MIT
