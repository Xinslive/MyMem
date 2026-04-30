/**
 * Lightweight Chinese query expansion for BM25.
 * Keeps the vector query untouched and only appends a few high-signal synonyms.
 */

const MAX_EXPANSION_TERMS = 5;

interface SynonymEntry {
  cn: string[];
  en: string[];
  expansions: string[];
}

const SYNONYM_MAP: SynonymEntry[] = [
  {
    cn: ["挂了", "挂掉", "宕机"],
    en: ["shutdown", "crashed"],
    expansions: ["崩溃", "crash", "error", "报错", "宕机", "失败"],
  },
  {
    cn: ["卡住", "卡死", "没反应"],
    en: ["hung", "frozen"],
    expansions: ["hang", "timeout", "超时", "无响应", "stuck"],
  },
  {
    cn: ["炸了", "爆了"],
    en: ["oom"],
    expansions: ["崩溃", "crash", "OOM", "内存溢出", "error"],
  },
  {
    cn: ["配置", "设置"],
    en: ["config", "configuration"],
    expansions: ["配置", "config", "configuration", "settings", "设置"],
  },
  {
    cn: ["部署", "上线"],
    en: ["deploy", "deployment"],
    expansions: ["deploy", "部署", "上线", "发布", "release"],
  },
  {
    cn: ["容器"],
    en: ["docker", "container"],
    expansions: ["Docker", "容器", "container", "docker-compose"],
  },
  {
    cn: ["报错", "出错", "错误"],
    en: ["error", "exception"],
    expansions: ["error", "报错", "exception", "错误", "失败", "bug"],
  },
  {
    cn: ["修复", "修了", "修好"],
    en: ["bugfix", "hotfix"],
    expansions: ["fix", "修复", "patch", "解决"],
  },
  {
    cn: ["踩坑"],
    en: ["troubleshoot"],
    expansions: ["踩坑", "bug", "问题", "教训", "排查", "troubleshoot"],
  },
  {
    cn: ["记忆", "记忆系统"],
    en: ["memory"],
    expansions: ["记忆", "memory", "记忆系统", "LanceDB", "索引"],
  },
  {
    cn: ["搜索", "查找", "找不到"],
    en: ["search", "retrieval"],
    expansions: ["搜索", "search", "retrieval", "检索", "查找"],
  },
  {
    cn: ["推送"],
    en: ["git push"],
    expansions: ["push", "推送", "git push", "commit"],
  },
  {
    cn: ["日志"],
    en: ["logfile", "logging"],
    expansions: ["日志", "log", "logging", "输出", "打印"],
  },
  {
    cn: ["权限"],
    en: ["permission", "authorization"],
    expansions: ["权限", "permission", "access", "授权", "认证"],
  },
  // AI/ML domain
  {
    cn: ["向量", "嵌入"],
    en: ["embedding", "vector"],
    expansions: ["embedding", "vector", "向量", "嵌入", "相似度", "cosine"],
  },
  {
    cn: ["提示词", "提示"],
    en: ["prompt"],
    expansions: ["prompt", "提示词", "指令", "system prompt", "few-shot"],
  },
  {
    cn: ["模型"],
    en: ["model", "llm"],
    expansions: ["model", "模型", "LLM", "大模型", "推理"],
  },
  {
    cn: ["知识库", "知识"],
    en: ["rag", "knowledge"],
    expansions: ["RAG", "知识库", "knowledge base", "检索增强", "向量数据库"],
  },
  // Software engineering
  {
    cn: ["接口", "API"],
    en: ["api", "endpoint"],
    expansions: ["API", "接口", "endpoint", "REST", "GraphQL"],
  },
  {
    cn: ["数据库"],
    en: ["database", "db"],
    expansions: ["数据库", "database", "DB", "SQL", "NoSQL", "查询"],
  },
  {
    cn: ["测试"],
    en: ["test", "testing"],
    expansions: ["测试", "test", "testing", "单元测试", "集成测试", "mock"],
  },
  {
    cn: ["性能", "优化"],
    en: ["performance", "optimize"],
    expansions: ["性能", "优化", "performance", "optimize", "瓶颈", "profiling"],
  },
  // Software engineering - collaboration
  {
    cn: ["问题", "缺陷", "故障"],
    en: ["bug", "issue", "defect"],
    expansions: ["bug", "问题", "缺陷", "故障", "issue", "修复"],
  },
  {
    cn: ["重构", "重写"],
    en: ["refactor", "rewrite"],
    expansions: ["重构", "refactor", "重写", "优化代码", "rewrite"],
  },
  {
    cn: ["审查", "代码审查"],
    en: ["review", "code review", "CR"],
    expansions: ["review", "审查", "代码审查", "CR", "code review"],
  },
  {
    cn: ["合并", "合入"],
    en: ["merge"],
    expansions: ["merge", "合并", "合入", "pull request", "PR"],
  },
  {
    cn: ["持续集成", "流水线"],
    en: ["CI", "CD", "pipeline"],
    expansions: ["CI/CD", "持续集成", "流水线", "自动部署", "pipeline"],
  },
  {
    cn: ["缓存"],
    en: ["cache", "caching"],
    expansions: ["缓存", "cache", "Redis", "缓存策略", "cache invalidation"],
  },
  {
    cn: ["并发", "多线程"],
    en: ["concurrency", "threading", "async"],
    expansions: ["并发", "concurrency", "多线程", "异步", "async", "锁"],
  },
];

function buildWordBoundaryRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

// ============================================================================
// Learned Synonyms (populated at runtime from successful recall patterns)
// ============================================================================

const learnedSynonyms = new Map<string, string[]>();
const MAX_LEARNED = 200;

/**
 * Learn a synonym association: when `trigger` appears in a query,
 * add `expansion` terms to the expanded query.
 * Called by feedback loop when a query successfully recalls memories
 * containing terms not in the original query.
 */
export function addLearnedSynonym(trigger: string, expansions: string[]): void {
  if (learnedSynonyms.size >= MAX_LEARNED) return;
  const key = trigger.toLowerCase().trim();
  if (!key || expansions.length === 0) return;
  const existing = learnedSynonyms.get(key) ?? [];
  const newTerms = expansions.filter(e => !existing.includes(e)).slice(0, 3);
  if (newTerms.length > 0) {
    learnedSynonyms.set(key, [...existing, ...newTerms].slice(0, 5));
  }
}

export function expandQuery(query: string): string {
  if (!query || query.trim().length < 2) return query;

  const lower = query.toLowerCase();
  const additions = new Set<string>();

  for (const entry of SYNONYM_MAP) {
    const cnMatch = entry.cn.some((term) => lower.includes(term.toLowerCase()));
    const enMatch = entry.en.some((term) => buildWordBoundaryRegex(term).test(query));

    if (!cnMatch && !enMatch) continue;

    for (const expansion of entry.expansions) {
      if (!lower.includes(expansion.toLowerCase())) {
        additions.add(expansion);
      }
      if (additions.size >= MAX_EXPANSION_TERMS) break;
    }

    if (additions.size >= MAX_EXPANSION_TERMS) break;
  }

  // Check learned synonyms
  const words = lower.split(/\s+/);
  for (const word of words) {
    if (additions.size >= MAX_EXPANSION_TERMS) break;
    const learned = learnedSynonyms.get(word);
    if (learned) {
      for (const expansion of learned) {
        if (!lower.includes(expansion.toLowerCase())) {
          additions.add(expansion);
        }
        if (additions.size >= MAX_EXPANSION_TERMS) break;
      }
    }
  }

  if (additions.size === 0) return query;
  return `${query} ${[...additions].join(" ")}`;
}
