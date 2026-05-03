import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { buildExtractionPrompt, buildMergePrompt } = jiti("../src/extraction-prompts.ts");

describe("extraction prompts", () => {
  it("defaults memory extraction output to Simplified Chinese", () => {
    const prompt = buildExtractionPrompt("User: I prefer short answers.", "User");
    assert.match(prompt, /Target Output Language: Simplified Chinese by default/);
    assert.match(prompt, /默认使用简体中文输出记忆文本/);
    assert.match(prompt, /abstract, overview, and content in Simplified Chinese by default/);
    assert.match(prompt, /默认用简体中文生成 abstract、overview、content/);
    assert.doesNotMatch(prompt, /Target Output Language: auto/);
    assert.match(prompt, /用户基本信息/);
    assert.match(prompt, /Python 代码风格/);
  });

  it("keeps technical identifiers unchanged in extraction and merge prompts", () => {
    const extractionPrompt = buildExtractionPrompt("User: Use LanceDB with Number(...).", "User");
    assert.match(extractionPrompt, /code identifiers, API names, file paths, commands, URLs, config keys, model names/);

    const mergePrompt = buildMergePrompt(
      "Python code style",
      "- No type hints",
      "Use LanceDB and Number(...).",
      "Python code style",
      "- Keep Number(...)",
      "Use Number(...) before arithmetic.",
      "patterns",
    );
    assert.match(mergePrompt, /Output abstract, overview, and content in Simplified Chinese by default/);
    assert.match(mergePrompt, /默认用简体中文输出 abstract、overview、content/);
    assert.match(mergePrompt, /translate ordinary prose to Simplified Chinese/);
    assert.match(mergePrompt, /Keep code identifiers, API names, file paths, commands, URLs, config keys, model names/);
    assert.match(mergePrompt, /代码标识符、API 名、文件路径、命令、URL、配置键、模型名/);
  });
});
