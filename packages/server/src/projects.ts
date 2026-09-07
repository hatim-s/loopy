import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

import type { ProjectRecord, ProjectSummary } from "@loopy/contracts";

export type { ProjectRecord, ProjectSummary } from "@loopy/contracts";
export type ProjectManager = {
  list(): Promise<{ current: string; projects: ProjectSummary[] }>;
  open(path: string): Promise<{ url: string; project: ProjectRecord }>;
  forget(id: string): void;
};
export function projectPath(path: string) {
  if (!isAbsolute(path)) throw new Error("Choose an absolute project directory path");
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error("Project path must be a directory");
  return canonical;
}
export function createProjectCatalog(home: string) {
  function access<T>(callback: (db: Database) => T): T {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = resolve(home, "projects.sqlite");
    const db = new Database(file, { create: true });
    try {
      chmodSync(file, 0o600);
      db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL");
      db.exec(
        "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, lastOpened TEXT NOT NULL)",
      );
      return callback(db);
    } finally {
      db.close();
    }
  }
  return {
    remember(path: string): ProjectRecord {
      const canonical = projectPath(path);
      const record = {
        id: createHash("sha256").update(canonical).digest("hex").slice(0, 24),
        name: basename(canonical) || canonical,
        path: canonical,
        lastOpened: new Date().toISOString(),
      };
      return access((db) => {
        db.query(
          "INSERT INTO projects (id, name, path, lastOpened) VALUES ($id,$name,$path,$lastOpened) ON CONFLICT(id) DO UPDATE SET lastOpened=excluded.lastOpened",
        ).run({
          $id: record.id,
          $name: record.name,
          $path: record.path,
          $lastOpened: record.lastOpened,
        });
        return record;
      });
    },
    list(): ProjectRecord[] {
      return access((db) =>
        db.query<ProjectRecord, []>("SELECT * FROM projects ORDER BY lastOpened DESC, id").all(),
      );
    },
    forget(id: string) {
      access((db) => db.query("DELETE FROM projects WHERE id=?").run(id));
    },
  };
}
