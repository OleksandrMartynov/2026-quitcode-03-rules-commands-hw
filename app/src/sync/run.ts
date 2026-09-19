// Один запуск синхронізації. Планувальник викликає його кожні 5 хвилин.
import { log } from "../core/log.js";
import type { Integration, Lead } from "../core/types.js";
import { loadState, saveState } from "./state.js";

export interface SyncReport {
  pending: number;
  delivered: number;
  failed: number;
}

export async function runSync(
  leads: readonly Lead[],
  integrations: readonly Integration[],
  statePath: string,
): Promise<SyncReport> {
  const loaded = loadState(statePath);
  if (!loaded.ok) {
    // Пошкоджений файл стану — зупиняємось, а не починаємо з епохи: інакше цей
    // запуск розішле всю базу заново (див. materials/error-log.txt).
    log.error(`sync: ${loaded.error} — запуск скасовано, файл стану треба відновити`);
    return { pending: 0, delivered: 0, failed: 0 };
  }
  const state = loaded.value;

  const pending = leads.filter((lead) => lead.createdAt > state.lastSyncedAt);
  let delivered = 0;
  let failed = 0;

  for (const lead of pending) {
    for (const integration of integrations) {
      const result = await integration.send(lead);
      if (result.ok) delivered++;
      else failed++;
    }
  }

  const newest = pending.reduce(
    (latest, lead) => (lead.createdAt > latest ? lead.createdAt : latest),
    state.lastSyncedAt,
  );
  saveState(statePath, { lastSyncedAt: newest });
  log.info(`sync: ${pending.length} pending leads, ${delivered} delivered, ${failed} failed`);
  return { pending: pending.length, delivered, failed };
}
