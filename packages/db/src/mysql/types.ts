import type { Prisma, PrismaClient } from "../generated/prisma-mysql/client.js";

export type MysqlClient = PrismaClient;
export type MysqlTransactionClient = Prisma.TransactionClient;
