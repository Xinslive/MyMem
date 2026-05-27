import { Type } from "@sinclair/typebox";

export const LLM_EXTRACTION_SCHEMA = Type.Object({
  memories: Type.Array(Type.Object({
    category: Type.String(),
    worth_storing: Type.Optional(Type.Boolean()),
    abstract: Type.String(),
    content: Type.String(),
  })),
});

export const LLM_DEDUP_DECISION_SCHEMA = Type.Object({
  decision: Type.String(),
  reason: Type.String(),
  match_index: Type.Optional(Type.Number()),
});

export const LLM_MERGE_MEMORY_SCHEMA = Type.Object({
  abstract: Type.String(),
  content: Type.String(),
});

export const LLM_ADMISSION_UTILITY_SCHEMA = Type.Object({
  utility: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.String()),
});

export const LLM_LESSON_WORTHINESS_SCHEMA = Type.Object({
  worth_storing: Type.Optional(Type.Boolean()),
  reason: Type.Optional(Type.String()),
});

export const LLM_MEMORY_UPGRADE_SCHEMA = Type.Object({
  summary: Type.String(),
  content: Type.String(),
  resolved_category: Type.Optional(Type.String()),
});

export const LLM_COMPACTION_REFINEMENT_SCHEMA = Type.Object({
  abstract: Type.String(),
  content: Type.String(),
  category: Type.String(),
  importance: Type.Number(),
  reason: Type.Optional(Type.String()),
});
