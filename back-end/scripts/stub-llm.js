// scripts/stub-llm.js - A local stand-in for the chat-completions endpoint.
//
// Why this exists: every latency number in this repo has to be reproducible by
// somebody who does not have a provider key, and a profiling run that fires
// several thousand tokens at a hosted model per iteration is neither free nor
// stable enough to measure against. The stub answers the same wire shape Groq
// answers, instantly, so a profile isolates the parts of the pipeline that run
// on our own CPU - which is the part this work is about.
//
// It does NOT simulate provider latency. A number produced against this stub is
// the pipeline's own cost with the model call removed, and must be reported that
// way, never as an end-to-end user-facing latency.
//
//   node scripts/stub-llm.js [port]
//
// Then point the API at it:  GROQ_BASE_URL=http://127.0.0.1:<port>/v1/chat/completions
import http from "node:http";

/**
 * Build a reply that satisfies the grounded path's contract: every verdict
 * cites a context id that really was in the prompt. The prompt lists its
 * passages as "[C1] ...", so the ids are read back out of the prompt rather
 * than invented, and the ingredients are read from the "INGREDIENTS TO ANALYSE"
 * block. A stub that failed citation validation would send the route down the
 * retry path and measure the wrong thing.
 */
export function buildStubCompletion(prompt) {
  const ids = [...new Set([...String(prompt).matchAll(/\[(C\d+)\]/g)].map((m) => m[1]))];
  const listBlock = String(prompt).split("INGREDIENTS TO ANALYSE:")[1] || "";
  const ingredients = listBlock
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);

  const rows = ingredients.map((ingredient, index) => ({
    ingredient,
    status: index % 3 === 0 ? "Bad" : index % 3 === 1 ? "Neutral" : "Good",
    reason: "Stubbed verdict for local profiling; carries no meaning.",
    concerns: [],
    citations: ids.length > 0 ? [ids[index % ids.length]] : [],
  }));

  return JSON.stringify(rows);
}

export function createStubServer() {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let prompt = "";
      try {
        prompt = JSON.parse(body)?.messages?.[0]?.content ?? "";
      } catch {
        // A malformed body still gets a well-formed empty array back, which the
        // route treats as "no citable verdicts" rather than as a transport error.
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: buildStubCompletion(prompt) } }],
      }));
    });
  });
}

// Only listen when run directly, so the tests can import buildStubCompletion.
if (process.argv[1] && process.argv[1].endsWith("stub-llm.js")) {
  const port = Number(process.argv[2] || 5099);
  createStubServer().listen(port, "127.0.0.1", () => {
    console.log(`stub LLM listening on http://127.0.0.1:${port}/v1/chat/completions`);
  });
}
