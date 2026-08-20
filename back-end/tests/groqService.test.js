import test from "node:test";
import assert from "node:assert/strict";
import { GroqService } from "../services/groqService.js";

test("extractJsonArray unwraps a markdown code fence", () => {
  const parsed = GroqService.extractJsonArray('```json\n[{"ingredient":"water","status":"Good"}]\n```');
  assert.deepEqual(parsed, [{ ingredient: "water", status: "Good" }]);
});

test("extractJsonArray ignores prose the model wrapped around the array", () => {
  const parsed = GroqService.extractJsonArray('Sure! Here is the analysis: [{"ingredient":"salt","status":"Neutral"}] Hope this helps.');
  assert.deepEqual(parsed, [{ ingredient: "salt", status: "Neutral" }]);
});

test("extractJsonArray salvages whole objects out of a truncated array", () => {
  // What a max_tokens cut-off looks like: valid objects, then a severed tail.
  const parsed = GroqService.extractJsonArray(
    '[{"ingredient":"water","status":"Good"},{"ingredient":"sugar","status":"Ba'
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].ingredient, "water");
});

test("extractJsonArray returns null when there is no JSON at all", () => {
  assert.equal(GroqService.extractJsonArray("I'm sorry, I can't help with that."), null);
  assert.equal(GroqService.extractJsonArray(""), null);
});

test("analyze retries once when the first response is unusable, then succeeds", async () => {
  const service = new GroqService();
  const sent = [];

  service.requestCompletion = async (prompt) => {
    sent.push(prompt);
    return sent.length === 1
      ? "I am unable to analyse that."
      : '[{"ingredient":"Water","status":"Good","reason":"hydration","concerns":[]}]';
  };

  const result = await service.analyze("water, sugar");

  assert.equal(result.attempts, 2);
  assert.equal(result.analysis.length, 1);
  assert.equal(result.analysis[0].ingredient, "Water");
  assert.match(sent[1], /could not be parsed as JSON/, "the retry must carry the repair instruction");
});

test("analyze fails with a typed 502 when both attempts are unusable", async () => {
  const service = new GroqService();
  service.requestCompletion = async () => "still not JSON, sorry";

  await assert.rejects(
    () => service.analyze("water"),
    (error) => error.code === "ANALYSIS_UNAVAILABLE" && error.statusCode === 502
  );
});

test("analyze keeps the good rows when the model returns a partly malformed array", async () => {
  const service = new GroqService();
  service.requestCompletion = async () =>
    JSON.stringify([
      { ingredient: "Water", status: "Good", reason: "", concerns: [] },
      { status: "Bad" },
      { ingredient: "Sugar", status: "not-a-status", reason: "", concerns: "obesity" },
    ]);

  const result = await service.analyze("water, sugar");

  assert.equal(result.attempts, 1);
  assert.equal(result.droppedRows, 1);
  assert.deepEqual(
    result.analysis.map((row) => [row.ingredient, row.status]),
    [["Water", "Good"], ["Sugar", "Neutral"]]
  );
});

test("requestCompletionDetailed reports the provider's own token counts, and requestCompletion still returns only the content", async () => {
  // Against a real socket rather than a stubbed fetch, because the thing being
  // checked is that the `usage` block survives the HTTP round trip untouched -
  // a stub that returns the object directly would prove nothing about parsing.
  const { createServer } = await import("node:http");
  const body = {
    choices: [{ message: { content: '[{"ingredient":"water","status":"Good","reason":"","concerns":[]}]' } }],
    usage: { prompt_tokens: 1862, completion_tokens: 97, total_tokens: 1959 },
  };

  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const service = new GroqService();
    service.baseUrl = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    service.apiKey = "test-key";

    const detailed = await service.requestCompletionDetailed("prompt", 500, 5000);
    assert.deepEqual(detailed.usage, body.usage);
    assert.equal(detailed.content, body.choices[0].message.content);
    assert.equal(typeof detailed.latencyMs, "number");

    const content = await service.requestCompletion("prompt", 500, 5000);
    assert.equal(content, body.choices[0].message.content);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("usage is null, not estimated, when the endpoint does not report it", async () => {
  // scripts/stub-llm.js is exactly this case. A token count guessed from the
  // character count would read as a measurement in the eval output.
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "[]" } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const service = new GroqService();
    service.baseUrl = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    service.apiKey = "test-key";

    const detailed = await service.requestCompletionDetailed("prompt", 500, 5000);
    assert.equal(detailed.usage, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
