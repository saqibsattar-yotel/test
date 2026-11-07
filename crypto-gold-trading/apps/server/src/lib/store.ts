/**
 * Tiny JSON document store with atomic writes (tmp file + rename), mirroring the
 * reference project's local-state approach. Each collection is one file in DATA_DIR.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { logger } from "./logger";

const log = logger("store");

export class JsonStore<T> {
  private file: string;
  private data: T | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(name: string, private readonly initial: () => T) {
    this.file = path.join(config.dataDir, `${name}.json`);
  }

  async load(): Promise<T> {
    if (this.data !== null) return this.data;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      this.data = JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`Could not read ${this.file}; starting fresh`, err);
      this.data = this.initial();
    }
    return this.data!;
  }

  async save(next: T): Promise<void> {
    this.data = next;
    const json = JSON.stringify(next, null, 2);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, json, "utf8");
      await fs.rename(tmp, this.file);
    });
    await this.writing;
  }

  async update(fn: (current: T) => T | Promise<T>): Promise<T> {
    const current = await this.load();
    const next = await fn(current);
    await this.save(next);
    return next;
  }
}
