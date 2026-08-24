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
 *   3) npm run demo                             (the script to add to the root package.json)
 *
 *      Add the following script to the root package.json:
 *        "demo": "tsx examples/demo.ts"
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
import { wrapOpenAI, ABCache, assignVariant, sha256, type ABTestConfig } from "@promptwatch/sdk";

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
    headers: {
      "Content-Type": "application/json",
      ...(SDK_API_KEY ? { Authorization: `Bearer ${SDK_API_KEY}` } : {}),
    },
    body: JSON.stringify({ name: PROMPT_NAME, promptText, hash: sha256(promptText) }),
  });
  if (!res.ok) throw new Error(`resolve request failed: HTTP ${res.status}`);
  return res.json();
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

  let currentUser: string | undefined;
  const client = wrapOpenAI(rawClient, {
    promptName: PROMPT_NAME,
    backendUrl: BACKEND_URL,
    cache: demoCache,
    getDistinctId: () => currentUser,
    apiKey: SDK_API_KEY,
  });

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

  const abTestRes = await fetch(`${BACKEND_URL}/api/ab-tests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(SDK_API_KEY ? { Authorization: `Bearer ${SDK_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      name: "support-agent-tone-test",
      promptName: PROMPT_NAME,
      variantAId: v1.id,
      variantBId: v2.id,
      splitPercent: 50,
    }),
  });
  if (!abTestRes.ok) throw new Error(`Could not create A/B test: HTTP ${abTestRes.status}`);
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
  console.log(
    `✅ DEMO COMPLETE — produced ${2 + SIMULATED_USERS.length} traces, 2 prompt versions, 1 active A/B test`
  );
  console.log(`👉 Dashboard: ${BACKEND_URL}`);
  line();

  demoCache.stop();
}

main().catch((err) => {
  console.error("\n❌ Demo failed:", err);
  process.exit(1);
});