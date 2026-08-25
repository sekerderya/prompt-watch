-- The prompt registry: an append-only record of which version is served.
CREATE TYPE "ReleaseSource" AS ENUM ('AB_TEST_WINNER', 'MANUAL', 'ROLLBACK');

CREATE TABLE "prompt_releases" (
    "id" SERIAL NOT NULL,
    "prompt_name" TEXT NOT NULL,
    "prompt_id" INTEGER NOT NULL,
    "source" "ReleaseSource" NOT NULL,
    "reason" TEXT,
    "ab_test_id" INTEGER,
    "evidence" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_releases_pkey" PRIMARY KEY ("id")
);

-- No unique "is current" flag exists: the live release is the newest row for a
-- prompt name, so this index serves both the SDK poll and the UI badges.
CREATE INDEX "prompt_releases_prompt_name_created_at_idx"
    ON "prompt_releases"("prompt_name", "created_at");

ALTER TABLE "prompt_releases"
    ADD CONSTRAINT "prompt_releases_prompt_id_fkey"
    FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
