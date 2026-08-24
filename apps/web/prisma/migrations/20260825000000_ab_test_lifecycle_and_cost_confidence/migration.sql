-- Status columns become real enums so an invalid value cannot reach the table.
CREATE TYPE "ABTestStatus" AS ENUM ('ACTIVE', 'STOPPED');
CREATE TYPE "TraceStatus" AS ENUM ('SUCCESS', 'ERROR');

-- ab_tests.status: text -> ABTestStatus
ALTER TABLE "ab_tests" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ab_tests"
  ALTER COLUMN "status" TYPE "ABTestStatus" USING "status"::"ABTestStatus";
ALTER TABLE "ab_tests" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

-- A test can now be ended; record when.
ALTER TABLE "ab_tests" ADD COLUMN "ended_at" TIMESTAMP(3);

-- traces.status: text -> TraceStatus
ALTER TABLE "traces"
  ALTER COLUMN "status" TYPE "TraceStatus" USING "status"::"TraceStatus";

-- Distinguishes a measured cost from one derived via fallback pricing.
ALTER TABLE "traces"
  ADD COLUMN "pricing_unknown" BOOLEAN NOT NULL DEFAULT false;

-- The daily rollup filters on created_at alone; traces_prompt_id_created_at_idx
-- cannot serve that scan.
CREATE INDEX "traces_created_at_idx" ON "traces"("created_at");

-- Supports both the SDK's active-test poll and the duplicate-active-test check.
CREATE INDEX "ab_tests_prompt_name_status_idx" ON "ab_tests"("prompt_name", "status");
