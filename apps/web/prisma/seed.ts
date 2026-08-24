import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

/** Matches the SDK's gpt-4o-mini entry so seeded costs look like real ones. */
const PROMPT_PRICE_PER_1K = 0.00015;
const COMPLETION_PRICE_PER_1K = 0.0006;

async function main() {
  const promptNames = ["support-bot", "sales-copilot", "code-reviewer"];

  const prompts = [];
  for (const name of promptNames) {
    let prompt = await prisma.prompt.findFirst({ where: { name, version: 1 } });
    if (!prompt) {
      prompt = await prisma.prompt.create({
        data: {
          name,
          version: 1,
          promptText: `Seed prompt for ${name}`,
          promptHash: `seed-${name}-v1`,
        },
      });
    }
    prompts.push(prompt);
  }

  const count = 30 + Math.floor(Math.random() * 11);
  const now = Date.now();
  const traces: Prisma.TraceCreateManyInput[] = [];

  for (let i = 0; i < count; i++) {
    const prompt = prompts[Math.floor(Math.random() * prompts.length)];
    const daysAgo = Math.random() * 10;
    const createdAt = new Date(
      now - daysAgo * 24 * 60 * 60 * 1000 - Math.random() * 24 * 60 * 60 * 1000
    );
    const promptTokens = Math.floor(Math.random() * 400) + 50;
    const completionTokens = Math.floor(Math.random() * 800) + 40;
    // A slice of traces stands in for calls to a model the pricing table does
    // not know, so the dashboard's "estimated cost" warning is exercised.
    const pricingUnknown = Math.random() < 0.1;

    traces.push({
      promptId: prompt.id,
      latencyMs: Math.floor(Math.random() * 3000) + 200,
      promptTokens,
      completionTokens,
      costUsd:
        Math.round(
          ((promptTokens / 1000) * PROMPT_PRICE_PER_1K +
            (completionTokens / 1000) * COMPLETION_PRICE_PER_1K) *
            1_000_000
        ) / 1_000_000,
      pricingUnknown,
      status: Math.random() < 0.8 ? "SUCCESS" : "ERROR",
      createdAt,
    });
  }

  await prisma.trace.createMany({ data: traces });
  console.log(`Seeded ${traces.length} traces across ${prompts.length} prompts`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
