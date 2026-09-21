import { afterEach, describe, expect, it, vi } from "vitest";
import type { Lead } from "../core/types.js";
import { log } from "../core/log.js";
import { isRecord, parseJson } from "../core/parse.js";
import { formatTelegramMessage, telegramNotify } from "./telegram-notify.js";

const lead: Lead = {
  id: "ld_0001",
  name: "Олена Тестова",
  email: "olena@studio-nova.example.test",
  phone: "+380 (00) 000-00-00",
  source: "website",
  budgetUsd: 4000,
  createdAt: "2026-09-10T08:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("telegram-notify", () => {
  it("форматує повідомлення без email і телефону", () => {
    const text = formatTelegramMessage(lead);
    expect(text).toContain("Олена Тестова");
    expect(text).not.toContain(lead.email);
    expect(text).not.toContain("+380");
  });

  it("повертає помилку, якщо не задано TELEGRAM_BOT_TOKEN", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("TELEGRAM_CHAT_ID", "-100200300");
    await expect(telegramNotify.send(lead)).resolves.toEqual({
      ok: false,
      error: "missing environment variable TELEGRAM_BOT_TOKEN",
    });
  });

  it("надсилає текст у чат і перевіряє URL та тіло запиту", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "fake-test-bot-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "-100200300");
    vi.spyOn(log, "info").mockImplementation(() => {});
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await telegramNotify.send(lead);

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/botfake-test-bot-token/sendMessage");
    expect(parseJson(String(init?.body), isRecord, "body")).toEqual({
      ok: true,
      value: { chat_id: "-100200300", text: formatTelegramMessage(lead) },
    });
  });

  // У URL Telegram сидить bot-токен, а postJson кладе URL у текст помилки.
  it("не повертає bot-токен у тексті помилки", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "bot1234567890:AAFakeTokenForTestsOnly000000");
    vi.stubEnv("TELEGRAM_CHAT_ID", "-100200300");
    vi.spyOn(log, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));

    const result = await telegramNotify.send(lead);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain("api.telegram.org");
    expect(result.error).not.toContain("AAFakeTokenForTestsOnly");
    expect(result.error).toMatch(/^telegram-notify: /);
  });

  // sendMessage не ідемпотентний: повтор на 5xx надіслав би менеджерам дубль.
  it("на 5xx не повторює запит — дубль сповіщення гірший за втрату", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "fake-test-bot-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "-100200300");
    vi.spyOn(log, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response("", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    await telegramNotify.send(lead);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("повертає помилку, якщо Telegram відповідає ok: false", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "fake-test-bot-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "-100200300");
    vi.spyOn(log, "info").mockImplementation(() => {});
    vi.spyOn(log, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(telegramNotify.send(lead)).resolves.toEqual({
      ok: false,
      error: "telegram error: chat not found",
    });
  });

  it("у тілі запиту немає email і телефону ліда", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "fake-test-bot-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "-100200300");
    vi.spyOn(log, "info").mockImplementation(() => {});
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await telegramNotify.send(lead);

    const [, init] = fetchMock.mock.calls[0]!;
    const body = String(init?.body);
    expect(body).not.toContain(lead.email);
    expect(body).not.toContain("+380");
  });
});
