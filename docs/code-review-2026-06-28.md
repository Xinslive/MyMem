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
