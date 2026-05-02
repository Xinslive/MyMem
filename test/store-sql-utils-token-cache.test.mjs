import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  normalizeSearchText,
  scoreLexicalHit,
  scoreLexicalHitPreTokenized,
  tokenSetForSearch,
} = jiti("../src/store-sql-utils.ts");

describe("store SQL lexical token cache", () => {
  it("preserves lexical scoring exactly between raw and cached pre-tokenized paths", () => {
    const query = "部署 config 乌龙茶";
    const candidates = [
      { text: "今晚部署了 config 更新，也提到乌龙茶偏好。", weight: 1 },
      { text: "unrelated operational note", weight: 0.98 },
      { text: "config deploy checklist", weight: 0.92 },
      { text: "乌龙茶", weight: 0.8 },
    ];

    const normalizedQuery = normalizeSearchText(query);
    const preTokenized = candidates.map((candidate) => {
      const normalized = normalizeSearchText(candidate.text);
      return {
        normalized,
        weight: candidate.weight,
        tokens: tokenSetForSearch(normalized),
      };
    });

    const rawScore = scoreLexicalHit(query, candidates);
    const cachedScore = scoreLexicalHitPreTokenized(
      tokenSetForSearch(normalizedQuery),
      preTokenized,
      normalizedQuery,
    );

    assert.equal(cachedScore, rawScore);
    assert.strictEqual(tokenSetForSearch(normalizedQuery), tokenSetForSearch(normalizedQuery));
  });
});
