import { PrismaClient } from "@prisma/client";

/**
 * One PrismaClient for the whole process.
 *
 * Each route module used to construct its own, which in development leaked a
 * new client (and a new connection pool) on every hot reload, and in production
 * left one pool per route file rather than one per process. Caching on
 * globalThis in every environment keeps it to a single pool either way.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();

globalForPrisma.prisma = prisma;

/**
 * Settings for the transactions that take a `pg_advisory_xact_lock`.
 *
 * Those transactions queue behind each other while holding a pool connection,
 * so Prisma's default 2-second wait to *start* a transaction is too short: a
 * burst of concurrent writes for the same prompt made later requests fail with
 * P2028 ("Unable to start a transaction in the given time") instead of waiting
 * their turn. The work inside each lock is a single round trip; the wait is the
 * only thing that needed room.
 */
export const LOCKED_TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 20_000 };
