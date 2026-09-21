import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    // Перевіряємо не лише ok: після першої ітерації у файлі вже є валідний
    // стан, тож saveState, який нічого не записав, теж дав би ok. Тому кожне
    // значення звіряємо з очікуваною канонічною формою.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["2026-09-10T08:00:00.000Z", "2026-09-10T08:00:00.000Z"],
      ["2026-09-10T08:00:00Z", "2026-09-10T08:00:00.000Z"],
      ["2026-09-10T08:00:00+00:00", "2026-09-10T08:00:00.000Z"],
      ["2026-09-10T11:00:00+03:00", "2026-09-10T08:00:00.000Z"],
      ["2026-09-11T06:30:00-02:00", "2026-09-11T08:30:00.000Z"],
    ];
    for (const [input, canonical] of cases) {
      expect(saveState(path, { lastSyncedAt: input }).ok, `запис зламався на ${input}`).toBe(true);
      expect(loadState(path), `round-trip зламався на ${input}`).toEqual({
        ok: true,
        value: { lastSyncedAt: canonical },
      });
      // І на диску теж саме канонічне значення, а не те, що прийшло.
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ lastSyncedAt: canonical });
    }
  });

  // Date.parse приймає неіснуючі дати й мовчки прокручує їх уперед:
  // 2026 не високосний, тож "2026-02-29" стало б "2026-03-01". Тихе
  // перетлумачення зовнішніх даних — те саме, що заборонено конвенцією 4.
  // Date.parse приймає далеко не лише ISO-8601 і мовчки все канонізує:
  // без зони бере локальний час, пробіл замість T теж «розуміє».
  it("відхиляє все, що не є ISO-8601 з явною зоною", () => {
    for (const bad of [
      "2026-09-10T08:00:00",        // без зони — локальний час
      "2026-09-10",                 // сама дата
      "2026-09-10 08:00:00Z",       // пробіл замість T
      "2026-09-10T08:00Z",          // без секунд
      "Sep 10 2026 08:00:00 UTC",   // зовсім не ISO
      "2026-09-10T08:00:00.000ZZ",  // сміття в хвості
    ]) {
      expect(saveState(path, { lastSyncedAt: bad }).ok, `пройшло: ${bad}`).toBe(false);
    }
  });

  it("приймає валідні ISO-форми з явною зоною", () => {
    for (const good of [
      "2026-09-10T08:00:00.000Z",
      "2026-09-10T08:00:00Z",
      "2026-09-10T08:00:00+00:00",
      "2026-09-10T11:00:00+0300",
    ]) {
      expect(saveState(path, { lastSyncedAt: good }).ok, `відхилено: ${good}`).toBe(true);
    }
  });

  it("відхиляє неіснуючу календарну дату замість тихого зсуву", () => {
    const result = saveState(path, { lastSyncedAt: "2026-02-29T00:00:00.000Z" });
    expect(result.ok).toBe(false);
  });

  it("високосну дату в високосний рік приймає", () => {
    const result = saveState(path, { lastSyncedAt: "2028-02-29T00:00:00.000Z" });
    expect(result.ok).toBe(true);
    expect(loadState(path)).toEqual({ ok: true, value: { lastSyncedAt: "2028-02-29T00:00:00.000Z" } });
  });

  // Шлях, заради якого існує атомарний запис: якщо writeFileSync упав
  // (повний диск, немає теки), маємо отримати Result з помилкою і не лишити
  // по собі сміття.
  it("на недоступному шляху повертає помилку і не лишає .tmp", () => {
    const missingDir = join(dir, "no-such-dir", "sync-state.json");

    const result = saveState(missingDir, { lastSyncedAt: "2026-09-10T08:00:00.000Z" });

    expect(result.ok).toBe(false);
    expect(readdirSync(dir)).not.toContain("no-such-dir");
  });

  it("не лишає тимчасового файлу після запису", () => {
    saveState(path, { lastSyncedAt: "2026-09-10T08:00:00.000Z" });
    expect(readFileSync(path, "utf8")).toContain("2026-09-10T08:00:00.000Z");
    // Ім'я тимчасового файлу містить pid і час (`<path>.<pid>.<ts>.tmp`), тож
    // перевіряти рівно `<path>.tmp` безглуздо — такого імені не буває ніколи,
    // і тест проходив би навіть із залишеним сміттям. Дивимось на теку.
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
