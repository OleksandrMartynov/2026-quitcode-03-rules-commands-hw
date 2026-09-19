// Один запуск синхронізації. Планувальник викликає його кожні 5 хвилин.
import { log } from "../core/log.js";
import type { Integration, Lead, Result } from "../core/types.js";
import { loadState, saveState, toCanonicalIso } from "./state.js";

export interface SyncReport {
  pending: number;
  delivered: number;
  failed: number;
}

/**
 * Повертає `Result`, а не самий звіт: прогін може не відбутися (пошкоджений
 * файл стану), і тоді `{ pending: 0, delivered: 0, failed: 0 }` не відрізнити
 * від «нових лідів не було». Мовчазний нуль замість помилки — це та сама
 * підміна, через яку стався інцидент.
 */
export async function runSync(
  leads: readonly Lead[],
  integrations: readonly Integration[],
  statePath: string,
): Promise<Result<SyncReport>> {
  const loaded = loadState(statePath);
  if (!loaded.ok) {
    // Пошкоджений файл стану — зупиняємось, а не починаємо з епохи: інакше цей
    // запуск розішле всю базу заново (див. materials/error-log.txt).
    log.error(`sync: ${loaded.error} — запуск скасовано, файл стану треба відновити`);
    return loaded;
  }
  const since = Date.parse(loaded.value.lastSyncedAt);

  // Порівнюємо моменти часу, а не рядки: lead.createdAt приходить із форми й
  // може бути в іншому, теж валідному вигляді ("...Z" без мілісекунд, "+03:00"),
  // для якого лексикографічний порядок не збігається з хронологічним.
  const pending = leads.filter((lead) => {
    const at = Date.parse(lead.createdAt);
    if (Number.isNaN(at)) {
      log.warn(`sync: лід ${lead.id} має нерозбірний createdAt ${lead.createdAt} — вважаємо новим`);
      return true;
    }
    return at > since;
  });

  let delivered = 0;
  let failed = 0;

  for (const lead of pending) {
    for (const integration of integrations) {
      const result = await integration.send(lead);
      if (result.ok) delivered++;
      else failed++;
    }
  }

  const newestMs = pending.reduce((latest, lead) => {
    const at = Date.parse(lead.createdAt);
    return Number.isNaN(at) ? latest : Math.max(latest, at);
  }, since);

  const newest = toCanonicalIso(new Date(newestMs).toISOString());
  if (!newest.ok) return newest;

  const saved = saveState(statePath, { lastSyncedAt: newest.value });
  if (!saved.ok) {
    log.error(`sync: ${saved.error} — прогін виконано, але чекпойнт не збережено`);
    return saved;
  }

  log.info(`sync: ${pending.length} pending leads, ${delivered} delivered, ${failed} failed`);
  return { ok: true, value: { pending: pending.length, delivered, failed } };
}
