-- Ties a trace to an outcome the host application reports later.
ALTER TABLE "traces" ADD COLUMN "client_trace_id" TEXT;
CREATE UNIQUE INDEX "traces_client_trace_id_key" ON "traces"("client_trace_id");

-- No foreign key on purpose: an outcome can arrive before the trace it belongs
-- to, because traces are buffered and batched while outcomes are sent directly.
-- Both sides carry a unique client_trace_id and are joined on it.
CREATE TABLE "outcomes" (
    "id" SERIAL NOT NULL,
    "client_trace_id" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outcomes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outcomes_client_trace_id_key" ON "outcomes"("client_trace_id");
CREATE INDEX "outcomes_label_idx" ON "outcomes"("label");
