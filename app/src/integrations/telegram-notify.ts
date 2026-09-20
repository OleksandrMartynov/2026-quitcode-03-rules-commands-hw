// Сповіщення про новий лід у Telegram-чат менеджерів.
import { readEnv } from "../core/config.js";
import { postJson } from "../core/http.js";
import { log } from "../core/log.js";
import { isRecord, isString, parseJson } from "../core/parse.js";
import type { Integration, Lead, Result } from "../core/types.js";

interface TelegramResponse {
  ok: boolean;
  description?: string;
}

const isTelegramResponse = (value: unknown): value is TelegramResponse =>
  isRecord(value) &&
  typeof value.ok === "boolean" &&
  (value.description === undefined || isString(value.description));

export function formatTelegramMessage(lead: Lead): string {
  const budget = lead.budgetUsd === undefined ? "бюджет не вказано" : `бюджет $${lead.budgetUsd}`;
  return `Новий лід: ${lead.name} · ${lead.source} · ${budget}`;
}

export const telegramNotify: Integration = {
  name: "telegram-notify",
  requiredEnv: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],

  async send(lead: Lead): Promise<Result<void>> {
    const botToken = readEnv("TELEGRAM_BOT_TOKEN");
    if (!botToken.ok) return botToken;
    const chatId = readEnv("TELEGRAM_CHAT_ID");
    if (!chatId.ok) return chatId;

    // `retries: 0` навмисно. `sendMessage` не ідемпотентний: на 5xx повідомлення
    // могло вже дійти, і повтор надішле менеджерам дубль. Саме шторм дублікатів
    // у каналі й був інцидентом 10.09 (`materials/error-log.txt`), тож для
    // сповіщення втрата одного пінга дешевша за дубль — тим паче що сам лід
    // усе одно лягає в таблицю як у систему обліку.
    // Ідеал — повторювати 429 (повідомлення точно не дійшло) і не повторювати
    // 5xx — через `PostOptions` не виражається, а `core/http.ts` змінювати не можна.
    const response = await postJson(
      `https://api.telegram.org/bot${botToken.value}/sendMessage`,
      { chat_id: chatId.value, text: formatTelegramMessage(lead) },
      { retries: 0 },
    );
    if (!response.ok) {
      // У URL тут сидить bot-токен, а `postJson` вставляє URL у текст помилки.
      // `log` його замаскує, повернутий `Result` — ні. Відрізаємо адресу.
      const reason = response.error.split(" failed: ").pop() ?? response.error;
      log.error(`telegram-notify: lead ${lead.id} not delivered: ${reason}`);
      return { ok: false, error: `telegram-notify: ${reason}` };
    }

    const parsed = parseJson(response.value, isTelegramResponse, "telegram-notify");
    if (!parsed.ok) return parsed;

    if (!parsed.value.ok) {
      const description = parsed.value.description ?? "unknown error";
      log.error(`telegram-notify: lead ${lead.id} not delivered: ${description}`);
      return { ok: false, error: `telegram error: ${description}` };
    }

    log.info(`telegram-notify: lead ${lead.id} delivered`);
    return { ok: true, value: undefined };
  },
};
