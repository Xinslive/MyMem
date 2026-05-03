# MyMem 技术文档

> OpenClaw 增强型 LanceDB 长期记忆系统 — 技术设计与实现全景

---

## 目录

1. [项目概览](#1-项目概览)
2. [系统架构](#2-系统架构)
3. [记忆模型](#3-记忆模型)
4. [存储层设计](#4-存储层设计)
5. [Embedding 向量化系统](#5-embedding-向量化系统)
6. [混合检索引擎](#6-混合检索引擎)
7. [智能提取管线](#7-智能提取管线)
8. [衰减与生命周期管理](#8-衰减与生命周期管理)
9. [噪声过滤系统](#9-噪声过滤系统)
10. [反馈闭环与自我改进](#10-反馈闭环与自我改进)
11. [反思系统](#11-反思系统)
12. [记忆压缩与渐进式摘要](#12-记忆压缩与渐进式摘要)
13. [偏好蒸馏与经验编译](#13-偏好蒸馏与经验编译)
14. [多作用域隔离](#14-多作用域隔离)
15. [Hook 系统与自动捕获/召回](#15-hook-系统与自动捕获召回)
16. [工具层 API](#16-工具层-api)
17. [调优预设系统](#17-调优预设系统)
18. [CLI 命令行接口](#18-cli-命令行接口)
19. [并发控制与容错](#19-并发控制与容错)
20. [模块清单](#20-模块清单)

---

## 1. 项目概览

### 1.1 定位

MyMem 是一个面向 OpenClaw 个人助理的**长期记忆系统**。它不是一个简单的笔记本或聊天记录存储，而是一套完整的记忆工程闭环：

```
对话 → 自动捕获 → 智能提取 → 去重/准入 → 持久化 → 混合检索 → 上下文注入 → 反思沉淀 → 生命周期维护 → 自我改进
```

### 1.2 技术栈

| 层面 | 技术选型 |
|------|---------|
| 语言 | TypeScript (ESM, `"type": "module"`) |
| 向量数据库 | LanceDB (v0.27.2, 本地嵌入式) |
| Embedding API | OpenAI 兼容接口 (支持 Jina/OpenAI/Google/本地模型) |
| Rerank API | Jina / SiliconFlow / Voyage / Pinecone / DashScope / TEI |
| LLM API | OpenAI 兼容接口 (用于智能提取/反思/压缩) |
| 运行时 | Node.js + OpenClaw 插件系统 |
| 文件锁 | proper-lockfile (跨进程互斥) |
| CLI | commander.js |

### 1.3 项目结构

```
MyMem-main/
├── index.ts                 # 插件入口 (1154 行), 注册所有生命周期钩子
├── cli.ts                   # CLI 子命令 (openclaw mymem ...)
├── openclaw.plugin.json     # 插件清单 (配置 schema, 工具定义, Hook 定义)
├── src/
│   ├── store.ts             # LanceDB 存储层
│   ├── embedder.ts          # Embedding 抽象层
│   ├── retriever.ts         # 混合检索引擎
│   ├── smart-extractor.ts   # LLM 智能提取管线
│   ├── decay-engine.ts      # Weibull 衰减模型
│   ├── tier-manager.ts      # 三层记忆升降级
│   ├── noise-filter.ts      # 正则噪声过滤
│   ├── scopes.ts            # 多作用域访问控制
│   ├── tools.ts             # 工具注册总入口
│   └── ... (100+ 模块)
├── test/                    # 测试套件
├── scripts/                 # CI/版本同步脚本
└── benchmark/               # 性能基准
```

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        OpenClaw Host                             │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  Agent End    │  │ Agent Start  │  │  Tool Calls            │ │
│  │  Hook         │  │ Hook         │  │  (mymem_recall/store) │ │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬─────────────┘ │
│         │                 │                      │               │
│  ┌──────▼─────────────────▼──────────────────────▼─────────────┐ │
│  │                    MyMem Plugin (index.ts)                   │ │
│  │  ┌────────────┐ ┌─────────────┐ ┌────────────────────────┐ │ │
│  │  │ Auto-      │ │ Auto-       │ │  Tool Layer            │ │ │
│  │  │ Capture    │ │ Recall      │ │  (recall/store/forget/ │ │ │
│  │  │ Hook       │ │ Hook        │ │   update/management)   │ │ │
│  │  └─────┬──────┘ └──────┬──────┘ └───────────┬────────────┘ │ │
│  │        │               │                     │              │ │
│  │  ┌─────▼───────────────▼─────────────────────▼────────────┐ │ │
│  │  │              Core Engine Layer                          │ │ │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │ │ │
│  │  │  │ Smart        │  │ Memory       │  │ Memory       │ │ │ │
│  │  │  │ Extractor    │  │ Retriever    │  │ Store        │ │ │ │
│  │  │  │ (LLM提取)    │  │ (混合检索)   │  │ (LanceDB)    │ │ │ │
│  │  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘ │ │ │
│  │  │         │                 │                  │         │ │ │
│  │  │  ┌──────▼─────────────────▼──────────────────▼───────┐ │ │ │
│  │  │  │           Subsystems                                │ │ │ │
│  │  │  │  Embedder │ DecayEngine │ TierManager │ NoiseBank  │ │ │ │
│  │  │  │  Reranker │ RRF Fusion  │ MMR         │ Scopes     │ │ │ │
│  │  │  └───────────────────────────────────────────────────┘ │ │ │
│  │  └────────────────────────────────────────────────────────┘ │ │
│  │  ┌────────────────────────────────────────────────────────┐ │ │
│  │  │           Lifecycle & Maintenance                       │ │ │
│  │  │  Compactor │ LifecycleMaintainer │ PreferenceDistiller │ │ │
│  │  │  ExperienceCompiler │ ReflectionStore │ FeedbackLoop   │ │ │
│  │  └────────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心设计原则

1. **自动完成**：用户无需手动维护记忆，系统自动捕获、提取、检索、注入
2. **会演化**：记忆不是静态存储，会随时间衰减、升降级、合并、淘汰
3. **闭环学习**：用户纠正、工具失败、坏召回都会反馈回系统改进自身
4. **多层隔离**：作用域隔离、知识/经验分离、三层摘要粒度
5. **性能优先**：混合检索 + RRF 融合 + MMR 多样性 + 并发控制

---

## 3. 记忆模型

### 3.1 六类记忆分类

MyMem 使用 6 类记忆来组织个人助理的长期上下文（`src/memory-categories.ts`）：

| 类别 | 中文名 | 语义 | 写入策略 | 通道 |
|------|--------|------|---------|------|
| `profile` | 用户画像 | 身份信息、长期目标、生活方式 | 始终合并 (ALWAYS_MERGE) | knowledge |
| `preferences` | 偏好约束 | 沟通方式、饮食偏好、工具选择 | 支持 MERGE，时间版本化 | knowledge |
| `entities` | 关键实体 | 家人朋友、同事客户、项目设备 | 支持 MERGE，时间版本化 | knowledge |
| `events` | 事件轨迹 | 一次安排、一次沟通、一次旅行 | 仅追加 (APPEND_ONLY) | experience |
| `cases` | 具体案例 | 某次问题处理、某次任务完成 | 仅追加 (APPEND_ONLY) | experience |
| `patterns` | 可复用模式 | 反复有效的方法、避坑经验 | 支持 MERGE | knowledge |

```typescript
// src/memory-categories.ts
export const MEMORY_CATEGORIES = [
  "profile", "preferences", "entities", "events", "cases", "patterns"
] as const;

export const ALWAYS_MERGE_CATEGORIES = new Set<MemoryCategory>(["profile"]);
export const MERGE_SUPPORTED_CATEGORIES = new Set<MemoryCategory>(["preferences", "entities", "patterns"]);
export const TEMPORAL_VERSIONED_CATEGORIES = new Set<MemoryCategory>(["preferences", "entities"]);
export const APPEND_ONLY_CATEGORIES = new Set<MemoryCategory>(["events", "cases"]);
```

### 3.2 知识与经验解耦

参考论文 arxiv:2602.05665 §III-C, §V-E，MyMem 将记忆分为两条逻辑通道：

- **knowledge（知识）**：`profile` + `preferences` + `entities` + `patterns` — 相对稳定、可验证的参考数据
- **experience（经验）**：`events` + `cases` — 交互轨迹和结果日志

这种分离在检索时体现为**通道提升**：问偏好时优先找稳定知识，问"上次""之前"时优先找经验轨迹。在衰减时也区别对待：知识半衰期乘数 3.0（衰减更慢），经验半衰期乘数 0.7（衰减更快）。

### 3.3 三层摘要结构 (L0/L1/L2)

每条智能记忆都带有三层表达（`src/smart-metadata.ts` 中的 `SmartMemoryMetadata`）：

| 层级 | 字段 | 用途 |
|------|------|------|
| L0 | `l0_abstract` | 一句话索引，用于快速检索、去重和低成本召回 |
| L1 | `l1_overview` | 结构化概览，用于回答"这条记忆大概是什么" |
| L2 | `l2_content` | 完整叙事，用于需要细节、来源和上下文时展开 |

### 3.4 完整元数据结构

```typescript
interface SmartMemoryMetadata {
  // 三层摘要
  l0_abstract: string;
  l1_overview: string;
  l2_content: string;

  // 分类与层级
  memory_category: MemoryCategory;  // 6 类分类
  memory_type: MemoryType;          // "knowledge" | "experience"
  tier: MemoryTier;                 // "core" | "working" | "peripheral"
  memory_layer: MemoryLayer;        // "durable" | "working" | "reflection" | "archive"

  // 生命周期信号
  access_count: number;
  confidence: number;
  last_accessed_at: number;
  valid_from: number;
  invalidated_at?: number;
  memory_temporal_type?: "static" | "dynamic";
  valid_until?: number;

  // 关系与溯源
  fact_key?: string;
  supersedes?: string;
  superseded_by?: string;
  relations?: MemoryRelation[];
  source_session?: string;
  canonical_id?: string;

  // 治理
  state: MemoryState;              // "pending" | "confirmed" | "archived"
  source: MemorySource;            // "manual" | "auto-capture" | "reflection" | ...
  injected_count: number;
  last_injected_at?: number;
  last_confirmed_use_at?: number;
  bad_recall_count: number;
  suppressed_until_turn: number;
}
```

### 3.5 OpenClaw 兼容层

OpenClaw 工具参数中的 `category` 是旧版兼容分类，MyMem 在写入时保留顶层 `category` 以兼容，同时在 `metadata` 里写入真正的 `memory_category`：

| 内部分类 | → 工具层 category |
|---------|------------------|
| profile | fact |
| preferences | preference |
| entities | entity |
| events | decision |
| cases | fact |
| patterns | other |

---

## 4. 存储层设计

### 4.1 LanceDB 存储引擎

存储层核心是 `MemoryStore` 类（`src/store.ts`），基于 LanceDB 嵌入式向量数据库：

```typescript
class MemoryStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private ftsIndexCreated = false;
  private vectorIndexCreated = false;
  private scalarIndexedColumns = new Set<string>();

  // 批量写入缓冲
  private _batchBuffer: MemoryEntry[] = [];
  private _batchActive = false;

  // 进程序列化链 (Issue #598)
  private _serialChain: Promise<void> = Promise.resolve();
}
```

### 4.2 MemoryEntry 数据模型

```typescript
interface MemoryEntry {
  id: string;           // UUID
  text: string;         // 记忆全文
  vector: number[];     // 向量嵌入
  category: string;     // 兼容层 category
  scope: string;        // 作用域
  importance: number;   // 重要性 0-1
  timestamp: number;    // 创建时间戳
  metadata: string;     // JSON 序列化的 SmartMemoryMetadata
}
```

### 4.3 索引策略

存储层维护三种索引：

1. **向量索引 (Vector Index)**：用于语义相似度检索，支持 IVF-PQ 分区
2. **全文索引 (FTS Index)**：用于 BM25 关键词检索
3. **标量索引 (Scalar Index)**：用于 `scope`、`category` 等字段的快速过滤

```typescript
// 推荐的向量分区数（根据数据量自动计算，取最近的 2 的幂次）
export function recommendedVectorPartitions(totalRows: number): number {
  const sqrt = Math.sqrt(Math.max(totalRows, 1));
  const rough = Math.max(8, Math.min(256, Math.round(sqrt)));
  return Math.max(8, Math.pow(2, Math.round(Math.log2(rough))));
}
```

先取平方根，钳位到 [8, 256]，再取最近的 2 的幂次（LanceDB IVF-PQ 分区要求为 2 的幂）。

### 4.4 跨进程并发控制

MyMem 使用 `proper-lockfile` 实现跨进程文件锁，确保多个 OpenClaw 实例不会同时写入同一个数据库：

```typescript
// 进程序列化：通过 Promise 链实现进程内串行
private _serialChain: Promise<void> = Promise.resolve();

async runSerializedUpdate(fn: () => Promise<void>): Promise<void> {
  this._serialChain = this._serialChain.then(fn, fn);
  return this._serialChain;
}
```

同时，LanceDB 的 `mergeInsert` 操作提供原子性 upsert，避免了旧版 delete+add 的竞态问题。

### 4.5 批量写入优化

存储层支持批量缓冲模式：当 `_batchActive` 为 true 时，`store()` 调用会被缓冲到 `_batchBuffer` 中，在批量结束时一次性写入，减少锁获取次数。

---

## 5. Embedding 向量化系统

### 5.1 多 Provider 支持

Embedding 层（`src/embedder.ts`）抽象了 OpenAI 兼容的 Embedding API，支持：

- **OpenAI**：text-embedding-3-small/large
- **Jina**：jina-embeddings-v5 系列（支持 task/query/passage 区分和 normalized 输出）
- **Google**：text-embedding-004, gemini-embedding-001
- **本地模型**：nomic-embed-text, all-MiniLM-L6-v2 等
- **Azure OpenAI**

### 5.2 多密钥轮转与故障转移

```typescript
interface EmbeddingConfig {
  apiKey: string | string[];  // 单密钥或密钥数组（轮转 + 故障转移）
  // ...
}
```

当配置多个 API Key 时，Embedder 使用 round-robin 轮转策略，遇到认证错误时自动切换到下一个密钥。

### 5.3 自动分块

当文档超过 Embedding 模型的上下文限制时，系统自动触发分块（`src/chunker.ts`）：

```typescript
interface ChunkerConfig {
  maxChunkSize: number;    // 每块最大字符数
  overlapSize: number;     // 块间重叠字符数
  minChunkSize: number;    // 最小块大小
  semanticSplit: boolean;  // 是否在句子边界分割
  maxLinesPerChunk: number; // 每块最大行数
}
```

分块策略优先在语义边界（句子、段落）处分割，避免截断语义完整性。分块后的向量取均值作为文档的整体向量。

### 5.4 并发控制与缓存

```typescript
// 全局并发限制：所有 Embedder 实例共享
const GLOBAL_EMBED_CONCURRENCY_LIMIT = 10;
const EMBED_TIMEOUT_MS = 20_000;  // 20 秒超时
```

Embedding 结果通过 LRU 缓存（`src/embedding-cache.ts`）避免重复计算，默认 256 条目、30 分钟 TTL。

### 5.5 Provider 自动检测

系统自动检测 Embedding Provider 的特性（`src/embedding-provider.ts`），包括是否支持 task 参数、是否需要 normalized 输出、是否为本地回环服务等，据此调整请求参数。

---

## 6. 混合检索引擎

### 6.1 检索管线总览

MyMem 的检索不是简单向量搜索，而是一条完整的检索链路。意图分析在自动召回 Hook（`src/auto-recall-hook.ts`）中完成，检索引擎（`src/retriever.ts`）负责后续的融合与排序：

```
用户消息 → 意图分析 (auto-recall-hook) → 查询扩展 → [向量检索 ∥ BM25检索] → RRF 融合 → 时间增强 → 重要性加权 → 衰减增强 → 长度归一化 → 时间衰减 → 重排序 → MMR 多样性过滤 → 结果输出
```

### 6.2 向量检索 (Vector Search)

使用 LanceDB 的向量索引进行语义相似度检索，返回 top-K 候选。

### 6.3 BM25 全文检索

使用 LanceDB 的全文索引（FTS）进行关键词匹配。BM25 的优势在于精确关键词匹配，尤其适合中英文混合查询。

### 6.4 查询扩展 (Query Expansion)

`src/query-expander.ts` 实现了轻量级的中英文同义词扩展，专门为 BM25 检索增强召回：

```typescript
// 示例：查询"挂了"会扩展为"崩溃, crash, error, 报错, 宕机, 失败"
const SYNONYM_MAP: SynonymEntry[] = [
  { cn: ["挂了", "挂掉", "宕机"], en: ["shutdown", "crashed"],
    expansions: ["崩溃", "crash", "error", "报错", "宕机", "失败"] },
  // ... 更多映射
];
```

### 6.5 RRF 融合 (Reciprocal Rank Fusion)

`src/rrf-fusion.ts` 实现经典的 RRF 算法（Cormack et al., 2009），将向量检索和 BM25 检索的结果融合：

```
RRF_score = Σ weight_i / (k + rank_i)
```

其中 `k = 60`（论文标准常数），`weight_i` 为各通道权重。

关键设计：
- **BM25 幽灵条目过滤**：BM25-only 结果可能因 FTS 索引滞后而包含已删除条目，系统通过 `hasIds` 批量检查过滤
- **BM25 高分保护**：BM25 原始分数 ≥ 0.75 时，设置 0.92 倍的分数下限，保护精确关键词匹配
- **归一化**：RRF 原始分数极小（如 rank 1 时仅 0.016），系统相对于本批次最高分归一化到 [0, 1]

```typescript
const RRF_K = 60;
const vectorRRF = vectorResult ? config.vectorWeight / (RRF_K + vectorResult.rank) : 0;
const bm25RRF = bm25Result ? config.bm25Weight / (RRF_K + bm25Result.rank) : 0;
const rrfRaw = vectorRRF + bm25RRF;
```

### 6.6 时间增强函数

`src/temporal-scoring.ts` 提供多个后处理函数：

**Recency Boost（新近性加成）**：
```
boost = exp(-ageDays / halfLife) * weight
```
确保修正/更新自然排在旧条目之前。

**Importance Weight（重要性加权）**：
```
score *= (baseWeight + (1 - baseWeight) * importance)
```
`baseWeight=0.7` 时：importance=1.0 → ×1.0, importance=0.5 → ×0.85。

**Time Decay（时间衰减）**：
基于 DecayEngine 的 Weibull 模型对分数进行衰减调整。

**Reinforcement Boost（访问强化）**：
被反复访问的记忆获得半衰期延长，越用越不容易被遗忘。

### 6.7 重排序 (Reranking)

`src/reranker.ts` 支持多种重排序 Provider：

| Provider | 用途 |
|----------|------|
| Jina | 通用 cross-encoder 重排序 |
| SiliconFlow | 国内 cross-encoder 服务 |
| Voyage | 高质量重排序 |
| Pinecone | 托管重排序 |
| DashScope | 阿里云重排序 |
| TEI | Text Embeddings Inference (自托管) |

重排序使用 cross-encoder 模型对候选进行二次排序，精度远高于向量余弦相似度，但延迟更高，因此只对候选池（默认 12 条）进行重排。

### 6.8 MMR 多样性过滤

`src/mmr-diversity.ts` 实现 MMR (Maximal Marginal Relevance) 启发式多样性过滤：

```typescript
function applyMMRDiversity(
  results: RetrievalResult[],
  similarityThreshold = 0.85  // 余弦相似度阈值
): RetrievalResult[]
```

算法流程：
1. 贪心遍历候选结果
2. 对每个候选，检查是否与已选集合中的任何结果余弦相似度 > 阈值
3. 如果过于相似，推迟到末尾（而非删除，保持可用性）
4. 预转换 Arrow Vector 为普通数组，避免重复 `Array.from()` 调用

### 6.9 意图分析 (Intent Analysis)

`src/intent-analyzer.ts` 实现基于规则的轻量级意图分析，无需 LLM 调用：

```typescript
// 意图规则按特异性排序，首匹配优先
const INTENT_RULES: IntentRule[] = [
  { label: "preference", patterns: [...], categories: ["preference", "decision"],
    depth: "l0", memoryType: "knowledge" },
  { label: "event-timeline", patterns: [...], categories: ["entity", "decision"],
    depth: "full", memoryType: "experience" },
  // ... 更多规则
];
```

意图分析结果用于：
- **类别提升**：优先检索与意图匹配的记忆类别
- **通道提升**：knowledge 或 experience 通道加权
- **召回深度**：L0（仅摘要）/ L1（概览）/ full（全文）

---

## 7. 智能提取管线

### 7.1 管线概览

`SmartExtractor`（`src/smart-extractor.ts`）是 MyMem 的核心提取引擎：

```
对话文本 → 包络剥离 → 会话压缩 → LLM 提取 → 候选记忆 → 批量去重 → 嵌入 → 逐条去重/合并 → 准入控制 → 持久化
```

### 7.2 包络剥离 (Envelope Stripping)

`src/envelope-stripping.ts` 移除对话中的元数据信封（如 Discord 频道头部、外部内容标记），只保留有价值的对话内容。

### 7.3 会话压缩 (Session Compression)

`src/session-compressor.ts` 在提取前对对话文本进行价值评分和压缩：

```typescript
// 评分信号
const TOOL_CALL_INDICATORS = [/\btool_use\b/i, /\bfunction_call\b/i, ...];
const CORRECTION_INDICATORS = [/\bactually\b/i, /\bwrong\b/i, /不对/, ...];
const DECISION_INDICATORS = [/\bdecided\b/i, /\blet's go with\b/i, ...];
const BOILERPLATE_INDICATORS = [/\bthanks?\b/i, /\bok\b/i, /^hi\b/i, ...];
```

高信号内容（工具调用、纠正、决策）优先保留，低信号内容（问候、确认）优先丢弃。

### 7.4 LLM 提取

使用 LLM 从对话中提取候选记忆，每个候选包含：

```typescript
type CandidateMemory = {
  category: MemoryCategory;  // 6 类分类
  abstract: string;           // L0: 一句话索引
  overview: string;           // L1: 结构化概览
  content: string;            // L2: 完整叙事
};
```

单次提取上限 `MAX_MEMORIES_PER_EXTRACTION = 5`。

### 7.5 批量去重 (Batch Dedup)

`src/batch-dedup.ts` 在运行昂贵的逐条 LLM 去重之前，先用余弦相似度做批量内部去重：

```typescript
function batchDedup(
  abstracts: string[],
  vectors: number[][],
  threshold = 0.85
): BatchDedupResult
```

对于 n ≤ 5 的小批量，O(n²) 逐对比较开销可忽略。

### 7.6 逐条去重决策

`src/smart-extractor-dedup.ts` 对每个存活候选执行 LLM 去重决策：

```typescript
type DedupDecision =
  | "create"        // 创建新记忆
  | "merge"         // 与已有记忆合并
  | "skip"          // 跳过（重复）
  | "support"       // 为已有记忆添加支持证据
  | "contextualize" // 为已有记忆添加上下文
  | "contradict"    // 标记与已有记忆矛盾
  | "supersede";    // 替换已有记忆
```

不同类别的去重策略不同：
- `profile`：始终合并，不走去重
- `preferences` / `entities`：支持 supersede（时间版本化替换）
- `events` / `cases`：仅 create 或 skip（追加式）
- `patterns`：支持 merge

### 7.7 准入控制 (Admission Control)

`src/admission-control.ts` 在去重之后、持久化之前，对候选进行准入评分：

```typescript
interface AdmissionWeights {
  utility: number;     // 工具性（对未来查询的潜在价值）
  confidence: number;  // 置信度
  novelty: number;     // 新颖性（与已有记忆的差异度）
  recency: number;     // 新近性
  typePrior: number;   // 类别先验
}
```

准入控制有三个预设：`balanced`、`conservative`、`high-recall`。

### 7.8 速率限制

`src/extraction-rate-limiter.ts` 限制提取频率，防止在高频对话中过度提取：

```typescript
interface ExtractionRateLimiterOptions {
  maxExtractionsPerHour?: number;
  skipLowValue?: boolean;
}
```

---

## 8. 衰减与生命周期管理

### 8.1 Weibull 衰减模型

`src/decay-engine.ts` 实现基于 Weibull 拉伸指数衰减的复合评分：

```
composite = recencyWeight × recency + frequencyWeight × frequency + intrinsicWeight × intrinsic
```

**Recency（新近性衰减）**：
```
recency = exp(-(t/λ)^β)
```
其中 λ = halfLife × importanceModulation^importance，β 为 tier 特异性参数。

**Weibull β 参数的物理含义**：

| Tier | β 值 | 衰减特性 | 衰减下限 |
|------|------|---------|---------|
| Core | 0.8 | 亚指数衰减（最慢） | 0.9 |
| Working | 1.0 | 标准指数衰减 | 0.7 |
| Peripheral | 1.3 | 超指数衰减（最快） | 0.5 |

**Frequency（访问频率）**：
```
frequency = log(1 + accessCount) / log(1 + maxAccessCount)
```
对数饱和，避免高频访问无限放大。

**Intrinsic（内在价值）**：
```
intrinsic = importance × confidence
```

**知识/经验解耦**：
- knowledge 半衰期乘数：3.0（衰减慢 3 倍）
- experience 半衰期乘数：0.7（衰减快 1.4 倍）

### 8.2 三层记忆层级 (Tier Manager)

`src/tier-manager.ts` 管理记忆的升降级：

```
Peripheral ──(access ≥ 3, composite ≥ 0.4)──→ Working ──(access ≥ 10, composite ≥ 0.7, importance ≥ 0.8)──→ Core
```

反向降级：
```
Core ──(composite < 0.15)──→ Peripheral
Working ──(age > 60 days, low access)──→ Peripheral
```

### 8.3 四层记忆层 (Layer)

| 层 | 用途 |
|----|------|
| `durable` | 核心长期记忆，几乎不被清除 |
| `working` | 活跃工作上下文 |
| `reflection` | 会话反思沉淀 |
| `archive` | 过时或低价值内容 |

### 8.4 生命周期维护

`src/lifecycle-maintainer.ts` 定期执行：

1. **衰减评分**：计算所有记忆的 composite score
2. **层级转换**：根据评分执行 promote/demote
3. **过期清理**：删除/归档过期记忆（expired, superseded, bad_recall, stale_unaccessed）
4. **治理规则**：`src/governance-rules.ts` 从记忆中推断治理规则，检测规则冲突

---

## 9. 噪声过滤系统

### 9.1 双层噪声检测

MyMem 使用静态噪声过滤：

**正则噪声过滤**（`src/noise-filter.ts`）

```typescript
// 四类噪声模式
const DENIAL_PATTERNS = [...];      // Agent 否认（"I don't recall"）
const META_QUESTION_PATTERNS = [...]; // 元问题（"你还记得吗"）
const BOILERPLATE_PATTERNS = [...];   // 会话模板（"Hello"）
const DIAGNOSTIC_ARTIFACT_PATTERNS = [...]; // 诊断产物
```

提取是否写入记忆由 LLM 和准入控制判断；系统不再维护会自我学习的向量噪声原型库。

### 9.2 噪声过滤边界

`src/noise-filter.ts` 只处理明显模板噪声；非模板内容是否值得记忆交给 LLM 提取和 admission-control 治理。

---

## 10. 反馈闭环与自我改进

### 10.1 双循环反馈

`src/feedback-loop.ts` 实现两个反馈循环：

**循环 1：预防教训**
- 来源：工具错误 + 用户修正 + 错误文件
- 动作：将反复出现的问题证据更新到 preventive lesson 记忆

**循环 2：先验适应**
- 来源：准入控制的拒绝率统计
- 动作：调整 `AdmissionTypePriors`（各类别的准入先验）
- 配置：10 分钟适应间隔，学习率 0.1，最大调整幅度 0.15

### 10.2 自我改进学习文件

`src/self-improvement-files.ts` 维护持久化的学习文件，记录：

- 用户纠正（"不对，应该是..."）
- 工具失败（错误信号和签名）
- 成功案例
- 坏召回反馈

这些学习文件在新会话启动时注入为上下文，帮助 Agent 避免重复犯错。

### 10.3 Hook 增强系统

`src/hook-enhancements.ts` 提供多种软干预增强：

| 增强 | 功能 |
|------|------|
| `badRecallFeedback` | 追踪被忽略的召回记忆，更新 bad_recall_count |
| `correctionDiff` | 检测用户纠正，生成差异信号 |
| `toolErrorPlaybook` | 从历史错误中提取工具使用模式 |
| `dangerousToolHints` | 对危险工具操作注入安全提示 |
| `contextBudget` | 控制注入上下文的总字符预算 |
| `privacyGuard` | 检测敏感信息泄露风险 |
| `sessionPrimer` | 新会话启动时注入用户偏好和约束 |
| `selfCorrectionLoop` | 自纠正循环，抑制低置信度重复行为 |
| `workspaceDrift` | 检测工作区内容与记忆之间的漂移 |
| `stalenessConfirmation` | 对陈旧记忆注入时提示 Agent 确认时效性 |

---

## 11. 反思系统

### 11.1 反思管线

会话结束时，MyMem 执行反思沉淀（`src/reflection-hook.ts` + `src/reflection-store.ts`）：

```
会话结束 → 读取对话 → 构建反思 Prompt → LLM 生成反思 → 切片 → 存储到 LanceDB
```

### 11.2 反思切片

`src/reflection-slices.ts` 将反思文本切分为两种切片：

- **Invariants（不变量）**：用户身份、核心偏好、长期约束（衰减慢）
- **Derived（派生）**：本次会话的具体经验（衰减快，~14 天）

### 11.3 反思存储

反思结果以多种格式存储到 LanceDB：

- `event`：反思事件记录（时间、会话、Agent、工具错误信号）
- `item-invariant`：不变量切片条目
- `item-derived`：派生切片条目
- `combined-legacy`：兼容旧版的合并格式

### 11.4 反思注入

新会话启动时，反思记忆通过 `inheritance-only` 或 `inheritance+derived` 模式注入上下文，为 Agent 提供上一次会话的学习成果。

---

## 12. 记忆压缩与渐进式摘要

### 12.1 记忆压缩器 (Memory Compactor)

`src/memory-compactor.ts` 实现"渐进式摘要"模式：

```
旧记忆聚类 → 余弦相似度分组 → 合并为更高质量的单条记忆 → 删除源记忆
```

算法步骤：
1. 加载超过 `minAgeDays`（默认 7 天）的记忆（含向量）
2. 使用贪心余弦相似度扩展构建聚类
3. 对每个 ≥ `minClusterSize`（默认 2）的聚类执行合并：
   - text：去重行拼接
   - importance：取最大值（永不降级）
   - category：多数投票
   - scope：必须共享同一 scope
   - metadata：标记 `{ compacted: true, sourceCount: N }`
4. 删除源记忆，存储合并记忆

### 12.2 合并模式

- **deterministic**：确定性合并（拼接去重行），速度快
- **llm**：LLM 精炼合并（生成更高质量的摘要），质量更高但成本更大

每次运行最多 `maxLlmClustersPerRun`（默认 10）个聚类使用 LLM 合并。

---

## 13. 偏好蒸馏与经验编译

### 13.1 偏好蒸馏器 (Preference Distiller)

`src/preference-distiller.ts` 从历史会话中提取稳定的用户偏好规则：

```
扫描最近 N 个会话 → 提取治理规则 → 聚合证据 → 评估稳定性 → 创建/更新偏好记忆
```

关键指标：
- `minEvidenceCount`：最少 2 次独立证据
- `minStabilityScore`：最低稳定性分数 0.6
- `maxRulesPerRun`：每次最多蒸馏 5 条规则

### 13.2 经验编译器 (Experience Compiler)

`src/experience-compiler.ts` 将重复成功的经验编译为可复用策略：

```
扫描事件/案例记忆 → 识别任务闭合信号 → 提取可复用步骤 → 生成 pattern 记忆
```

这实现了从 experience（事件/案例）到 patterns（可复用模式）的自动升级。

---

## 14. 多作用域隔离

### 14.1 作用域系统

`src/scopes.ts` 实现多作用域访问控制：

```typescript
// 内置作用域模式
const SCOPE_PATTERNS = {
  GLOBAL: "global",
  AGENT: (agentId) => `agent:${agentId}`,
  CUSTOM: (name) => `custom:${name}`,
  REFLECTION: (agentId) => `reflection:agent:${agentId}`,
  PROJECT: (projectId) => `project:${projectId}`,
  USER: (userId) => `user:${userId}`,
};
```

### 14.2 访问控制

- 每个 Agent 只能访问自己有权限的作用域
- `system` 和 `undefined` 是系统绕过 ID，可以访问所有作用域
- 作用域过滤在 Store 层的 SQL WHERE 子句中实现

### 14.3 Clawteam 作用域

`src/clawteam-scope.ts` 支持团队协作场景下的作用域解析和应用。

---

## 15. Hook 系统与自动捕获/召回

### 15.1 自动捕获 (Auto-Capture)

`src/auto-capture-hook.ts` 注册 `agent_end` 事件钩子：

```
Agent 会话结束 → 提取消息 → 噪声过滤 → 速率限制检查 → SmartExtractor 提取 → 持久化
```

关键配置：
- `autoCapture`：是否启用（默认 true）
- `captureAssistant`：是否捕获 Assistant 消息（默认 false）
- `extractionThrottle.maxExtractionsPerHour`：每小时最大提取次数

### 15.2 自动召回 (Auto-Recall)

`src/auto-recall-hook.ts` 注册 `agent_start` 事件钩子：

```
Agent 会话开始 → 分析用户消息 → 意图识别 → 混合检索 → 准入过滤 → 上下文注入
```

关键配置：
- `autoRecall`：是否启用（默认 true）
- `autoRecallMinLength`：触发召回的最小消息长度
- `autoRecallMaxItems`：单次最大注入条目数
- `autoRecallMaxChars`：注入总字符上限
- `autoRecallTimeoutMs`：召回超时（默认 20 秒）

### 15.3 Hook 去重

`src/hook-dedup.ts` 使用 TTL-based Map 防止同一事件被重复处理。

---

## 16. 工具层 API

### 16.1 核心工具

| 工具 | 文件 | 功能 |
|------|------|------|
| `mymem_recall` | `tools-recall.ts` | 混合检索记忆 |
| `mymem_store` | `tools-store.ts` | 存储新记忆 |
| `mymem_forget` | `tools-forget.ts` | 删除/归档记忆 |
| `mymem_update` | `tools-update.ts` | 更新已有记忆 |

### 16.2 管理工具

| 工具 | 文件 | 功能 |
|------|------|------|
| `mymem_stats` | `tools-management.ts` | 记忆库统计 |
| `mymem_doctor` | `memory-doctor-tool.ts` | 诊断记忆健康状态（索引、配置、存储） |
| `mymem_debug` | `tools-management.ts` | 调试信息 |
| `mymem_list` | `tools-management.ts` | 列出记忆 |
| `mymem_promote` | `tools-management.ts` | 手动升级记忆 |
| `mymem_archive` | `tools-management.ts` | 手动归档记忆 |
| `mymem_compact` | `tools-management.ts` | 触发手动压缩 |
| `mymem_explain_rank` | `tools-management.ts` | 解释检索排名 |

### 16.3 自我改进工具

| 工具 | 文件 | 功能 |
|------|------|------|
| `self_improvement_log` | `tools-self-improvement.ts` | 记录学习条目 |
| `self_improvement_extract_skill` | `tools-self-improvement.ts` | 从学习中提取技能 |
| `self_improvement_review` | `tools-self-improvement.ts` | 审阅学习记录 |
| `self_improvement_distill` | `tools-self-improvement.ts` | 蒸馏学习结论 |

注：`self_improvement_log` 始终启用；后三个工具随 `enableManagementTools` 启用（默认 `true`）。

### 16.4 工具 schema 验证

所有工具参数使用 `@sinclair/typebox` 进行运行时类型验证。

---

## 17. 调优预设系统

### 17.1 四种预设

`src/tuning-presets.ts` 提供四种开箱即用的调优预设：

| 预设 | 特点 | 适用场景 |
|------|------|---------|
| `balanced` | 向量 0.7 + BM25 0.3, cross-encoder rerank | 默认，通用场景 |
| `low-latency` | 无 rerank, 小候选池, 确定性合并 | 延迟敏感场景 |
| `high-recall` | BM25 权重更高, 大候选池, 低分数阈值 | 不想遗漏任何相关记忆 |
| `high-precision` | 高分数阈值, 严格准入 | 只想要最精确的结果 |

### 17.2 预设覆盖机制

```typescript
function applyTuningPreset(
  rawConfig: Record<string, unknown>,
  preset: TuningPreset
): Record<string, unknown> {
  const overlay = PRESET_OVERLAYS[preset];
  const merged = { ...overlay, ...rawConfig };
  // 对象类型深度合并
  for (const key of PRESET_OBJECT_KEYS) {
    merged[key] = { ...overlay[key], ...rawConfig[key] };
  }
  return merged;
}
```

用户配置始终优先于预设默认值。

---

## 18. CLI 命令行接口

### 18.1 命令结构

`cli.ts` 提供 `openclaw mymem <command>` 子命令：

```
openclaw mymem stats          # 显示记忆库统计
openclaw mymem list           # 列出所有记忆
openclaw mymem search <query> # 搜索记忆
openclaw mymem forget <id>    # 删除记忆
openclaw mymem compact        # 触发手动压缩
openclaw mymem doctor         # 诊断记忆健康状态
openclaw mymem migrate        # 数据迁移
```

### 18.2 测试框架

测试使用 Node.js 内置测试运行器 + `jiti`（无需预编译即可导入 .ts 文件）：

```bash
npm test                        # 全部测试
npm run test:cli-smoke          # CLI 冒烟测试
npm run test:core-regression    # 核心回归测试
npm run test:storage-and-schema # 存储和 schema 测试
npm run test:llm-clients-and-auth # LLM 客户端测试
```

---

## 19. 并发控制与容错

### 19.1 全局并发限制

```typescript
// src/concurrency-limiter.ts
const GLOBAL_EMBED_CONCURRENCY_LIMIT = 10;  // 全局 Embedding 并发
const EMBED_TIMEOUT_MS = 20_000;             // Embedding 超时
```

### 19.2 文件锁

```typescript
// src/store.ts
// proper-lockfile 跨进程互斥
// 进程内通过 Promise 链串行
```

### 19.3 健康检查

启动时延迟 15 秒执行健康检查，30 秒超时：
- 测试 Embedder 连通性
- 验证 LanceDB 可访问性
- 检查 LLM API 可用性

### 19.4 反思瞬态重试

`src/reflection-retry.ts` 封装反思操作的瞬态错误重试，处理网络抖动和 API 限流。

### 19.5 会话恢复

`src/session-recovery.ts` + `src/session-recovery-utils.ts` 在会话中断后恢复对话内容，确保反思不会因中断而丢失。

---

## 20. 模块清单

### 20.1 核心模块

| 模块 | 功能 |
|------|------|
| `store.ts` | LanceDB 存储层，多作用域，文件锁，批量写入 |
| `embedder.ts` | Embedding 抽象层，多 Provider，自动分块，缓存 |
| `retriever.ts` | 混合检索引擎，RRF 融合，重排序，多样性过滤 |
| `smart-extractor.ts` | LLM 智能提取管线，6 类分类，去重/合并 |
| `decay-engine.ts` | Weibull 衰减模型，知识/经验解耦 |
| `tier-manager.ts` | 三层记忆升降级管理 |
| `scopes.ts` | 多作用域访问控制系统 |

### 20.2 检索子模块

| 模块 | 功能 |
|------|------|
| `rrf-fusion.ts` | RRF 分数融合 |
| `reranker.ts` | 多 Provider 重排序适配 |
| `temporal-scoring.ts` | 时间增强、重要性加权 |
| `mmr-diversity.ts` | MMR 多样性过滤 |
| `intent-analyzer.ts` | 规则式意图分析 |
| `query-expander.ts` | 中英文同义词扩展 |
| `adaptive-retrieval.ts` | 自适应检索策略 |

### 20.3 提取子模块

| 模块 | 功能 |
|------|------|
| `envelope-stripping.ts` | 信封元数据剥离 |
| `session-compressor.ts` | 会话价值评分与压缩 |
| `batch-dedup.ts` | 批量内部余弦去重 |
| `smart-extractor-dedup.ts` | LLM 逐条去重决策 |
| `smart-extractor-handlers.ts` | 去重决策执行器 |
| `extraction-prompts.ts` | 提取 Prompt 构建 |
| `extraction-rate-limiter.ts` | 提取速率限制 |

### 20.4 噪声与过滤

| 模块 | 功能 |
|------|------|
| `noise-filter.ts` | 正则噪声模式检测 |
| `capture-detector.ts` | 捕获决策检测 |
| `capture-detection.ts` | 捕获信号分析 |

### 20.5 生命周期

| 模块 | 功能 |
|------|------|
| `lifecycle-maintainer.ts` | 生命周期维护（升降级、清理） |
| `memory-compactor.ts` | 渐进式摘要压缩 |
| `preference-distiller.ts` | 偏好蒸馏器 |
| `experience-compiler.ts` | 经验编译器 |
| `memory-upgrader.ts` | 记忆格式升级 |
| `governance-rules.ts` | 治理规则推断与冲突检测 |

### 20.6 反思系统

| 模块 | 功能 |
|------|------|
| `reflection-store.ts` | 反思存储到 LanceDB |
| `reflection-slices.ts` | 反思切片（invariant/derived） |
| `reflection-event-store.ts` | 反思事件存储 |
| `reflection-item-store.ts` | 反思条目存储 |
| `reflection-ranking.ts` | 反思排名评分 |
| `reflection-metadata.ts` | 反思元数据解析 |
| `reflection-hook.ts` | 反思 Hook 注册 |

### 20.7 反馈与改进

| 模块 | 功能 |
|------|------|
| `feedback-loop.ts` | 双循环反馈（预防教训 + 先验适应） |
| `self-improvement-hook.ts` | 自我改进 Hook |
| `self-improvement-files.ts` | 学习文件持久化 |
| `hook-enhancements.ts` | Hook 级增强（10 种软干预） |
| `hook-dedup.ts` | Hook 事件去重 |

### 20.8 基础设施

| 模块 | 功能 |
|------|------|
| `config-utils.ts` | 配置解析，环境变量解析 |
| `plugin-config-parser.ts` | 插件配置解析 |
| `plugin-singleton.ts` | 插件单例状态管理 |
| `path-utils.ts` | 路径工具 |
| `file-utils.ts` | 文件工具 |
| `session-utils.ts` | 会话工具（密钥脱敏、消息摘要） |
| `workspace-utils.ts` | 工作区工具 |
| `workspace-boundary.ts` | 工作区边界控制 |
| `cli-utils.ts` | CLI 工具（超时、JSON 解析） |
| `logger.ts` | 结构化日志 |
| `utils.ts` | 通用工具（余弦相似度、clamp 等） |
| `version-utils.ts` | 版本同步 |
| `telemetry.ts` | 遥测存储 |

---

## 附录 A：默认配置参数

```typescript
// 衰减引擎
{
  recencyHalfLifeDays: 30,
  recencyWeight: 0.4,
  frequencyWeight: 0.3,
  intrinsicWeight: 0.3,
  staleThreshold: 0.3,
  importanceModulation: 1.5,
  betaCore: 0.8,
  betaWorking: 1.0,
  betaPeripheral: 1.3,
  coreDecayFloor: 0.9,
  workingDecayFloor: 0.7,
  peripheralDecayFloor: 0.5,
  knowledgeHalfLifeMultiplier: 3.0,
  experienceHalfLifeMultiplier: 0.7,
}

// 层级管理
{
  coreAccessThreshold: 10,
  coreCompositeThreshold: 0.7,
  coreImportanceThreshold: 0.8,
  peripheralCompositeThreshold: 0.15,
  peripheralAgeDays: 60,
  workingAccessThreshold: 3,
  workingCompositeThreshold: 0.4,
}

// 检索 (balanced 预设)
{
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  minScore: 0.5,
  rerank: "cross-encoder",
  candidatePoolSize: 12,
  recencyHalfLifeDays: 14,
  recencyWeight: 0.15,
  hardMinScore: 0.55,
  timeDecayHalfLifeDays: 60,
  reinforcementFactor: 0.5,
  maxHalfLifeMultiplier: 3,
}
```

## 附录 B：环境变量

| 变量 | 用途 |
|------|------|
| `OPENCLAW_CLI=1` | CLI 模式标识 |
| `${EMBEDDING_API_KEY}` | Embedding API 密钥 |
| `${LLM_API_KEY}` | LLM API 密钥 |
| `${RERANK_API_KEY}` | Rerank API 密钥 |

配置值中可以使用 `${ENV_VAR}` 语法引用环境变量，运行时由 `resolveEnvVars()` 解析。

---

*文档版本：2026.4.30 | 基于 MyMem v2026.4.26 源码分析*
