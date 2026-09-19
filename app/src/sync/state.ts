// Стан синхронізації між запусками: ліди, створені після lastSyncedAt, ще не розіслані.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { isRecord, isString, parseJson } from "../core/parse.js";
import type { Result } from "../core/types.js";

export interface SyncState {
  /** ISO-8601, UTC. */
  lastSyncedAt: string;
}

const INITIAL_STATE: SyncState = { lastSyncedAt: "1970-01-01T00:00:00.000Z" };

/**
 * `lastSyncedAt` має бути канонічним ISO-8601 в UTC. Самого `isString` замало:
 * рядок на кшталт "garbage" пройшов би перевірку, а далі порівняння
 * `lead.createdAt > state.lastSyncedAt` мовчки дало б хибний набір лідів —
 * рівно той клас тихої помилки, через який стався інцидент.
 */
const isIsoUtc = (value: unknown): value is string =>
  isString(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

const isSyncState = (value: unknown): value is SyncState =>
  isRecord(value) && isIsoUtc(value.lastSyncedAt);

/**
 * Читає файл стану.
 *
 * Відсутній файл — це перший запуск: повертаємо початковий стан.
 * Пошкоджений файл — це помилка, а не привід почати спочатку: інцидент у ніч на
 * 10.09.2026 стався саме тому, що обрізаний ENOSPC-ом файл тихо підмінявся епохою,
 * після чого воркер щоп'ять хвилин перерозсилав усю базу лідів (materials/error-log.txt).
 */
export function loadState(path: string): Result<SyncState> {
  if (!existsSync(path)) return { ok: true, value: { ...INITIAL_STATE } };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // Файл є, але не читається (права, тека замість файлу, збій диска).
    // Це теж помилка, а не привід почати з епохи.
    return { ok: false, error: `sync-state: не вдалося прочитати ${path}: ${String(error)}` };
  }
  return parseJson(text, isSyncState, "sync-state");
}

/**
 * Записує стан атомарно: спершу у тимчасовий файл, потім rename.
 * Прямий writeFileSync обрізає цільовий файл перед записом, тож збій на повному
 * диску лишав би файл стану пошкодженим.
 */
export function saveState(path: string, state: SyncState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}
