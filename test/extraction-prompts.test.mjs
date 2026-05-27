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
    assert.match(prompt, /abstract and content in Simplified Chinese by default/);
    assert.match(prompt, /默认用简体中文生成 abstract、content/);
    assert.match(prompt, /one complete, information-rich sentence/);
    assert.match(prompt, /不要追求过度简洁/);
    assert.match(prompt, /Never begin abstract with "Skill:"/);
    assert.doesNotMatch(prompt, /Target Output Language: auto/);
    assert.match(prompt, /用户基本信息/);
    assert.match(prompt, /Python 代码风格/);
  });

  it("does not attribute assistant suggestions as user preferences", () => {
    const prompt = buildExtractionPrompt(
      [
        "user: 我有点困惑，笔记太乱了。",
        "assistant: 建议你按项目标签整理笔记。",
      ].join("\n"),
      "User",
    );

    assert.match(prompt, /Assistant\/agent suggestions, recommendations, proposed plans, or advice/);
    assert.match(prompt, /NOT user preferences, intentions, or decisions/);
    assert.match(prompt, /unless the user explicitly accepts, confirms, or restates them as their own/);
    assert.match(prompt, /不能写成“用户想要\/偏好\/决定”/);
    assert.match(prompt, /只有用户明确说“对\/就按这个\/我想这样\/记住我偏好这样”/);
    assert.match(prompt, /If the user asks for help or expresses confusion/);
    assert.match(prompt, /Do NOT convert the assistant's advice into "the user wants\/prefers\/plans X"/);
    assert.match(prompt, /Assistant suggests X/);
    assert.match(prompt, /助手建议用户按项目标签整理笔记，这不是用户偏好/);
  });

  it("treats explicit remember requests as strong storage signals", () => {
    const prompt = buildExtractionPrompt("User: 记住我喜欢乌龙茶。", "User");

    assert.match(prompt, /Explicit capture intent/);
    assert.match(prompt, /treat it as a strong storage signal/);
    assert.match(prompt, /Store the underlying durable fact/);
    assert.match(prompt, /记住我喜欢乌龙茶/);
  });

  it("keeps technical identifiers unchanged in extraction and merge prompts", () => {
    const extractionPrompt = buildExtractionPrompt("User: Use LanceDB with Number(...).", "User");
    assert.match(extractionPrompt, /code identifiers, API names, file paths, commands, URLs, config keys, model names/);

    const mergePrompt = buildMergePrompt(
      "Python code style",
      "Use LanceDB and Number(...).",
      "Python code style",
      "Use Number(...) before arithmetic.",
      "patterns",
    );
    assert.match(mergePrompt, /Output abstract and content in Simplified Chinese by default/);
    assert.match(mergePrompt, /默认用简体中文输出 abstract、content/);
    assert.match(mergePrompt, /abstract must be one complete, information-rich sentence/);
    assert.match(mergePrompt, /不要过度压缩导致信息丢失/);
    assert.match(mergePrompt, /translate ordinary prose to Simplified Chinese/);
    assert.match(mergePrompt, /Keep code identifiers, API names, file paths, commands, URLs, config keys, model names/);
    assert.match(mergePrompt, /代码标识符、API 名、文件路径、命令、URL、配置键、模型名/);
  });
});
