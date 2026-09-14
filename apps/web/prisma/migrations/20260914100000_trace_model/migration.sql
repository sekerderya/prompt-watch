-- The model alias the caller requested for each call.
--
-- Nullable rather than defaulted: a trace written by an SDK build from before
-- this column existed genuinely does not know which model it used, and an
-- invented default would make those rows indistinguishable from measured ones.
-- Comparisons therefore exclude NULL rather than guessing.
ALTER TABLE "traces" ADD COLUMN "model" TEXT;
