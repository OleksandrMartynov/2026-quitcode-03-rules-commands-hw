import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lead } from "../core/types.js";
import { log } from "../core/log.js";
import { isRecord, parseJson } from "../core/parse.js";
import sheetsAppend from "./sheets-append.js";

const lead: Lead = {
  id: "ld_0002",
  name: "Андрій Тестовий",
  email: "andrii@studio-nova.example.test",
  source: "instagram",
  createdAt: "2026-09-10T09:30:00.000Z",
};

beforeEach(() => {
  vi.stubEnv("SHEETS_WEBHOOK_URL", "https://sheets.example.test/append");
  vi.stubEnv("SHEETS_TOKEN", "fake-sheets-token-0000");
  vi.spyOn(log, "info").mockImplementation(() => {});
  vi.spyOn(log, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sheets-append", () => {
  it("додає рядок у таблицю і повертає ok", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"status":"ok"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sheetsAppend.send(lead)).resolves.toEqual({ ok: true, value: undefined });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://sheets.example.test/append?token=fake-sheets-token-0000");
    expect(parseJson(String(init?.body), isRecord, "body")).toEqual({
      ok: true,
      value: {
        values: [["2026-09-10T09:30:00.000Z", "Андрій Тестовий", "andrii@studio-nova.example.test", "", "instagram"]],
      },
    });
  });

  // Конвенція 10 вимагає цей випадок для кожної інтеграції. Рефакторинг завів
  // сюди readEnv() замість прямого process.env — і саме цей шлях лишався
  // єдиним у проєкті без тесту.
  it("повертає помилку, якщо не задано SHEETS_WEBHOOK_URL", async () => {
    vi.stubEnv("SHEETS_WEBHOOK_URL", "");
    await expect(sheetsAppend.send(lead)).resolves.toEqual({
      ok: false,
      error: "missing environment variable SHEETS_WEBHOOK_URL",
    });
  });

  it("повертає помилку, якщо не задано SHEETS_TOKEN", async () => {
    vi.stubEnv("SHEETS_TOKEN", "");
    await expect(sheetsAppend.send(lead)).resolves.toEqual({
      ok: false,
      error: "missing environment variable SHEETS_TOKEN",
    });
  });

  it("повертає помилку, якщо таблиця відповіла не ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"status":"quota_exceeded"}', { status: 200 })));

    await expect(sheetsAppend.send(lead)).resolves.toEqual({ ok: false, error: "sheets error: quota_exceeded" });
  });

  // Токен їде в query, тож http означав би секрет відкритим текстом.
  it("відмовляється слати токен по http", async () => {
    vi.stubEnv("SHEETS_WEBHOOK_URL", "http://sheets.example.test/append");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await sheetsAppend.send(lead);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("https://");
    expect(result.error).not.toContain("fake-sheets-token-0000");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // postJson вставляє повний URL у текст помилки, а в URL тут ?token=…
  // Повернутий Result ніхто не маскує, тож секрет не має в нього потрапити.
  it("не повертає токен у тексті помилки", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));

    const result = await sheetsAppend.send(lead);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain("fake-sheets-token-0000");
    expect(result.error).not.toContain("sheets.example.test");
    expect(result.error).toContain("HTTP 502");
  });

  // До рефакторингу тут був голий fetch — рівно одна спроба на виклик send().
  // postJson за замовчуванням робить до трьох (retries: 2), тож без явного
  // retries: 0 рефакторинг тихо змінив би поведінку на 5xx. Тест це фіксує.
  it("на 5xx робить рівно одну спробу, як голий fetch до рефакторингу", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sheetsAppend.send(lead);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });
});
