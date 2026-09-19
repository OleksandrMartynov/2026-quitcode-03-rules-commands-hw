import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  // Рядок, який проходить isString, але не є датою: без перевірки формату
  // порівняння lead.createdAt > state.lastSyncedAt мовчки дало б хибний набір.
  it("на рядку, що не є ISO-датою, повертає помилку", () => {
    writeFileSync(path, '{"lastSyncedAt": "garbage"}');
    expect(loadState(path).ok).toBe(false);
  });

  it("на неканонічній, але розбірній даті повертає помилку", () => {
    writeFileSync(path, '{"lastSyncedAt": "2026-09-10"}');
    expect(loadState(path).ok).toBe(false);
  });

  it("на нечитабельному шляху повертає помилку, а не початковий стан", () => {
    // Тека замість файлу: existsSync каже «є», readFileSync кидає EISDIR.
    const asDir = join(dir, "state-as-dir");
    mkdirSync(asDir);
    const result = loadState(asDir);
    expect(result.ok).toBe(false);
    expect(result).not.toEqual({ ok: true, value: { lastSyncedAt: "1970-01-01T00:00:00.000Z" } });
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

  // F1: saveState і loadState мають домовитись про формат. Lead.createdAt —
  // зовнішні дані з форми; "2026-09-10T08:00:00Z" (без мілісекунд) — валідний
  // ISO-8601 UTC, але не канонічний toISOString(). Якщо saveState запише його
  // як є, наступний loadState його відкине, і синхронізація стане назавжди.
  it("записане через saveState завжди читається назад через loadState", () => {
    for (const value of [
      "2026-09-10T08:00:00.000Z",
      "2026-09-10T08:00:00Z",
      "2026-09-10T08:00:00+00:00",
      "2026-09-10T11:00:00+03:00",
    ]) {
      saveState(path, { lastSyncedAt: value });
      const back = loadState(path);
      expect(back.ok, `round-trip зламався на ${value}`).toBe(true);
    }
  });

  it("не лишає тимчасового файлу після запису", () => {
    saveState(path, { lastSyncedAt: "2026-09-10T08:00:00.000Z" });
    expect(readFileSync(path, "utf8")).toContain("2026-09-10T08:00:00.000Z");
    expect(() => readFileSync(`${path}.tmp`, "utf8")).toThrow();
  });
});
