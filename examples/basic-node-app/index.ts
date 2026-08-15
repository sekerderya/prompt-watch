import path from "node:path";
import { config as loadEnv } from "dotenv";
import OpenAI from "openai";
import { ABCache, TelemetryClient, wrapOpenAI } from "@promptwatch/sdk";

loadEnv({ path: path.resolve(process.cwd(), "../../.env") });

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY not found, check your .env file");
  process.exit(1);
}

const backendUrl = process.env.PROMPTWATCH_BACKEND_URL ?? "http://localhost:3000";
const promptName = "basic-node-app";
const systemPrompt = "You are the demo assistant for the basic-node-app.";

const cache = new ABCache();
cache.start(backendUrl, 30_000);
const telemetry = new TelemetryClient(backendUrl);

const userIds = ["user-alice", "user-bob", "user-carol"];
let userIndex = 0;

const client = wrapOpenAI(new OpenAI({ apiKey }), {
  promptName,
  backendUrl,
  cache,
  telemetry,
  getDistinctId: () => userIds[userIndex % userIds.length],
});

const questions = ["Hello! What is this project?", "What does it do in one line?", "Thanks!"];

for (let i = 0; i < questions.length; i++) {
  const distinctId = userIds[userIndex % userIds.length];
  userIndex++;
  try {
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${questions[i]} (distinctId: ${distinctId})` },
      ],
    });
    console.log(`Answer ${i + 1} [${distinctId}]:`, res.choices[0]?.message.content);
  } catch (err) {
    console.error(`Call ${i + 1} failed:`, (err as Error)?.message ?? err);
  }
}

await telemetry.flush();
cache.stop();
console.log("Script finished, telemetry flushed.");
process.exit(0);