import { readEnv } from "../core/config.js";
import { postJson } from "../core/http.js";
import { log } from "../core/log.js";
import { isRecord, isString, parseJson } from "../core/parse.js";
import type { Integration, Lead, Result } from "../core/types.js";

interface SheetsAppendResponse {
  status: string;
}

/** `POST <url> failed: <причина>` → `<причина>`, щоб не тягти URL із токеном. */
const reasonOf = (error: string): string => error.split(" failed: ").pop() ?? error;

const isSheetsAppendResponse = (value: unknown): value is SheetsAppendResponse =>
  isRecord(value) && isString(value.status);

const sheetsAppend: Integration = {
  name: "sheets-append",
  requiredEnv: ["SHEETS_WEBHOOK_URL", "SHEETS_TOKEN"],

  async send(lead: Lead): Promise<Result<void>> {
    const webhookUrl = readEnv("SHEETS_WEBHOOK_URL");
    if (!webhookUrl.ok) return webhookUrl;
    const token = readEnv("SHEETS_TOKEN");
    if (!token.ok) return token;

    // Токен їде в query-параметрі, тож схема тут — це не гігієна, а умова
    // конфіденційності: по http він пішов би відкритим текстом. `readEnv`
    // схему не перевіряє, `postJson` бере URL як є — отже перевіряємо тут,
    // до запиту. Адресу в текст помилки не кладемо: у ній той самий токен.
    if (!webhookUrl.value.startsWith("https://")) {
      return { ok: false, error: "sheets-append: SHEETS_WEBHOOK_URL має бути https://" };
    }

    // retries: 0 — щоб зберегти поведінку: до рефакторингу тут був голий fetch,
    // тобто рівно одна спроба. Типові retries: 2 у postJson дали б до трьох
    // запитів, а це вже зміна поведінки, якої рефакторинг робити не має.
    const response = await postJson(
      `${webhookUrl.value}?token=${token.value}`,
      { values: [[lead.createdAt, lead.name, lead.email, lead.phone ?? "", lead.source]] },
      { retries: 0 },
    );
    if (!response.ok) {
      // `postJson` кладе в текст помилки повний URL, а в URL тут — `?token=…`.
      // У журналі його маскує `redact()`, але ПОВЕРНУТИЙ `Result` ніхто не
      // маскує: він піде далі викликачу, і секрет поїде з ним. Лишаємо саму
      // причину («HTTP 502», текст винятку) і відрізаємо адресу.
      return { ok: false, error: `sheets-append: ${reasonOf(response.error)}` };
    }

    const parsed = parseJson(response.value, isSheetsAppendResponse, "sheets-append");
    if (!parsed.ok) return parsed;

    if (parsed.value.status !== "ok") {
      log.error(`sheets-append failed for lead ${lead.id}: ${parsed.value.status}`);
      return { ok: false, error: `sheets error: ${parsed.value.status}` };
    }

    log.info(`sheets-append: row added for lead ${lead.id}`);
    return { ok: true, value: undefined };
  },
};

export default sheetsAppend;
