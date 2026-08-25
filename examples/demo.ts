/**
 * examples/demo.ts
 *
 * PromptWatch — 60-second live demo.
 * Automatic prompt versioning + A/B test creation + sticky (deterministic)
 * bucketing, shown end-to-end in a single script.
 *
 * Running (from the repo root, in order):
 *   1) npm run build --workspace=packages/sdk   (once — the SDK must be compiled)
 *   2) docker compose up -d                     (the backend must be running)
 *   3) npm run demo
 *
 * The demo stops the A/B test it creates on the way out, so it can be run
 * repeatedly without leaving conflicting active tests behind.
 *
 * If OPENAI_API_KEY is set (in .env), real OpenAI calls are made.
 * If it is not set, the demo automatically falls back to a mock client with
 * deterministic delays so it never depends on the network / an API key.
 *
 * If PROMPTWATCH_API_KEY is set (in .env), the SDK uses it for authenticated
 * backend requests. If not set, auth is disabled (default for local dev).
 */

import "dotenv/config";
import OpenAI from "openai";
import {
  wrapOpenAI,
  ABCache,
  TelemetryClient,
  OutcomeClient,
  assignVariant,
  sha256,
  type ABTestConfig,
} from "@promptwatch/sdk";

const BACKEND_URL = process.env.PROMPTWATCH_BACKEND_URL ?? "http://localhost:3000";
const PROMPT_NAME = "support-agent";
const USER_QUESTION = "When will my order arrive?";

const PROMPT_V1 =
  "You are a courteous, professional customer support assistant working for Acme Inc. " +
  "Answer questions with detailed, comprehensive explanations and a formal tone.";

const PROMPT_V2 =
  "You are a friendly customer support assistant working for Acme Inc. " +
  "Answer in a short, clear and warm tone. No unnecessary elaboration.";

const SIMULATED_USERS = ["alice_42", "bob_17", "carol_08", "dave_99", "erin_31", "frank_05"];

const SDK_API_KEY = process.env.PROMPTWATCH_API_KEY;

interface VariantRow {
  variant: string | null;
  avgLatency: number | null;
  avgCost: number | null;
  avgScore: number | null;
  scored: number;
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(SDK_API_KEY ? { Authorization: `Bearer ${SDK_API_KEY}` } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function line(): void {
  console.log("─".repeat(46));
}

/** A mock client with the same shape as the real OpenAI SDK and deterministic delays. */
function createMockClient(): OpenAI {
  return {
    chat: {
      completions: {
        create: async (params: any) => {
          await sleep(180 + Math.random() * 200);
          if (params.stream === true) {
            // Streaming mode: yield several fake chunks + a synthetic usage-only chunk
            let chunkIdx = 0;
            return (async function* streamChunks() {
              // Chunk 1: first content chunk
              yield {
                choices: [
                  {
                    index: 0,
                    delta: { content: "(mock streaming) Hello, " },
                  },
                ],
              };
              // Chunk 2: second content chunk
              yield {
                choices: [
                  {
                    index: 0,
                    delta: { content: "world! " },
                  },
                ],
              };
              // Chunk 3: usage-only chunk (synthetic, no choices) — injected include_usage
              yield {
                usage: {
                  prompt_tokens: 40 + chunkIdx,
                  completion_tokens: 25 + chunkIdx,
                  total_tokens: 65 + chunkIdx,
                },
              };
              chunkIdx++;
              // Chunk 4: final content chunk with finish reason
              yield {
                choices: [
                  {
                    index: 0,
                    finish_reason: "stop",
                    delta: {
                      content: "(mock streaming response) Hello, world! How can I help?",
                    },
                  },
                ],
                usage: {
                  prompt_tokens: 50,
                  completion_tokens: 35,
                  total_tokens: 85,
                },
              };
            })();
          }
          const systemText: string =
            params.messages?.find((m: any) => m.role === "system")?.content ?? "";
          const promptTokens = Math.max(20, Math.round(systemText.length / 4));
          const completionTokens = 35 + Math.floor(Math.random() * 30);
          return {
            id: "mock-" + Math.random().toString(36).slice(2, 10),
            model: params.model ?? "gpt-4o-mini",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "(mock response) Hello, I would be happy to help you.",
                },
              },
            ],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          };
        },
      },
    },
  } as unknown as OpenAI;
}

/**
 * The SDK normally does this itself in the background (fire-and-forget) on every wrapped call.
 * Here we need the prompt's id to set up the A/B test, so we call it directly.
 */
async function resolvePromptDirect(promptText: string): Promise<{ id: number; version: number }> {
  const res = await fetch(`${BACKEND_URL}/api/prompts/resolve`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name: PROMPT_NAME, promptText, hash: sha256(promptText) }),
  });
  if (!res.ok) throw new Error(`resolve request failed: HTTP ${res.status}`);
  return res.json();
}

/** Stops every active test for a prompt, so a re-run starts from a clean slate. */
async function stopActiveTestsFor(promptName: string): Promise<number> {
  const res = await fetch(`${BACKEND_URL}/api/ab-tests?status=ACTIVE`, {
    headers: authHeaders(),
  });
  if (!res.ok) return 0;

  const active: { id: number; promptName: string }[] = await res.json();
  const mine = active.filter((t) => t.promptName === promptName);

  for (const test of mine) {
    await fetch(`${BACKEND_URL}/api/ab-tests/${test.id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ status: "STOPPED" }),
    });
  }
  return mine.length;
}

async function preflightCheck(): Promise<void> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/ab-tests/active`, {
      headers: SDK_API_KEY ? { Authorization: `Bearer ${SDK_API_KEY}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    console.error(`❌ Cannot reach the backend (${BACKEND_URL}).`);
    console.error(`   Make sure 'docker compose up -d' is running and try again.`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await preflightCheck();

  const useReal = Boolean(process.env.OPENAI_API_KEY);
  console.log("🚀 PromptWatch Demo Starting...");
  console.log(
    `📡 Mode: ${useReal ? "REAL (real OpenAI calls)" : "MOCK (OPENAI_API_KEY not set)"}\n`
  );

  const rawClient = useReal ? new OpenAI() : createMockClient();

  // Demo-specific: create our own ABCache and start it with a 2-second poll interval
  // (the production default is 30s — shortened here to fit the 60-second demo).
  const demoCache = new ABCache();
  demoCache.start(BACKEND_URL, 2000, SDK_API_KEY);

  // An explicit telemetry client so the script can flush buffered traces before
  // exiting; a short-lived process would otherwise drop whatever is still queued.
  const telemetry = new TelemetryClient(BACKEND_URL, SDK_API_KEY);
  const outcomes = new OutcomeClient(BACKEND_URL, SDK_API_KEY);

  let currentUser: string | undefined;
  // onTrace runs synchronously inside create(), before the first await, so the
  // handle can be read immediately after the call and stays correct even when
  // many calls are in flight at once.
  let pendingTrace: { traceId: string; variant?: "A" | "B" } | undefined;
  const client = wrapOpenAI(rawClient, {
    promptName: PROMPT_NAME,
    backendUrl: BACKEND_URL,
    cache: demoCache,
    telemetry,
    getDistinctId: () => currentUser,
    apiKey: SDK_API_KEY,
    onTrace: (handle) => {
      pendingTrace = { traceId: handle.traceId, variant: handle.variant };
    },
  });

  /** Starts one call and hands back the trace handle captured for it. */
  function tracedCall(userId: string): {
    trace: { traceId: string; variant?: "A" | "B" };
    done: Promise<unknown>;
  } {
    currentUser = userId;
    pendingTrace = undefined;
    const done = client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: PROMPT_V1 },
        { role: "user", content: USER_QUESTION },
      ],
    });
    if (!pendingTrace) throw new Error("onTrace did not fire synchronously");
    return { trace: pendingTrace, done };
  }

  line();
  console.log("1️⃣  AUTOMATIC VERSIONING");
  line();

  console.log("→ Sending the first system prompt...");
  const v1 = await resolvePromptDirect(PROMPT_V1);
  await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: PROMPT_V1 },
      { role: "user", content: USER_QUESTION },
    ],
  });
  console.log(`✅ "${PROMPT_NAME}" saved as v${v1.version} (id: ${v1.id})`);
  console.log(`   "${PROMPT_V1.slice(0, 55)}..."\n`);

  console.log("→ The prompt text was changed (friendlier tone), sending again...");
  const v2 = await resolvePromptDirect(PROMPT_V2);
  await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: PROMPT_V2 },
      { role: "user", content: USER_QUESTION },
    ],
  });
  console.log(`✅ "${PROMPT_NAME}" automatically versioned as v${v2.version} (id: ${v2.id})`);
  console.log(`   "${PROMPT_V2.slice(0, 55)}..."`);
  console.log(
    "   → No manual 'save version' step exists; the SDK compares the hash and opens a new version itself.\n"
  );

  line();
  console.log("2️⃣  CREATING AN A/B TEST");
  line();

  const createABTest = () =>
    fetch(`${BACKEND_URL}/api/ab-tests`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        name: "support-agent-tone-test",
        promptName: PROMPT_NAME,
        variantAId: v1.id,
        variantBId: v2.id,
        splitPercent: 50,
      }),
    });

  let abTestRes = await createABTest();

  // The backend allows only one active test per prompt. Older data may contain
  // several (the rule did not exist yet), so clear all of them, not just the
  // one named in the conflict, before retrying.
  if (abTestRes.status === 409) {
    await abTestRes.body?.cancel();
    const stopped = await stopActiveTestsFor(PROMPT_NAME);
    console.log(`ℹ Stopped ${stopped} leftover active test(s) for "${PROMPT_NAME}".`);
    abTestRes = await createABTest();
  }

  if (!abTestRes.ok) {
    const detail = await abTestRes.text();
    throw new Error(`Could not create A/B test: HTTP ${abTestRes.status} ${detail}`);
  }
  const createdTest = await abTestRes.json();

  console.log(
    `✅ "support-agent-tone-test" created → v${v1.version} (A) vs v${v2.version} (B), 50/50`
  );
  console.log("⏳ Waiting a few seconds for the SDK to sync it in the background...\n");
  await sleep(2500);

  line();
  console.log("3️⃣  DIFFERENT USERS, STICKY (DETERMINISTIC) BUCKETING");
  line();

  const displayConfig: ABTestConfig = {
    id: createdTest.id,
    promptName: PROMPT_NAME,
    variantAId: v1.id,
    variantAText: PROMPT_V1,
    variantBId: v2.id,
    variantBText: PROMPT_V2,
    splitPercent: 50,
  };

  for (const userId of SIMULATED_USERS) {
    currentUser = userId;
    // NOTE: The system content we write here does not matter — because an active A/B test
    // exists, the SDK automatically replaces the text sent to OpenAI with the chosen variant.
    // assignVariant() is used here ONLY for printing to the console; it is exactly the same
    // computation the SDK does internally (deterministic — same testId + userId always yields
    // the same result).
    const preview = assignVariant(displayConfig, userId);
    await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: PROMPT_V1 },
        { role: "user", content: USER_QUESTION },
      ],
    });
    console.log(
      `👤 ${userId.padEnd(12)} → Variant ${preview.variant} (v${
        preview.variant === "A" ? v1.version : v2.version
      })`
    );
  }

  line();
  console.log("4️⃣  OUTCOME-DRIVEN QUALITY COMPARISON");
  line();
  console.log(
    "→ Cost and latency come for free, but only the application knows whether an"
  );
  console.log("  answer was any good. Simulating real traffic that reports back:\n");

  // Stand-in for whatever the real signal is: a thumbs-up, a resolved ticket, a
  // grader's verdict. Here the friendlier variant genuinely satisfies more users.
  const SUCCESS_RATE: Record<"A" | "B", number> = { A: 0.55, B: 0.78 };
  const TRAFFIC = 160;
  const CONCURRENCY = 20;

  let recorded = 0;
  for (let start = 0; start < TRAFFIC; start += CONCURRENCY) {
    const batch = [];
    for (let i = start; i < Math.min(start + CONCURRENCY, TRAFFIC); i++) {
      const { trace, done } = tracedCall(`sim_user_${i}`);
      batch.push({ trace, done });
    }
    await Promise.all(batch.map((b) => b.done));

    const scored = batch
      .filter((b) => b.trace.variant)
      .map((b) => ({
        traceId: b.trace.traceId,
        score: Math.random() < SUCCESS_RATE[b.trace.variant as "A" | "B"] ? 1 : 0,
        label: "resolved",
      }));
    if (await outcomes.recordMany(scored)) recorded += scored.length;
    process.stdout.write(`
   ${Math.min(start + CONCURRENCY, TRAFFIC)}/${TRAFFIC} calls, ${recorded} outcomes recorded`);
  }
  console.log("\n");

  // Traces are batched; flush before asking the backend to aggregate them.
  await telemetry.flush();

  const comparison = await fetch(
    `${BACKEND_URL}/api/metrics/ab-test-comparison?id=${createdTest.id}`,
    { headers: authHeaders() }
  ).then((r) => r.json());

  for (const row of comparison as VariantRow[]) {
    if (!row.variant) continue;
    const quality = row.avgScore === null ? "n/a" : `${(row.avgScore * 100).toFixed(1)}%`;
    console.log(
      `   Variant ${row.variant}: quality ${quality.padStart(6)} ` +
        `(${row.scored} scored) · ${Math.round(row.avgLatency ?? 0)}ms · ` +
        `$${(row.avgCost ?? 0).toFixed(6)}/call`
    );
  }
  console.log(
    "\n   → The dashboard declares a winner only if this gap survives a" +
      "\n     significance test at n ≥ 30 per variant. Open the A/B Tests page.\n"
  );

  line();
  console.log("5️⃣  STREAMING SUPPORT");
  line();
  console.log("→ Making a stream:true call and consuming the chunks with for-await:");
  const streamParams = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: PROMPT_V1 },
      { role: "user", content: USER_QUESTION },
    ],
    stream: true,
  };
  let chunkCount = 0;
  const stream = await client.chat.completions.create(streamParams as any);
  for await (const chunk of stream) {
    chunkCount++;
    // Skip the usage-only chunk (usage present, no choices); a real streaming
    // response carries choices on every content chunk.
    if (chunk.usage && !Array.isArray(chunk.choices)) continue;
    console.log(
      `   chunk #${chunkCount}: ${JSON.stringify(
        chunk.choices?.[0]?.delta?.content?.slice(0, 30) || "(no content)"
      )}`
    );
  }
  console.log(`   Total chunks received: ${chunkCount}\n`);

  line();
  console.log("6️⃣  STOPPING THE TEST");
  line();
  // Leaving the test ACTIVE would make a second `npm run demo` collide with it:
  // the backend now rejects a second active test for the same prompt.
  const stopRes = await fetch(`${BACKEND_URL}/api/ab-tests/${createdTest.id}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ status: "STOPPED" }),
  });
  if (stopRes.ok) {
    console.log(`✅ "support-agent-tone-test" stopped — the demo is re-runnable.`);
    console.log("   Restart it any time from the A/B Tests page.\n");
  } else {
    console.warn(`⚠ Could not stop the test (HTTP ${stopRes.status}). Stop it from the dashboard.`);
  }

  // Flush buffered telemetry before exiting, so the dashboard has every trace.
  await telemetry.flush();
  demoCache.stop();

  // versioning (2) + bucketing (6) + simulated traffic + streaming (1)
  const traceCount = 2 + SIMULATED_USERS.length + TRAFFIC + 1;
  line();
  console.log(
    `✅ DEMO COMPLETE — ${traceCount} traces, ${recorded} outcomes, ` +
      `2 prompt versions, 1 completed A/B test`
  );
  console.log(`👉 Dashboard: ${BACKEND_URL}`);
  line();
}

main().catch((err) => {
  console.error("\n❌ Demo failed:", err);
  process.exit(1);
});