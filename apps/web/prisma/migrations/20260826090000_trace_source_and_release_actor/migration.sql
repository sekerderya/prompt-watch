-- Which of the three sources supplied the prompt a call actually sent. Without
-- this the tool cannot answer "did my release reach anything", which is the
-- first question after promoting a version.
CREATE TYPE "PromptSource" AS ENUM ('LOCAL', 'REGISTRY', 'AB_TEST');

ALTER TABLE "traces" ADD COLUMN "prompt_source" "PromptSource";
ALTER TABLE "traces" ADD COLUMN "release_id" INTEGER;

-- Traces recorded before this column existed can still be classified for the
-- A/B case, which is the only one the old schema captured unambiguously.
UPDATE "traces" SET "prompt_source" = 'AB_TEST' WHERE "ab_test_id" IS NOT NULL;

ALTER TABLE "traces"
    ADD CONSTRAINT "traces_release_id_fkey"
    FOREIGN KEY ("release_id") REFERENCES "prompt_releases"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "traces_release_id_idx" ON "traces"("release_id");

-- The drill-down asks for the newest calls of one prompt. Ordering by id needs
-- it in the index, or Postgres scans the table and sorts - the same cost
-- keyset pagination exists to avoid.
CREATE INDEX "traces_prompt_id_id_idx" ON "traces"("prompt_id", "id");

-- Who promoted a version. Self-declared: with a single shared secret there is
-- no identity to authenticate, so this is attribution for humans (ADR-13).
ALTER TABLE "prompt_releases" ADD COLUMN "actor" TEXT;
