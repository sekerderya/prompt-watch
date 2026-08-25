/**
 * Prunes telemetry older than PROMPTWATCH_RETENTION_DAYS (default 90).
 *
 *   npm run retention --workspace=apps/web
 *
 * Intended to run on a schedule. With the compose stack:
 *
 *   0 4 * * *  docker compose exec -T web npm run retention
 */
import { applyRetention, retentionDays } from "../lib/retention";
import { prisma } from "../lib/prisma";

async function main() {
  const days = retentionDays();
  if (days === null) {
    console.log("Retention disabled (PROMPTWATCH_RETENTION_DAYS <= 0); nothing deleted.");
    return;
  }

  console.log(`Pruning telemetry older than ${days} day(s)...`);
  const result = await applyRetention(days);
  console.log(
    `Done. cutoff=${result!.cutoff} traces=${result!.tracesDeleted} ` +
      `orphanOutcomes=${result!.orphanOutcomesDeleted}`
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
