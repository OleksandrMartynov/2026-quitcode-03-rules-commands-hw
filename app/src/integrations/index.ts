// Реєстр інтеграцій, які запускає sync. Нова інтеграція — новий файл і рядок тут.
import type { Integration } from "../core/types.js";
import sheetsAppend from "./sheets-append.js";
import { slackNotify } from "./slack-notify.js";
import { telegramNotify } from "./telegram-notify.js";

export const integrations: readonly Integration[] = [slackNotify, sheetsAppend, telegramNotify];
