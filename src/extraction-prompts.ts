/**
 * Prompt templates for intelligent memory extraction.
 * Three mandatory prompts:
 * - buildExtractionPrompt: 6-category L0/L1/L2 extraction with few-shot
 * - buildDedupPrompt: CREATE/MERGE/SKIP dedup decision
 * - buildMergePrompt: Memory merge with three-level structure
 */

export function buildExtractionPrompt(
  conversationText: string,
  user: string,
): string {
  return `Analyze the following session context and extract memories worth long-term preservation.

User: ${user}

Target Output Language: Simplified Chinese by default.
默认使用简体中文输出记忆文本。
Keep code identifiers, API names, file paths, commands, URLs, config keys, model names, and other proper nouns unchanged.
代码标识符、API 名、文件路径、命令、URL、配置键、模型名和其它专有名词必须保留原文。

## Recent Conversation
${conversationText}

# Memory Extraction Criteria

## What is worth remembering?
- Personalized information: Information specific to this user, not general domain knowledge
- Long-term validity: Information that will still be useful in future sessions
- Specific and clear: Has concrete details, not vague generalizations

## What is NOT worth remembering?
- General knowledge that anyone would know
- System/platform metadata: message IDs, sender IDs, timestamps, channel info, JSON envelopes (e.g. "System: [timestamp] Feishu...", "message_id", "sender_id", "ou_xxx") — these are infrastructure noise, NEVER extract them
- Temporary information: One-time questions or conversations
- Vague information: "User has questions about a feature" (no specific details)
- Tool output, error logs, or boilerplate — including raw error messages, stack traces, API responses, JSON payloads, or log lines that appear in the conversation
- Runtime scaffolding or orchestration wrappers such as "[Subagent Context]", "[Subagent Task]", bootstrap wrappers, task envelopes, or agent instructions — these are execution metadata, NEVER store them as memories
- Recall queries / meta-questions: "Do you remember X?", "你还记得X吗?", "你知道我喜欢什么吗" — these are retrieval requests, NOT new information to store
- Degraded or incomplete references: If the user mentions something vaguely ("that thing I said"), do NOT invent details or create a hollow memory
- Code snippets or file content that happened to appear in the conversation (e.g. from a failed Read tool call) — these are NOT memories, they are transient tool artifacts
- Error-failure pairs where the "solution" is generic advice (e.g. "retry the step", "check the error") rather than a specific, reusable fix
- Raw error messages or stack traces without added insight — the error itself is ephemeral; only a genuine lesson about WHY it happened and HOW to prevent it is worth storing

# Memory Classification

## Core Decision Logic

| Question | Answer | Category |
|----------|--------|----------|
| Who is the user? | Identity, attributes | profile |
| What does the user prefer? | Preferences, habits | preferences |
| What is this thing? | Person, project, organization | entities |
| What happened? | Decision, milestone | events |
| How was it solved? | Problem + solution | cases |
| What is the process? | Reusable steps | patterns |

## Precise Definition

**profile** - User identity (static attributes). Test: "User is..."
**preferences** - User preferences (tendencies). Test: "User prefers/likes..."
**entities** - Continuously existing nouns. Test: "XXX's state is..."
**events** - Things that happened. Test: "XXX did/completed..."
**cases** - Problem + solution pairs. Test: Contains "problem -> solution"
**patterns** - Reusable processes. Test: Can be used in "similar situations"

## Common Confusion
- "Plan to do X" -> events (action, not entity)
- "Project X status: Y" -> entities (describes entity)
- "User prefers X" -> preferences (not profile)
- "Encountered problem A, used solution B" -> cases (not events)
- "General process for handling certain problems" -> patterns (not cases)

# Three-Level Structure

Each memory contains three levels:

**abstract (L0)**: One-liner index
- Merge types (preferences/entities/profile/patterns): \`[Merge key]: [Description]\`
- Independent types (events/cases): Specific description

**overview (L1)**: Structured Markdown summary with category-specific headings

**content (L2)**: Full narrative with background and details

# Few-shot Examples

## profile
\`\`\`json
{
  "category": "profile",
  "worth_storing": true,
  "abstract": "用户基本信息：AI 开发工程师，有 3 年 LLM 经验",
  "overview": "## 背景\\n- 职业：AI 开发工程师\\n- 经验：3 年 LLM 应用开发\\n- 技术栈：Python、LangChain",
  "content": "用户是 AI 开发工程师，有 3 年 LLM 应用开发经验。"
}
\`\`\`

## preferences
\`\`\`json
{
  "category": "preferences",
  "worth_storing": true,
  "abstract": "Python 代码风格：不要类型提示，简洁直接",
  "overview": "## 偏好领域\\n- 语言：Python\\n- 主题：代码风格\\n\\n## 细节\\n- 不写类型提示\\n- 函数注释保持简洁\\n- 实现方式直接",
  "content": "用户偏好 Python 代码不写类型提示，函数注释简洁，实现方式直接。"
}
\`\`\`

## cases
\`\`\`json
{
  "category": "cases",
  "worth_storing": true,
  "abstract": "LanceDB BigInt 数值处理问题",
  "overview": "## 问题\\nLanceDB 0.26+ 会把数值列返回为 BigInt\\n\\n## 解决办法\\n做算术前用 Number(...) 转换",
  "content": "当 LanceDB 返回 BigInt 数值时，做算术运算前要先用 Number(...) 包裹转换。"
}
\`\`\`

# Worth Storing Judgment

For each candidate memory, judge whether it is truly worth long-term storage.

**worth_storing = true** when:
- Personalized information specific to this user (not generic knowledge)
- Has concrete details, will still be useful weeks/months later
- Durable preferences, profile facts, reusable procedures, key relationships, significant decisions
- Problem-solution pairs with enough detail to be actionable

**worth_storing = false** when:
- One-off chitchat, greetings, or transient situational remarks
- Vague generalizations without specific details (e.g., "user asked about a feature")
- Information that will be obsolete within days (temporary schedules, fleeting context)
- Low-signal restatements of things already clearly implied by the conversation
- Tool output, error logs, boilerplate, system metadata, or raw code snippets that appeared in the conversation
- Content that is just a truncated file snippet, stack trace, or API response — even if it contains words like "error" or "failed"
- Problem-solution pairs where the "solution" is generic boilerplate advice rather than a specific reusable fix

Be strict: when in doubt, set worth_storing to false. Only extract memories that a personal assistant would genuinely need to recall in a future session weeks later.

# Output Format

Return JSON:
{
  "memories": [
    {
      "category": "profile|preferences|entities|events|cases|patterns",
      "worth_storing": true,
      "abstract": "中文单行索引",
      "overview": "中文结构化 Markdown 摘要",
      "content": "中文完整叙述"
    }
  ]
}

Notes:
- "worth_storing" is REQUIRED for every candidate. Set to true only for genuinely valuable long-term memories.
- Output abstract, overview, and content in Simplified Chinese by default, even when the conversation contains English.
- 默认用简体中文生成 abstract、overview、content；即使对话是英文，也把普通叙述翻译成中文。
- Preserve code identifiers, API names, file paths, commands, URLs, config keys, model names, and other proper nouns exactly.
- 代码标识符、API 名、路径、命令、URL、配置键、模型名等保持原文。
- Only extract truly valuable personalized information
- If nothing worth recording, return {"memories": []}
- Maximum 5 memories per extraction
- Preferences should be aggregated by topic`;
}

export function buildDedupPrompt(
  candidateAbstract: string,
  candidateOverview: string,
  candidateContent: string,
  existingMemories: string,
): string {
  return `Determine how to handle this candidate memory.

**Candidate Memory**:
Abstract: ${candidateAbstract}
Overview: ${candidateOverview}
Content: ${candidateContent}

**Existing Similar Memories**:
${existingMemories}

Please decide:
- SKIP: Candidate memory duplicates existing memories, no need to save. Also SKIP if the candidate contains LESS information than an existing memory on the same topic (information degradation — e.g., candidate says "programming language preference" but existing memory already says "programming language preference: Python, TypeScript")
- CREATE: This is completely new information not covered by any existing memory, should be created
- MERGE: Candidate memory adds genuinely NEW details to an existing memory and should be merged
- SUPERSEDE: Candidate states that the same mutable fact has changed over time. Keep the old memory as historical but no longer current, and create a new current memory.
- SUPPORT: Candidate reinforces/confirms an existing memory in a specific context (e.g. "still prefers tea in the evening")
- CONTEXTUALIZE: Candidate adds a situational nuance to an existing memory (e.g. existing: "likes coffee", candidate: "prefers tea at night" — different context, same topic)
- CONTRADICT: Candidate directly contradicts an existing memory in a specific context (e.g. existing: "runs on weekends", candidate: "stopped running on weekends")

IMPORTANT:
- "events" and "cases" categories are independent records — they do NOT support MERGE/SUPERSEDE/SUPPORT/CONTEXTUALIZE/CONTRADICT. For these categories, only use SKIP or CREATE.
- If the candidate appears to be derived from a recall question (e.g., "Do you remember X?" / "你记得X吗？") and an existing memory already covers topic X with equal or more detail, you MUST choose SKIP.
- A candidate with less information than an existing memory on the same topic should NEVER be CREATED or MERGED — always SKIP.
- For "preferences" and "entities", use SUPERSEDE when the candidate replaces the current truth instead of adding detail or context. Example: existing "Preferred editor: VS Code", candidate "Preferred editor: Zed".
- For SUPPORT/CONTEXTUALIZE/CONTRADICT, you MUST provide a context_label from this vocabulary: general, morning, evening, night, weekday, weekend, work, leisure, summer, winter, travel.

Return JSON format:
{
  "decision": "skip|create|merge|supersede|support|contextualize|contradict",
  "match_index": 1,
  "reason": "Decision reason",
  "context_label": "evening"
}

- If decision is "merge"/"supersede"/"support"/"contextualize"/"contradict", set "match_index" to the number of the existing memory (1-based).
- Only include "context_label" for support/contextualize/contradict decisions.`;
}

export function buildMergePrompt(
  existingAbstract: string,
  existingOverview: string,
  existingContent: string,
  newAbstract: string,
  newOverview: string,
  newContent: string,
  category: string,
): string {
  return `Merge the following memory into a single coherent record with all three levels.

** Category **: ${category}

** Existing Memory:**
    Abstract: ${existingAbstract}
  Overview:
${existingOverview}
  Content:
${existingContent}

** New Information:**
    Abstract: ${newAbstract}
  Overview:
${newOverview}
  Content:
${newContent}

Requirements:
- Output abstract, overview, and content in Simplified Chinese by default.
- 默认用简体中文输出 abstract、overview、content。
- If existing or new memory text is English, translate ordinary prose to Simplified Chinese.
- 如果旧记忆或新信息是英文，普通叙述翻译成简体中文。
- Keep code identifiers, API names, file paths, commands, URLs, config keys, model names, and other proper nouns unchanged.
- 代码标识符、API 名、文件路径、命令、URL、配置键、模型名和其它专有名词保留原文。
- Remove duplicate information.
- Keep the most up-to-date details.
- Maintain a coherent narrative.

Return JSON:
  {
    "abstract": "合并后的中文单行摘要",
      "overview": "合并后的中文结构化 Markdown 概览",
        "content": "合并后的中文完整内容"
  } `;
}

export function buildLessonWorthinessPrompt(params: {
  summary: string;
  details?: string;
  source: string;
  prevention?: string;
  existingLessonsCount: number;
}): string {
  return `Evaluate whether this feedback evidence is worth creating a new preventive lesson memory.

Evidence:
- Source: ${params.source}
- Summary: ${params.summary}
${params.details ? `- Details: ${params.details}` : ""}
${params.prevention ? `- Suggested prevention: ${params.prevention}` : ""}
- Existing preventive lessons in memory: ${params.existingLessonsCount}

A preventive lesson is worth creating when:
- The failure pattern is likely to recur in future sessions
- The lesson contains concrete, actionable prevention steps
- It captures a non-obvious pitfall that would otherwise be forgotten
- The summary describes a real error or failure (not just unexpected tool output)
- The details explain WHY the failure happened (root cause, not raw content)
- The prevention is specific to this failure mode (not generic advice)

A preventive lesson is NOT worth creating when:
- It is a one-off transient issue unlikely to recur
- The evidence is too vague or generic to be actionable
- An existing lesson already covers this pattern adequately
- The details contain raw code fragments, file content, or tool output snippets instead of an actual error description
- The summary is just a truncated snippet of tool output (e.g. code lines, JSON, log lines) rather than a meaningful error summary
- The prevention is boilerplate/template text (e.g. "inspect the exact error text, retry only the narrow failing step") that applies to any error and provides no specific guidance
- The "error" is actually the tool returning unexpected but valid content (e.g. a Read tool returning file content that happens to contain the word "error")
- The evidence is just a raw error message or stack trace with no added analysis or lesson

Return JSON only:
{
  "worth_storing": true,
  "reason": "short explanation"
}`;
}
