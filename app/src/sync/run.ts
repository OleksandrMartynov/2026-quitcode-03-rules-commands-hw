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

  // Нерозбірний createdAt — це зіпсовані зовнішні дані, а не «новий лід».
  // Конвенція 4: неочікувана форма — помилка, а не значення за замовчуванням.
  //
  // Вважати такий лід новим не можна ще й механічно: він завжди потрапляв би
  // у pending, але ніколи не посував би чекпойнт (його не з чого рахувати),
  // тож розсилався б у кожну інтеграцію щоп'ять хвилин нескінченно — рівно
  // той шторм дублікатів, через який стався інцидент.
  const broken = leads.find((lead) => Number.isNaN(Date.parse(lead.createdAt)));
  if (broken) {
    const error = `sync-state: лід ${broken.id} має нерозбірний createdAt ${broken.createdAt}`;
    log.error(`${error} — запуск скасовано, дані ліда треба виправити`);
    return { ok: false, error };
  }

  // Порівнюємо моменти часу, а не рядки: lead.createdAt приходить із форми й
  // може бути в іншому, теж валідному вигляді ("...Z" без мілісекунд, "+03:00"),
  // для якого лексикографічний порядок не збігається з хронологічним.
  const pending = leads.filter((lead) => Date.parse(lead.createdAt) > since);

  let delivered = 0;
  let failed = 0;

  for (const lead of pending) {
    for (const integration of integrations) {
      const result = await integration.send(lead);
      if (result.ok) delivered++;
      else failed++;
    }
  }

  // Усі createdAt тут уже розбірні — перевірено вище, до розсилки.
  const newestMs = pending.reduce((latest, lead) => Math.max(latest, Date.parse(lead.createdAt)), since);

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
