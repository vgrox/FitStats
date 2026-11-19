import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

export function migrateDatabase(db: Database.Database, migrationsDirectory = path.resolve(process.cwd(), "migrations")): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const migrationFiles = readdirSync(migrationsDirectory)
    .filter((filename) => /^\d+_.+\.sql$/.test(filename))
    .sort();

  const applied = db.prepare("SELECT checksum FROM schema_migrations WHERE name = ?");
  const record = db.prepare(
    "INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)"
  );

  const applyAll = db.transaction(() => {
    for (const filename of migrationFiles) {
      const sql = readFileSync(path.join(migrationsDirectory, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = applied.get(filename) as { checksum: string } | undefined;
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(`Migration ${filename} was modified after it was applied. Add a new migration instead.`);
        }
        continue;
      }
      db.exec(sql);
      record.run(filename, checksum, new Date().toISOString());
    }
  });

  applyAll();
}
