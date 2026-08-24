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
