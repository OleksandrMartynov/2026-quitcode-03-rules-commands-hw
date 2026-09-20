// Стан синхронізації між запусками: ліди, створені після lastSyncedAt, ще не розіслані.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import { isRecord, isString, parseJson } from "../core/parse.js";
import type { Result } from "../core/types.js";

export interface SyncState {
  /** ISO-8601, UTC, канонічний вигляд `toISOString()`. */
  lastSyncedAt: string;
}

const INITIAL_STATE: SyncState = { lastSyncedAt: "1970-01-01T00:00:00.000Z" };

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
// Повна граматика, а не лише суфікс зони: перевірка самого хвоста пропускала
// "2026-09-10 08:00:00Z" (пробіл замість T), і `Date.parse` мовчки канонізував
// його у справжню мітку. Вимагаємо `T`, повний час і явну зону.
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * `Date.parse` приймає неіснуючі дати й мовчки прокручує їх уперед:
 * `"2026-02-29"` (2026 — не високосний) розбирається успішно й стає
 * `"2026-03-01"`. Це тихе перетлумачення зовнішніх даних — рівно те, що
 * забороняє конвенція 4, — тож календарну частину перевіряємо окремо.
 */
function hasRealCalendarDate(value: string): boolean {
  const m = CALENDAR_DATE.exec(value);
  if (!m) return true; // не форма Y-M-D — хай вирішує Date.parse
  const [, y, mo, d] = m;
  const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return (
    probe.getUTCFullYear() === Number(y) &&
    probe.getUTCMonth() === Number(mo) - 1 &&
    probe.getUTCDate() === Number(d)
  );
}

/**
 * Зводить будь-яку валідну мітку часу до канонічного UTC-вигляду.
 *
 * Це місце, де сходяться запис, читання й перевірка лідів — єдині ворота для
 * міток часу в усьому модулі. `Lead.createdAt` приходить із форми сайту, і
 * `"2026-09-10T08:00:00Z"` чи `"...+03:00"` — так само валідний ISO-8601, як
 * і `"2026-09-10T08:00:00.000Z"`. Якщо записати таке значення як є, наступний
 * `loadState` його відкине — і синхронізація стане назавжди, повертаючи звіт,
 * не відрізнити від «нових лідів немає».
 */
export function toCanonicalIso(value: string): Result<string> {
  // `Date.parse` приймає куди більше, ніж ISO-8601, і мовчки все канонізує:
  // без зони бере ЛОКАЛЬНИЙ час (результат залежить від машини), а пробіл
  // замість `T` чи формат на кшталт "Sep 10 2026" проходить як валідний.
  // Тому спершу — форма, і лише потім розбір.
  if (!ISO_8601_UTC.test(value)) {
    return { ok: false, error: `sync-state: не ISO-8601 з явною зоною: ${value}` };
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return { ok: false, error: `sync-state: не мітка часу ISO-8601: ${value}` };
  if (!hasRealCalendarDate(value)) {
    return { ok: false, error: `sync-state: неіснуюча календарна дата: ${value}` };
  }
  return { ok: true, value: new Date(ms).toISOString() };
}

const isSyncState = (value: unknown): value is SyncState =>
  isRecord(value) &&
  isString(value.lastSyncedAt) &&
  !Number.isNaN(Date.parse(value.lastSyncedAt)) &&
  new Date(value.lastSyncedAt).toISOString() === value.lastSyncedAt;

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
 *
 * Значення нормалізується перед записом, тож те, що сюди зайшло, `loadState`
 * гарантовано прочитає назад.
 */
export function saveState(path: string, state: SyncState): Result<void> {
  const canonical = toCanonicalIso(state.lastSyncedAt);
  if (!canonical.ok) return canonical;

  // Унікальний суфікс: планувальник може вбити прогін і запустити наступний,
  // поки цей ще пише. Спільне ім'я .tmp дало б гонку двох процесів.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ lastSyncedAt: canonical.value }, null, 2));
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Тимчасовий файл могло й не створитися — це не окрема помилка.
    }
    return { ok: false, error: `sync-state: не вдалося записати ${path}: ${String(error)}` };
  }
  return { ok: true, value: undefined };
}
