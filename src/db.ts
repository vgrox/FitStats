import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AppConfig } from "./config.js";
import { migrateDatabase } from "./migrate.js";

export function openDatabase(config: Pick<AppConfig, "databasePath">): Database.Database {
  mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrateDatabase(db);
  return db;
}
