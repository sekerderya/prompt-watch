-- Coarse failure categories, so an error rate can be acted on. Derived from the
-- HTTP status and error class only; no message text is ever recorded.
CREATE TYPE "TraceErrorType" AS ENUM (
    'RATE_LIMIT',
    'TIMEOUT',
    'AUTH',
    'INVALID_REQUEST',
    'NOT_FOUND',
    'CONTENT_FILTER',
    'SERVER',
    'NETWORK',
    'CANCELLED',
    'UNKNOWN'
);

ALTER TABLE "traces" ADD COLUMN "error_type" "TraceErrorType";

-- Traces recorded before this column existed are failures of unknown cause.
UPDATE "traces" SET "error_type" = 'UNKNOWN' WHERE "status" = 'ERROR';
