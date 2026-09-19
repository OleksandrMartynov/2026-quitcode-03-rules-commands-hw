import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadState, saveState } from "./state.js";

describe("loadState", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lead-sync-state-"));
    path = join(dir, "sync-state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("на першому запуску повертає початковий стан", () => {
    const result = loadState(path);
    expect(result).toEqual({ ok: true, value: { lastSyncedAt: "1970-01-01T00:00:00.000Z" } });
  });

  it("читає збережений стан", () => {
    saveState(path, { lastSyncedAt: "2026-09-10T08:00:00.000Z" });
    expect(loadState(path)).toEqual({
      ok: true,
      value: { lastSyncedAt: "2026-09-10T08:00:00.000Z" },
    });
  });

  // Регресія на інцидент у ніч на 10.09.2026 (materials/error-log.txt):
  // ENOSPC обрізав файл стану, loadState тихо підставив епоху, і воркер
  // дев'ять годин перерозсилав усю базу лідів щоп'ять хвилин.
  it("на обрізаному файлі повертає помилку, а не початковий стан", () => {
    writeFileSync(path, '{"lastSync');
    const result = loadState(path);
    expect(result.ok).toBe(false);
    expect(result).not.toEqual({ ok: true, value: { lastSyncedAt: "1970-01-01T00:00:00.000Z" } });
  });

  it("на порожньому файлі повертає помилку", () => {
    writeFileSync(path, "");
    expect(loadState(path).ok).toBe(false);
  });

  it("на валідному JSON неочікуваної форми повертає помилку", () => {
    writeFileSync(path, '{"lastSyncedAt": 1757491200}');
    expect(loadState(path).ok).toBe(false);
  });
});

describe("saveState", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lead-sync-state-"));
    path = join(dir, "sync-state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("не лишає тимчасового файлу після запису", () => {
    saveState(path, { lastSyncedAt: "2026-09-10T08:00:00.000Z" });
    expect(readFileSync(path, "utf8")).toContain("2026-09-10T08:00:00.000Z");
    expect(() => readFileSync(`${path}.tmp`, "utf8")).toThrow();
  });
});
