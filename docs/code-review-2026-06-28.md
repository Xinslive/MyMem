# MyMem 代码全面审查报告 - 2026-06-28

## 审查范围

本报告是 `docs/audit-2026-06-28.md` 之后的新一轮二次审查，重点不是重复旧报告已关闭的 38 个问题，而是重新从当前 HEAD 审查仍可能影响维护升级的残余风险。

审查覆盖：

- 运行入口和工具注册：`index.ts`、`src/plugin-singleton.ts`、`src/tools.ts`
- 自动捕获、LLM 抽取、准入控制和拒绝审计：`src/smart-extractor.ts`、`src/admission-control.ts`、`src/workspace-utils.ts`
- LanceDB 存储、索引、作用域过滤和统计：`src/store.ts`、`src/store-sql-utils.ts`、`src/store-row-mappers.ts`
- 运维和文件写入：`src/dashboard-server.ts`、`src/file-utils.ts`、`src/audit-log.ts`
- 兼容工具和 CLI 导入路径：`src/tools-store.ts`、`src/tools-update.ts`、`cli.ts`、`src/cli/import-markdown.ts`

## 验证基线

本文件最初记录二次审查发现；2026-06-28 已按 CR-1 到 CR-10 完成本轮修复并回写为 fix log。修复后验证命令结果如下：

- `npm run typecheck`：通过。
- `npm run lint`：通过，`no-explicit-any` 已从背景 warning 收敛为默认 error，仅在带注释的动态边界 allowlist 中放行。
- `node scripts/verify-ci-test-manifest.mjs`：通过，107 个测试文件全部被 CI manifest 精确覆盖一次。
- `node scripts/run-ci-tests.mjs --all`：通过。

## 结论摘要

当前代码的主干质量较上一次审计后明显更稳：零向量、维度切换、提取链路脱敏、dashboard 鉴权、维护状态原子写等关键问题已有覆盖测试。本轮二次审查发现的 10 个问题也已完成修复。

主要落地变化：

- 写入和日志安全：拒绝审计、手工工具、Markdown mirror、CLI/Markdown import、LLM/candidate preview 都接入统一脱敏策略。
- 持久化可靠性：embedding dimension、FTS marker、dashboard token 和 mutation audit 等路径补齐原子写、队列或 flush 能力。
- 作用域和分类一致性：legacy `NULL` scope 只在 `global` 明确可见时放行；普通主库新写入、列表、统计和治理路径已收敛到六分类。
- 维护性能和信号质量：`stats()` 避免全表 metadata 扫描，deferred vector index 失败有冷却诊断，lint 不再被大量 `any` warning 稀释。

## 问题清单

| ID | 等级 | 状态 | 摘要 |
| --- | --- | --- | --- |
| CR-1 | P0 | Fixed | 准入拒绝审计持久化前统一脱敏候选和对话片段 |
| CR-2 | P1 | Fixed | embedding 维度标记、FTS 标记、dashboard token、JSONL 审计路径补齐原子写/队列/flush |
| CR-3 | P1 | Fixed | `scope IS NULL` 仅在 `global` 明确可见时作为 legacy global row 读取 |
| CR-4 | P1 | Fixed | `mymem_store`、`mymem_update`、mdMirror、CLI JSON import、Markdown import 统一写入脱敏 |
| CR-5 | P1 | Fixed | 普通主库新写入、读取映射、统计、工具和 dashboard 已收敛到六分类；旧类别仅作为迁移/读取兼容 |
| CR-6 | P2 | Fixed | `stats()` 改为 count query 和有界 scope sample，避免全表 metadata 扫描 |
| CR-7 | P2 | Fixed | mutation audit 改为队列式 append 并提供 store close/flush drain 能力 |
| CR-8 | P2 | Fixed | deferred vector index 失败后记录诊断并进入冷却，避免每次写入重复重试 |
| CR-9 | P2 | Fixed | LLM/candidate preview 日志统一经过 secret redaction |
| CR-10 | P3 | Fixed | `no-explicit-any` 默认升级为 error，动态 hook/CLI 边界通过显式 allowlist 管控 |

说明：CR-5 不再允许旧类别作为用户工具参数、列表过滤或普通主库新写入的合法分类。为保护已有数据，存储层仍保留 legacy 行的迁移/读取映射；`reflection` 仍保持独立 reflection/session 管线，不作为普通 `mymem_recall` 主库分类扩张。

## 详细发现

下面保留原审查证据和建议，便于追溯问题来源；当前状态以“问题清单”和“修复记录”为准。

### CR-1 P0：拒绝审计持久化绕过抽取脱敏

证据：

- `src/admission-control.ts:83` 到 `src/admission-control.ts:92` 的 `AdmissionRejectionAuditEntry` 包含完整 `candidate` 和 `conversation_excerpt`。
- `src/admission-control.ts:134` 到 `src/admission-control.ts:149`、`src/admission-control.ts:151` 到 `src/admission-control.ts:178`、`src/admission-control.ts:180` 到 `src/admission-control.ts:207` 三个 preset 都把 `persistRejectedAudits` 设为 `true`。
- `openclaw.plugin.json:411` 到 `openclaw.plugin.json:414` 的配置默认值也是 `true`，`openclaw.plugin.json:1542` 到 `openclaw.plugin.json:1545` 明确说明会写 JSONL。
- `src/smart-extractor.ts:445` 到 `src/smart-extractor.ts:453` 已经在送 LLM 前做 `redactSecrets(cleaned)`，但 `src/smart-extractor.ts:790` 到 `src/smart-extractor.ts:799` 写拒绝审计时直接传入 `candidate` 和 `conversationText.slice(-1200)`。
- `src/workspace-utils.ts:191` 到 `src/workspace-utils.ts:195` 直接 `appendFile(JSON.stringify(entry))`。

影响：

旧审计修复了“抽取路径入库前脱敏”，但拒绝审计是一个默认开启的持久化旁路。`conversation_excerpt` 使用原始 `conversationText`，如果对话里出现 API key、密码、私钥或 webhook URL，即使候选最终被拒绝，也可能进入 `admission-audit/rejections.jsonl`。

建议：

- 在 `recordRejectedAdmission()` 中构造 safe entry：对 `candidate.abstract`、`candidate.content`、`conversation_excerpt` 执行 `redactSecrets`，必要时再执行 `redactPII`。
- 或把 `persistRejectedAudits` 默认改为 `false`，并在 UI/manifest 中明确说明开启后会写入经过脱敏的调试片段。
- 为拒绝审计增加回归测试：输入全角冒号密码、OpenAI key、private key、webhook token，断言 JSONL 不含原文 secret。

### CR-2 P1：原子写策略覆盖不完整

证据：

- `src/file-utils.ts:48` 到 `src/file-utils.ts:70` 已有 `writeTextFileAtomic()` 和 `writeJsonFileAtomic()`。
- `src/store.ts:9` 仍直接导入 `writeFile`，`src/store.ts:855` 到 `src/store.ts:872` 写 `.mymem-embedding-dimension.json`，`src/store.ts:884` 到 `src/store.ts:889` 写 `.mymem-fts-index.version`。
- `src/dashboard-server.ts:190` 到 `src/dashboard-server.ts:193` 生成 dashboard token 时直接 `writeFile(tokenFile, generatedToken, { mode: 0o600 })`。
- `src/workspace-utils.ts:191` 到 `src/workspace-utils.ts:195` 的拒绝审计 JSONL 没有 mode、轮转、fsync 或写入队列。

影响：

RH-1 已经修复维护状态文件的原子写，但这些新标记/凭证/审计文件仍可能在崩溃、断电或并发进程下出现截断或半写。维度和 FTS 标记损坏会影响启动诊断；dashboard token 损坏会影响本地访问；拒绝审计文件还叠加了 CR-1 的敏感数据问题。

建议：

- `writePersistedEmbeddingDimension()` 和 `writeFtsIndexVersion()` 改用 `writeJsonFileAtomic()` / `writeTextFileAtomic()`。
- dashboard token 用原子写，保留 `0o600`。
- JSONL append 至少统一 `mode: 0o600`，并考虑小型写队列或批量 flush；如果需要强审计语义，应补 `close()/flush()`。

### CR-3 P1：`NULL` scope 放行导致 ACL 语义不一致

证据：

- `src/store-sql-utils.ts:37` 到 `src/store-sql-utils.ts:43` 的 `buildScopeWhereClause(scopeFilter)` 返回 `((scope = ...) OR scope IS NULL)`。
- `src/store-row-mappers.ts:23` 到 `src/store-row-mappers.ts:35` 会把 `row.scope ?? "global"` 映射成 `global`。
- `src/store.ts:1091` 到 `src/store.ts:1094` 的 `getById()` 会在应用层检查 `scopeFilter.includes(entry.scope)`；因此 `NULL` row 归一为 `global` 后，如果过滤器没有 `global`，会被拒绝。
- `src/store.ts:1171` 到 `src/store.ts:1188` 的 `vectorSearch()` 和 `src/store.ts:1224` 到 `src/store.ts:1228` 的 BM25 查询依赖 SQL WHERE，之后注释说明跳过冗余应用层 scope 校验。

影响：

同一条 legacy `NULL` scope 记录，在 `getById()` 下可能不可见，在 vector/BM25/list/stats 下却可能被 `OR scope IS NULL` 放行。对于显式 ACL 不包含 `global` 的 agent，这会形成搜索/列表侧的跨 scope 暴露。

建议：

- 迁移阶段把 `NULL` scope 明确写回 `global`。
- `buildScopeWhereClause()` 只在 `scopeFilter` 包含 `global` 时追加 `OR scope IS NULL`，或彻底移除 `NULL` 兼容分支。
- 增加覆盖 `getById()`、`list()`、`vectorSearch()`、`bm25Search()`、`stats()` 的同一批 legacy null-scope ACL 测试。

### CR-4 P1：兼容写入路径没有统一脱敏

证据：

- 2026-06-28 后续修复：当前 `src/tools.ts` 已默认注册 `mymem_update`，`openclaw.plugin.json` contracts 也包含 `mymem_update`，并且 `src/tools-update.ts` 的文本更新路径已对 `text` 执行 `redactSecrets()` 后再 embedding、入库、写 metadata 和返回预览。
- 兼容导出仍存在：`src/tools.ts:17` 到 `src/tools.ts:20` 导出 store/update。
- `src/tools-store.ts:171` 到 `src/tools-store.ts:176` 用原始 `stripped` 生成 embedding，`src/tools-store.ts:262` 到 `src/tools-store.ts:269` 和 `src/tools-store.ts:327` 到 `src/tools-store.ts:357` 用原始 `text` 入库、写 metadata。
- `src/tools-store.ts:360` 到 `src/tools-store.ts:365` 会把原始 `text` 写到 mdMirror。
- `cli.ts:803` 到 `cli.ts:823`、`cli.ts:989`、`src/cli/import-markdown.ts:215` 到 `src/cli/import-markdown.ts:225` 的导入路径也直接写原文。

影响：

`mymem_update` 的默认注册风险已处理，但 secret redaction 仍不是所有写入路径共享的统一策略。一旦重新开放 `mymem_store`，或把 CLI 导入用于非备份数据源，secret redaction 只覆盖自动抽取和 update 路径的假设仍会失效。

建议：

- 抽出统一 `sanitizeMemoryWriteText()`，由自动抽取、手动工具、mdMirror、CLI import 的“非备份恢复模式”共同使用。
- 对 backup/restore 保留 `--preserve-raw` 或类似显式选项，默认导入仍应脱敏。
- 为 `mymem_store` 和 Markdown import 各加一条 secret 不落盘测试；`mymem_update` 已有 `redacts secrets when updating memory text` 回归测试。

### CR-5 P1：全面转向新的六分类，移除旧类别兼容

证据：

- `src/memory-categories.ts:8` 到 `src/memory-categories.ts:15` 定义公开六分类：`profile`、`preferences`、`entities`、`events`、`cases`、`patterns`。
- `src/store-types.ts:31` 到 `src/store-types.ts:38` 的持久层仍是 `preference`、`fact`、`decision`、`entity`、`other`、`reflection`。
- `src/smart-extractor-handlers.ts:56` 到 `src/smart-extractor-handlers.ts:78` 通过 `mapToStoreCategory()` 把六分类折叠为旧五分类。

影响：

这是后续维护升级的关键阻塞项，不应继续作为“兼容设计”保留。现在很多模块同时出现 `category`、`memory_category`、`rawCategory`、`StoreCategory`，并且 `events`、`cases`、`patterns` 会被折叠成 `decision`、`fact`、`other`。只要旧存储类别继续存在，生命周期治理、dashboard 统计、CLI 导入导出、检索过滤和测试夹具都会在两个分类体系之间摇摆，后续新增策略也会持续写错语义层。

明确要求：

- 项目要全面转向六分类：`profile`、`preferences`、`entities`、`events`、`cases`、`patterns`。
- 不再兼容旧存储类别：`preference`、`fact`、`decision`、`entity`、`other` 不应作为主库新写入、工具参数、统计输出或内部治理判断的合法分类。
- `reflection` 仍应保持独立 reflection/session 存储，不并入普通 `mymem_recall` 主库分类；如果主库里存在历史 `reflection` 行，也应通过迁移或隔离策略处理，而不是继续扩大普通存储枚举。

建议：

- 修改 `src/store-types.ts`：`MemoryEntry.category` 和 `MemoryEntrySchema.category` 直接使用六分类枚举，删除旧 `STORE_CATEGORY_VALUES` 作为主路径类型。
- 删除或废弃 `mapToStoreCategory()` 折叠逻辑；抽取、手动更新、导入、生命周期治理、列表/统计应直接读写六分类。
- 增加一次性数据迁移：按历史 `metadata.memory_category` 优先回填 `entry.category`；缺失 metadata 时才用旧类别做有限映射，并在迁移完成后不再接受旧类别新写入。
- 更新 CLI/import/export/dashboard/README/TECHNICAL_DOC：输出和过滤条件统一使用六分类，不再展示 `rawCategory` 作为用户概念。
- 更新测试夹具和断言：所有新测试数据使用六分类；增加“旧类别写入被拒绝/迁移后不再出现”的回归测试。
- 将这个迁移作为独立版本升级项处理，先写迁移测试，再改存储类型和各调用点，避免半迁移状态进入发布。

### CR-6 P2：`stats()` 对大库仍是 O(N)

证据：

- `src/store.ts:1448` 到 `src/store.ts:1454` 已使用 count query 获取总数和时间窗口计数。
- 但 `src/store.ts:1468` 到 `src/store.ts:1485` 仍选择 `LIST_ENTRY_COLUMNS` 并 `toArray()` 加载全部轻量行，再逐行 `mapRowToMemoryEntry()` 解析 metadata。

影响：

30 秒缓存能缓解频繁刷新，但 dashboard 或 CLI stats 对大库仍会随总记忆数线性增长。metadata 解析还会把低置信度、tier、suppression 等健康信号绑在全表扫描上，数据量上来后会拖慢管理面。

建议：

- 把 scope/category/timestamp 的统计拆成 SQL/group/count 或独立 aggregate。
- `healthSignals` 改为采样、分页后台任务，或维护增量计数。
- dashboard 默认读取轻量统计，深度健康检查单独触发。

### CR-7 P2：mutation audit 不是可 flush 的审计日志

证据：

- `src/audit-log.ts:61` 到 `src/audit-log.ts:69` 明确 fire-and-forget，`appendFile(...).catch(() => {})`，不阻塞主写入。

影响：

作为 best-effort 事件日志可以接受，但如果后续把它当合规审计或故障复盘依据，进程退出、测试 teardown 或崩溃时会丢最后一批 mutation 记录。当前语义需要在文档中说清楚。

建议：

- 保留 best-effort 设计时，在 README/TECHNICAL_DOC 中明确“非强审计”。
- 如果要强审计，改成短队列、定期 flush，并在 `MemoryStore.close()` 或 plugin shutdown 时 drain。

### CR-8 P2：deferred vector index 失败后缺少冷却

证据：

- `src/store.ts:437` 到 `src/store.ts:446` 的 `maybeCreateDeferredVectorIndex()` 在失败时只 warn。
- `src/store.ts:998` 和 `src/store.ts:1035` 会在 store/import 后继续调用该方法。

影响：

一旦索引创建因为 LanceDB 版本、权限、损坏索引或临时文件系统问题持续失败，64 行之后每次写入都会 count rows 并尝试建索引，形成重复日志和额外写入延迟。

建议：

- 增加失败冷却时间和失败次数统计，例如 5 分钟内只重试一次。
- 在 doctor/dashboard 中暴露最后失败原因，让运维入口处理而不是让每次写入兜底。

### CR-9 P2：调试日志 preview 未统一脱敏

证据：

- `src/smart-extractor.ts:450` 已对 LLM 输入脱敏。
- `src/smart-extractor.ts:497` 到 `src/smart-extractor.ts:518` 会记录无效/过短/噪声候选摘要片段。
- `src/smart-extractor.ts:613` 到 `src/smart-extractor.ts:638`、`src/smart-extractor.ts:691` 到 `src/smart-extractor.ts:694` 会在嵌入失败、准入拒绝、dedup skip 时记录候选摘要片段。
- `src/llm-client.ts:235` 到 `src/llm-client.ts:268`、`src/llm-client.ts:353` 到 `src/llm-client.ts:357`、`src/llm-client.ts:508` 到 `src/llm-client.ts:512` 会把 JSON/raw preview 写入错误日志。

影响：

自动抽取主输入已脱敏，所以风险低于 CR-1/CR-4。但 LLM 可能在响应中重新生成或复制敏感内容，debug 日志如果持久化到外部系统，仍可能出现 secret echo。

建议：

- 日志 preview 统一使用 `redactSecrets()` 或 `redactAll()`。
- 增加一个低成本 lint/test guard：禁止 `text.slice()`、`jsonPreview`、candidate abstract 直接进入 logger，除非同一表达式经过 redaction helper。

### CR-10 P3：`any` 警告已成为背景噪音

证据：

- `npm run lint` 当前 0 errors、68 warnings。
- 警告集中在 `index.ts`、`src/auto-capture-hook.ts`、`src/auto-recall-hook.ts`、`src/hook-enhancements.ts`、`src/reflection-hook.ts`、`src/cli/oauth.ts`、`src/plugin-singleton.ts`、`cli.ts`。

影响：

这些大多位于 OpenClaw hook payload、runtime context、OAuth JSON 边界，本来就是需要运行时校验的地方。继续让它们以普通 lint warning 存在，会削弱 lint 对新增问题的提醒价值。

建议：

- 为 OpenClaw hook payload 定义窄接口，入口用 `unknown` 加 parser/guard。
- 对真正动态的边界建立 `JsonObject`、`RuntimeHookPayload` 等集中类型，而不是散落 `any`。
- 分阶段把 `no-explicit-any` 从 warning 收敛到少量带解释的例外。

## 修复记录

2026-06-28 完成本轮修复：

- CR-1：`recordRejectedAdmission()` 持久化前清洗 `candidate.abstract`、`candidate.content` 和 `conversation_excerpt`，新增 `test/admission-rejection-audit-redaction.test.mjs`。
- CR-2：store marker、FTS marker、dashboard token 使用原子写；拒绝审计 JSONL 至少以 `0o600` 追加；mutation audit 支持队列 drain。
- CR-3：`buildScopeWhereClause()` 修正 legacy `NULL` scope 语义，新增 `test/scope-null-isolation.test.mjs`。
- CR-4：新增统一 `sanitizeMemoryWriteText()`，接入手工 store/update、mdMirror、CLI JSON import、Markdown import 和相关返回预览，新增 `test/manual-write-redaction.test.mjs`。
- CR-5：主库新写入和用户可见分类统一为 `profile`、`preferences`、`entities`、`events`、`cases`、`patterns`；旧 `preference/fact/decision/entity/other` 只用于 legacy 迁移/读取映射。
- CR-6：`stats()` 使用 count query 计算总量、分类、健康信号和 tier 分布，只保留有界 scope sample。
- CR-7：mutation audit 从 fire-and-forget 改为可 flush 队列，相关测试在读取审计文件前 drain。
- CR-8：deferred vector index 失败记录最后错误、失败次数和下次重试时间，并在 cooldown 内跳过重复建索引。
- CR-9：LLM JSON/raw preview、抽取 candidate preview、嵌入/准入/dedup debug 日志统一脱敏。
- CR-10：ESLint `no-explicit-any` 默认升级为 error，保留少量动态边界文件级 allowlist 并写明原因。

本轮新增或更新的重点测试：

- `test/admission-rejection-audit-redaction.test.mjs`
- `test/manual-write-redaction.test.mjs`
- `test/scope-null-isolation.test.mjs`
- `test/store-index-status-and-list.test.mjs`
- `test/llm-api-key-client.test.mjs`
- `test/memory-governance-tools.test.mjs`
- `test/recall-text-cleanup.test.mjs`
- `test/intent-analyzer.test.mjs`
- `test/memory-reflection.test.mjs`
- `test/memory-update-metadata-refresh.test.mjs`
- `test/is-latest-auto-supersede.test.mjs`
- `test/capture-detection.test.mjs`
- `test/memory-compactor.test.mjs`

最终验证：

- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `node scripts/verify-ci-test-manifest.mjs`：通过，107 entries。
- `node scripts/run-ci-tests.mjs --all`：通过。

## 后续维护备注

本文现在作为二次审查和本轮修复日志。后续如果继续收紧 CR-5，可考虑在下一个破坏性版本中彻底移除 legacy 旧类别输入映射；当前保留读取/迁移兼容是为了避免既有 LanceDB 行在升级时丢失语义。

2026-06-28 追加收紧：主 `MemoryStore` 默认拒绝新的 top-level `category: "reflection"` 写入，只有显式配置 `allowReflectionCategory: true` 的专用 reflection store 可以写入 reflection 行。主库 `store()`、`importEntry()`、`update()`、`flushBatch()` 也会在写入前拒绝旧类别 `preference`、`fact`、`decision`、`entity`、`other` 和未知类别；旧类别只保留初始化迁移、读取映射和统计兼容。这样把“reflection/session 数据不进入普通 `mymem_recall` 主库”和“新写入只使用六分类”的约束下沉到存储层，新增覆盖测试为 `test/store-initialization-lifecycle.test.mjs`。

2026-06-28 追加脱敏补强：候选记忆不只在入库、拒绝审计和 LLM preview 前脱敏，自动抽取分支日志、smart-extractor handlers 日志、admission-control debug log、`mymem_store` envelope 拒绝详情、Markdown import dry-run/skip/failure 控制台预览也统一使用 secret redaction。新增覆盖测试为 `test/admission-rejection-audit-redaction.test.mjs`、`test/smart-extractor-handler-redaction.test.mjs`、`test/manual-write-redaction.test.mjs`、`test/import-markdown/import-markdown.test.mjs`。

2026-06-28 追加 dashboard token 加固：自动生成 dashboard auth token 时仍写入 `0o600` token file，启动日志只打印 token 文件路径，不再打印 `?token=...` 明文 URL；未带 token 的 HTML 不再暴露 token，带合法 `?token=` 的首次访问会设置 `HttpOnly; SameSite=Strict` cookie 并重定向去掉 URL token，API 支持 header/query/cookie 三种鉴权。CLI dashboard 和插件自动启动都会提供/传入 token 文件路径，避免控制台因无 token 持久化位置而跳过启动。新增 `test/dashboard-server.test.mjs` 回归覆盖 token 文件权限、日志不含 token、HTML 不含 token，以及 cookie 登录流。

2026-06-28 追加 reembed 兼容修复：`openclaw mymem reembed` 现在会把源 LanceDB 的旧顶层分类按六分类归一，并规范化导入 metadata，避免旧 `other/preference/fact/...` 行在新版主库写入边界下失败或继续携带空旧 metadata。`test/cli-smoke.mjs` 新增非 dry-run reembed 回归，确认旧 `other` 源行导入为 `patterns` 且 metadata 写入 `memory_category: "patterns"`。

2026-06-28 追加 dashboard 可用性修正：dashboard 使用 token 文件启动时的服务端日志不再提示无鉴权 base URL，而是提示读取 token 文件的解锁 URL 形式，并统一 shell-safe 引用 token 文件路径；已有 token 文件重启时也会继续提示解锁 URL。README/TECHNICAL_DOC 同步说明首次带 token 访问会换成本机 HttpOnly cookie。`test/dashboard-server.test.mjs` 回归覆盖日志包含 token 文件读取命令但不包含明文 token。

2026-06-28 追加 dashboard 主日志修正：插件自动启动 dashboard 后，OpenClaw 主日志里的“控制台已启动”也改为输出 token 文件解锁 URL，而不是裸 base URL，避免用户从主日志打开后遇到未鉴权页面。`test/plugin-manifest-regression.mjs` 覆盖自动启动日志包含 token-file URL 且不包含明文 token。

2026-06-28 追加访问写回 drain：`AccessTracker` 新增可等待的 `close()`，`MemoryRetriever.flushAccessTrackers()` 会 drain 主/备用访问写回队列，插件 `stop` 生命周期在停止 dashboard/backup 前等待该 drain，避免进程退出时丢失最后一批手动召回访问计数和学习信号。`test/access-tracker.test.mjs` 覆盖 close 会完成写回；`test/plugin-manifest-regression.mjs` 覆盖 service stop 会调用 retriever drain。

2026-06-28 追加访问写回等待修正：`AccessTracker` 的 individual fallback flush 不再 fire-and-forget `store.update()`，而是等待写回完成后再返回，确保 `close()` 在非批量 store / 备用 tracker 路径上也真正 drain。`test/access-tracker.test.mjs` 增加慢 `update()` 回归，确认 `close()` 不会提前返回。

2026-06-28 追加 retriever 元数据写回 drain：`recordAccessAndMaybeTransition()` 仍保持热路径 fire-and-forget，但现在会追踪后台 metadata update promise；`flushAccessTrackers()` 会先等待这些 tier/access 写回落定，再 drain retry access tracker，避免插件 stop 时丢失已发出的生命周期/访问 metadata 更新。`test/retriever-graceful-degradation.test.mjs` 覆盖慢 `store.update()` 时 `flushAccessTrackers()` 不提前返回。

2026-06-28 追加 AccessTracker close 重试 drain：`AccessTracker.close()` 不再单次 flush 后直接清空 requeued pending，而是在关闭路径按既有 retry 上限做 bounded drain；瞬时失败会在 stop 时重试成功，持续失败会记录明确 error 后再丢弃。`test/access-tracker.test.mjs` 覆盖 close 重试成功和重试耗尽日志。

2026-06-28 追加 store shutdown drain：插件 `stop` 生命周期现在会在停止 dashboard/backup/feedback loop 后 flush mutation audit log 并关闭主库/反思库 LanceDB handles，同一 store 对象去重关闭，避免审计队列和本地句柄只依赖进程退出。`test/plugin-manifest-regression.mjs` 覆盖 service stop 会 flush audit log 并 close store。

2026-06-28 追加 telemetry shutdown drain：retrieval stats 的持久化 hook 仍保持 fire-and-forget 热路径，但 `TelemetryStore` 现在暴露 `flush()` 并等待 JSONL 写队列排空；插件 `stop` 生命周期会在关闭 store 前等待 telemetry drain，避免进程退出时丢失最后一批 retrieval/extraction telemetry。`test/telemetry-and-benchmark.test.mjs` 覆盖未 await 的 telemetry 写入可通过 `flush()` 稳定落盘，`test/plugin-manifest-regression.mjs` 覆盖 service stop 会调用 telemetry drain。

2026-06-28 追加启动延迟任务 shutdown drain：插件 `start` 里的延迟健康检查和 legacy upgrade 提示现在通过可追踪 timer 注册，`stop` 会取消尚未触发的延迟任务并等待已触发的启动任务结束后再关闭 store；auto-backup 的首次 1 分钟延迟备份也会在 `stop` 时取消，避免服务停止后后台任务重新访问已关闭的 LanceDB 句柄。新增 `test/auto-backup.test.mjs`，并在 `test/plugin-manifest-regression.mjs` 覆盖未触发 timer 取消和已触发启动任务 drain。

2026-06-28 追加 auto-backup in-flight drain：`createAutoBackup()` 现在会追踪正在执行的备份 promise，`stop()` 在取消 timer 后会等待 active backup 完成；插件 service stop 改为 `await autoBackup.stop()`，避免正在导出的备份与随后关闭的 store/LanceDB 句柄竞态。`test/auto-backup.test.mjs` 覆盖 stop 等待 in-flight backup，`test/plugin-manifest-regression.mjs` 覆盖 service stop 不会在备份结束前关闭 store。

2026-06-28 追加 feedback-loop shutdown drain：`FeedbackLoop` 新增异步 `close()`，保留同步 `dispose()` 兼容旧调用；timer 已触发的 drain/adaptation cycle 会被追踪并在 close 时等待，admission rejection audit 的 fire-and-forget 写入也会在 close 时 drain，失败回补到内存 buffer 后会在有 runtime context 时再 flush 到 JSONL。插件 service stop 改为 `await feedbackLoop.close()`，避免反馈学习/拒绝审计写入与 store shutdown 竞态。`test/feedback-loop.test.mjs` 覆盖 pending rejection audit 写入和已触发 adaptation cycle drain，`test/plugin-manifest-regression.mjs` 覆盖 service stop 调用 feedback loop close。

2026-06-28 追加 singleton session-prune timer 清理：单例初始化创建的 session map prune interval 现在纳入 `PluginSingletonState.sessionPruneInterval`，插件 service stop 会显式 `clearInterval`，避免热重载/测试/长进程停止后仍有 interval 持有 session map 状态。`test/plugin-manifest-regression.mjs` 覆盖 service stop 同时清理 auto-backup interval 和 session-prune interval。

2026-06-28 追加 auto-recall metadata stop flush：自动召回注入后的 `injected_count/access_count` metadata accumulator 现在会注册到 `PluginSingletonState.autoRecallMetadataAccumulators`，插件 service stop 会遍历并 `flushNow()`，避免服务停止早于 debounce/session_end 时丢失最后一批注入/访问计数。`test/per-agent-auto-recall.test.mjs` 覆盖 accumulator 注册后可由 stop 路径 flush，`test/plugin-manifest-regression.mjs` 覆盖 service stop 会 flush pending auto-recall metadata。

2026-06-28 追加 auto-recall tier maintenance drain：自动召回注入后的后台层级维护仍保持 fire-and-forget 热路径，但任务 promise 现在会注册到 `PluginSingletonState.autoRecallBackgroundTasks`，插件 service stop 会等待这些任务 settled 后再关闭 store，避免层级转换 metadata 写回与 store shutdown 竞态。`test/per-agent-auto-recall.test.mjs` 覆盖 tier maintenance task 注册和 drain，`test/plugin-manifest-regression.mjs` 覆盖 service stop 等待 pending auto-recall background task。

2026-06-28 追加 auto-capture extraction drain：自动捕获 `agent_end` 后台智能抽取任务现在会注册到 `PluginSingletonState.autoCaptureBackgroundTasks`，插件 service stop 会等待 pending extraction runs 完成后再 flush telemetry/关闭 store，避免 `smartExtractor.extractAndPersist()` / store batch 与 shutdown 竞态。`test/auto-capture-cleanup.test.mjs` 覆盖 background extraction task 注册和 drain，`test/plugin-manifest-regression.mjs` 覆盖 service stop 等待 pending auto-capture background task。

2026-06-28 追加 auto-recall metadata in-flight drain：`AutoRecallMetadataAccumulator.flushNow()` 现在会等待已经由 debounce timer 触发、正在执行中的 metadata batch flush，避免 stop/session_end 期间看到 pending 为空就提前返回，随后关闭 store 时仍有定时 flush 在写入。`test/per-agent-auto-recall.test.mjs` 覆盖 scheduled metadata flush 已在进行时，第二次 `flushNow()` 必须等待该写入完成。

2026-06-28 追加 hook-enhancement agent_end drain：`registerHookEnhancements()` 的 `agent_end` 后台任务现在会注册到 `PluginSingletonState.hookEnhancementBackgroundTasks`，插件 service stop 会等待 bad-recall feedback、自纠正规则、workspace drift 和 preventive lesson buffer drain 等写入完成后再关闭 store。`test/hook-enhancements.test.mjs` 覆盖 agent_end metadata 写入 task 注册和 drain，`test/plugin-manifest-regression.mjs` 覆盖 service stop 等待 pending hook-enhancement background task。

2026-06-28 追加 reflection feedback drain：memory-reflection 在 command:new/reset 反思完成后触发的 `feedbackLoop.drainPreventiveLessonBuffer()` 和 `feedbackLoop.forceAdaptationCycle()` 现在会注册到 `PluginSingletonState.reflectionBackgroundTasks`，插件 service stop 会等待这些反思衍生学习/准入自适应任务完成后再关闭 feedback loop 和 store。`test/plugin-manifest-regression.mjs` 覆盖 service stop 等待 pending reflection background task，`test/memory-reflection.test.mjs` 覆盖 reflection 主流程行为未回退。

2026-06-28 追加 store write queue drain：`MemoryStore` 新增 `flushWrites()` 等待内部 `_serialChain` 写队列排空；插件 service stop 在 flush audit log 和 close LanceDB handles 前会先等待主库/反思库 pending serialized writes，避免未被上层任务显式 await 的 store 写入与关闭句柄竞态。`test/store-write-queue.test.mjs` 覆盖 `flushWrites()` 等待 in-flight serialized write，`test/plugin-manifest-regression.mjs` 覆盖 service stop 在 close store 前等待 store write queue。

2026-06-28 追加 retrieval telemetry hook drain：`RetrievalStatsCollector` 现在追踪异步 record hook promise 并暴露 `flushRecordHooks()`；`MemoryRetriever.flushStatsCollector()` 和插件 service stop 会先等待 retrieval stats hook 把 telemetry 写入投递到 JSONL 队列，再调用 `TelemetryStore.flush()` 等待文件写落盘，避免 stop 时只 flush 了底层队列却漏掉尚未完成的 retrieval telemetry hook。`test/retrieval-trace.test.mjs` 覆盖 `flushRecordHooks()` 等待 in-flight async hook，`test/plugin-manifest-regression.mjs` 覆盖 service stop 调用 retriever stats drain。

2026-06-28 追加 extraction telemetry 隔离：`SmartExtractor` 仍会 await `onExtractionComplete`，保证成功路径 telemetry 投递进入 shutdown drain 链路；但 telemetry sink 失败现在只写 debug log，不会让已经完成的抽取/记忆写入整体失败，避免观测系统故障影响核心记忆功能。`test/smart-extractor-batch-embed.test.mjs` 覆盖 extraction telemetry persistence 失败时 `extractAndPersist()` 仍返回 stats。

2026-06-28 追加 store write queue tail-chasing drain：`MemoryStore.flushWrites()` 不再只等待调用瞬间的 `_serialChain`，而是循环追踪 flush 期间追加的新 tail，避免 shutdown drain 开始后又排入队尾的 serialized write 被漏掉。`test/store-write-queue.test.mjs` 覆盖 flush 过程中追加第二个写入时不会提前返回。

2026-06-28 追加 audit log 初始化竞态修复：`AuditLogger.log()` 现在会在初始化尚未完成时把审计 entry 排入写队列，并在 `enable()`/目录创建完成后再 append，不再因为 `MemoryStore` 构造器异步启用 audit logger 而静默丢失最早的 mutation audit。`test/store-audit-log.test.mjs` 覆盖 enable pending 时立即 log 的竞态。

2026-06-28 追加 audit log flush tail-chasing drain：`AuditLogger.flush()` 也改为循环追踪 `writeTail`，避免 shutdown audit drain 开始后又追加 mutation audit 时只等待旧 tail。`test/store-audit-log.test.mjs` 覆盖 flush 过程中追加第二条审计日志仍会在返回前写入文件。

2026-06-28 追加 auto-recall timeout 后处理短路：第二段 reasoning-strategy 召回返回后立即检查 abort signal，避免自动召回已经超时并返回给 OpenClaw 后，后台分支继续解析 strategy metadata、更新召回历史或排队注入副作用。`test/per-agent-auto-recall.test.mjs` 覆盖策略召回晚于 timeout 返回时不会继续读取结果 metadata。

2026-06-28 追加 auto-recall retry delay abort：自动召回第一次检索失败后的 200ms retry delay 现在会监听 abort signal；如果 hook 已经因 `autoRecallTimeoutMs` 超时返回，就不会继续等待后触发第二次检索，减少超时后的后台残留工作。`test/per-agent-auto-recall.test.mjs` 覆盖 timeout abort retry delay 后不会再次调用 retriever。

2026-06-28 追加 embedding retry backoff abort：`Embedder.retryWithBackoff()` 的指数退避等待现在也监听外部 abort signal；自动召回或启动探测取消 embedding 时，不再卡在 1s/2s/4s backoff sleep 后才退出。`test/auto-recall-abort-regression.test.mjs` 覆盖 abort 发生在 backoff sleep 期间时会快速返回且不发起下一次 embedding 重试。

2026-06-28 追加 OAuth LLM retry delay abort：OAuth LLM 请求的 transient failure retry delay 现在接入同一个 timeout abort signal；当 `timeoutMs` 已经触发时，不会继续等完 retry delay 后再打第二次 Codex backend 请求。`test/llm-oauth-client.test.mjs` 覆盖 503 后 timeout 打断 retry delay，且 backend 只收到一次请求。

2026-06-28 追加 retriever soft-degrade timer 清理：自动召回 hybrid retrieval 的 soft-degrade race 不再留下输掉的 degrade timer；搜索提前完成或外部 abort 时都会清理 timer，减少高频自动召回下的短生命周期后台计时器残留。`test/retriever-graceful-degradation.test.mjs` 覆盖搜索早于阈值完成和 abort 早于阈值触发两种清理路径。

2026-06-28 追加 resolveUnlessAborted listener 清理：共用 abort helper 现在在 abort 分支会立即移除 abort listener，不再等底层 promise settle；底层 I/O 很慢或永不 settle 时也不会把 listener 挂在 auto-recall/retriever 取消信号上。新增 `test/retriever-utils-abort.test.mjs` 覆盖 abort 立即清理和正常 resolve 清理两条路径，并登记到 CI manifest。

2026-06-28 追加 rerank timeout race：cross-encoder rerank 现在用显式 `Promise.race` 竞争 provider fetch、本地 rerank timeout 和外部 abort；即使 provider/fetch 忽略 AbortSignal 或永不 settle，也会按 `rerankTimeoutMs` 快速 fallback 到 cosine，并在外部 abort 时立即清理 listener 且静默 fallback。`test/retriever-rerank-fallback.test.mjs` 覆盖 fetch 忽略 AbortSignal 的 timeout 与 external abort 两条路径。

2026-06-28 追加 rerank body timeout race：cross-encoder rerank 的 `response.json()` 和非 2xx `response.text()` 解析现在也共用 `rerankTimeoutMs` / 外部 abort race；provider 先返回 headers 但 body 卡住时不再拖住召回，而是快速 fallback 到 cosine。`test/retriever-rerank-fallback.test.mjs` 覆盖成功 JSON body 和错误 text body 永不 settle 的两条路径。

2026-06-28 追加 Ollama embedding body abort：native Ollama embedding fetch 的成功 `response.json()` 和错误 `response.text()` 现在会监听同一个 embedding AbortSignal；服务端先返回 headers 但 body 卡住时，`embedPassage()` / `embedBatchPassage()` 不再等 socket 结束，而会随外部 abort 或全局 `EMBED_TIMEOUT_MS` 快速退出。`test/embedder-ollama-batch-routing.test.mjs` 覆盖 single 与 batch response body stalled 两条路径。

2026-06-28 追加 OAuth LLM body timeout：OAuth LLM backend fetch 成功返回 `Response` 后，成功 SSE/text body 和非 2xx error body 的 `response.text()` 读取现在也监听同一个 `timeoutMs` AbortSignal；Codex backend 先回 headers 但 body 卡住时，智能抽取会快速失败并释放 LLM 并发槽。`test/llm-oauth-client.test.mjs` 覆盖 success body stalled 与 error body stalled 两条路径。

2026-06-28 追加 OAuth token body timeout：OAuth refresh 和 authorization-code exchange 的 token endpoint response body 读取现在也监听对应 timeout AbortSignal；token 服务先回 headers 但 JSON/error body 卡住时，不再拖住 OAuth 刷新或登录换码流程。`test/llm-oauth-client.test.mjs` 覆盖 refresh success JSON body 与 error text body 永不 settle 的两条路径。

2026-06-28 追加 embedding timeout wrapper race：`Embedder.withTimeout()` 不再只调用 `AbortController.abort()` 后等待 provider promise 自行 settle；外部 caller abort 或全局 `EMBED_TIMEOUT_MS` 到期时，wrapper 会立即 reject，同时继续把 abort signal 传给底层 provider。这样 provider/SDK 忽略 AbortSignal 时也不会拖住 auto-recall 或写入路径。`test/auto-recall-abort-regression.test.mjs` 覆盖 provider 永不 settle 时 caller abort 仍快速返回。

2026-06-28 追加 concurrency limiter abort cleanup：共享 `ConcurrencyLimiter` 的排队 acquire 现在在 abort、授予 permit、跳过已取消项时都走一次性 cleanup，显式移除 abort listener，避免 embedding/LLM 高并发排队取消时留下监听器或重复 settle。新增 `test/concurrency-limiter.test.mjs` 并登记到 CI manifest，覆盖 queued abort、queued grant 和跳过已取消项不吞 permit。

2026-06-28 追加 reflection embedded timeout cancellation：通用 `cli-utils.withTimeout()` 兼容旧 promise 调用的同时新增 cancellable work 形式，超时时会 abort 内部 `AbortSignal`；memory reflection 的 embedded runner 现在把该 signal 透传给 OpenClaw `runEmbeddedPiAgent`，让支持取消的运行时能在反思超时降级时停止底层工作。新增 `test/cli-utils-timeout.test.mjs` 并登记到 CI manifest，`test/memory-reflection.test.mjs` 覆盖 embedded runner 参数包含未取消的 AbortSignal。

2026-06-28 追加 reflection CLI output cap：`runReflectionViaCli()` 现在限制外部 `openclaw agent --json` 子进程 stdout/stderr 单流最多 100 万字符；超过上限会先 SIGTERM、短暂等待后 SIGKILL，并返回明确错误，避免异常 CLI 日志或失控输出拖垮插件进程内存。`test/memory-reflection.test.mjs` 新增 fake CLI 回归覆盖 stdout 超限时会拒绝并终止子进程。
