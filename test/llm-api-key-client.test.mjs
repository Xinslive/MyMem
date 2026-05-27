import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createLlmClient } = jiti("../src/llm-client.ts");
const { LLM_EXTRACTION_SCHEMA } = jiti("../src/llm-output-schemas.ts");

describe("LLM api-key client", () => {
  let server;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  it("uses chat.completions.create semantics with the provided api-key configuration", async () => {
    let requestHeaders;
    let requestBody;

    server = http.createServer(async (req, res) => {
      requestHeaders = req.headers;

      let body = "";
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: "{\"memories\":[]}",
            },
          },
        ],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "gpt-4o-mini",
      baseURL: `http://127.0.0.1:${port}/v1`,
      timeoutMs: 4321,
    });

    const result = await llm.completeJson("hello", "api-key-probe");
    assert.deepEqual(result, { memories: [] });
    assert.equal(requestHeaders.authorization, "Bearer test-api-key");
    assert.equal(requestBody.model, "gpt-4o-mini");
    assert.deepEqual(requestBody.messages, [
      {
        role: "system",
        content: "You are a memory extraction assistant. Always respond with valid JSON only.",
      },
      {
        role: "user",
        content: "hello",
      },
    ]);
    assert.equal(requestBody.temperature, 0.1);
  });

  it("retries transient provider failures", async () => {
    let requestCount = 0;

    server = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Drain request body before responding.
      }
      requestCount++;
      if (requestCount === 1) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "try again later" } }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: "{\"memories\":[]}",
            },
          },
        ],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const logs = [];
    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "gpt-4o-mini",
      baseURL: `http://127.0.0.1:${port}/v1`,
      log: (message) => logs.push(message),
    });

    const result = await llm.completeJson("hello", "api-key-retry");
    assert.deepEqual(result, { memories: [] });
    assert.equal(requestCount, 2);
    assert.ok(logs.some((message) => message.includes("transient request failure")));
  });

  it("rejects JSON that does not match the requested schema", async () => {
    server = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Drain request body before responding.
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: "{\"memories\":\"not-an-array\"}",
            },
          },
        ],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "gpt-4o-mini",
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    assert.equal(
      await llm.completeJson("hello", "api-key-schema", LLM_EXTRACTION_SCHEMA),
      null,
    );
    assert.match(llm.getLastError() || "", /schema validation failed/);
  });

  it("limits concurrent provider requests across client calls", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    server = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Drain request body before responding.
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight -= 1;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: "{\"memories\":[]}",
            },
          },
        ],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "gpt-4o-mini",
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    await Promise.all([
      llm.completeJson("one", "limited-one"),
      llm.completeJson("two", "limited-two"),
      llm.completeJson("three", "limited-three"),
      llm.completeJson("four", "limited-four"),
    ]);

    assert.equal(maxInFlight, 2);
  });
});
