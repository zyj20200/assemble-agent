/**
 * DB 连接（better-sqlite3，同步 API——本地 SQLite 查询微秒级，无需 async）
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.ts';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;
export type SqliteDb = Database.Database;

export const defaultDbPath = (): string => {
  const dataDir = path.join(path.dirname(fileURLToPath(new URL('../..', import.meta.url))), 'data');
  return process.env.ASSEMBLE_DB_PATH ?? path.join(dataDir, 'assemble.db');
};

/** 打开（必要时创建）数据库并应用迁移（建表） */
export function openDb(dbPath: string = defaultDbPath()): { db: AppDb; sqlite: SqliteDb } {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  // 迁移目录：drizzle-kit generate 产物
  const migrationsFolder = fileURLToPath(new URL('../../drizzle/', import.meta.url));
  migrate(db, { migrationsFolder });
  return { db, sqlite };
}

export { schema };
