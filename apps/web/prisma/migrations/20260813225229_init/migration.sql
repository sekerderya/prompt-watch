-- CreateTable
CREATE TABLE "prompts" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "prompt_text" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ab_tests" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "prompt_name" TEXT NOT NULL,
    "variant_a_id" INTEGER NOT NULL,
    "variant_b_id" INTEGER NOT NULL,
    "split_percent" INTEGER NOT NULL DEFAULT 50,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ab_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traces" (
    "id" SERIAL NOT NULL,
    "prompt_id" INTEGER NOT NULL,
    "ab_test_id" INTEGER,
    "variant" TEXT,
    "latency_ms" INTEGER NOT NULL,
    "prompt_tokens" INTEGER NOT NULL,
    "completion_tokens" INTEGER NOT NULL,
    "cost_usd" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prompts_name_idx" ON "prompts"("name");

-- CreateIndex
CREATE UNIQUE INDEX "prompts_name_prompt_hash_key" ON "prompts"("name", "prompt_hash");

-- CreateIndex
CREATE UNIQUE INDEX "prompts_name_version_key" ON "prompts"("name", "version");

-- CreateIndex
CREATE INDEX "traces_prompt_id_created_at_idx" ON "traces"("prompt_id", "created_at");

-- CreateIndex
CREATE INDEX "traces_ab_test_id_idx" ON "traces"("ab_test_id");

-- AddForeignKey
ALTER TABLE "ab_tests" ADD CONSTRAINT "ab_tests_variant_a_id_fkey" FOREIGN KEY ("variant_a_id") REFERENCES "prompts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ab_tests" ADD CONSTRAINT "ab_tests_variant_b_id_fkey" FOREIGN KEY ("variant_b_id") REFERENCES "prompts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traces" ADD CONSTRAINT "traces_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traces" ADD CONSTRAINT "traces_ab_test_id_fkey" FOREIGN KEY ("ab_test_id") REFERENCES "ab_tests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
