import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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
  const traces = [];

  for (let i = 0; i < count; i++) {
    const prompt = prompts[Math.floor(Math.random() * prompts.length)];
    const daysAgo = Math.random() * 10;
    const createdAt = new Date(
      now - daysAgo * 24 * 60 * 60 * 1000 - Math.random() * 24 * 60 * 60 * 1000
    );
    const status = Math.random() < 0.8 ? "SUCCESS" : "ERROR";
    const promptTokens = Math.floor(Math.random() * 400) + 50;
    const completionTokens = Math.floor(Math.random() * 800) + 40;

    traces.push({
      promptId: prompt.id,
      latencyMs: Math.floor(Math.random() * 3000) + 200,
      promptTokens,
      completionTokens,
      costUsd: Math.round(
        ((promptTokens / 1000) * 0.0025 + (completionTokens / 1000) * 0.0015) * 100000
      ) / 100000,
      status,
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