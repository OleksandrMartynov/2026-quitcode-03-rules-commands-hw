import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Integration, Lead } from "../core/types.js";
import { runSync } from "./run.js";

const makeLead = (id: string, createdAt: string): Lead => ({
  id,
  name: `Lead ${id}`,
  email: `${id}@studio-nova.example.test`,
  source: "website",
  createdAt,
});

const leads = [
  makeLead("ld_0001", "2026-09-09T10:00:00.000Z"),
  makeLead("ld_0002", "2026-09-09T11:00:00.000Z"),
  makeLead("ld_0003", "2026-09-10T08:00:00.000Z"),
];

function recordingIntegration(sent: string[]): Integration {
  return {
    name: "recording",
    requiredEnv: [],
    send: async (lead) => {
      sent.push(lead.id);
      return { ok: true, value: undefined };
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lead-sync-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runSync", () => {
  it("при першому запуску розсилає всі ліди і зберігає найновішу дату", async () => {
    const sent: string[] = [];
    const statePath = join(dir, "sync-state.json");

    const report = await runSync(leads, [recordingIntegration(sent)], statePath);

    expect(report).toEqual({ ok: true, value: { pending: 3, delivered: 3, failed: 0 } });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ lastSyncedAt: "2026-09-10T08:00:00.000Z" });
  });

  it("розсилає лише ліди, новіші за збережений стан", async () => {
    const sent: string[] = [];
    const statePath = join(dir, "sync-state.json");
    writeFileSync(statePath, JSON.stringify({ lastSyncedAt: "2026-09-09T10:30:00.000Z" }));

    await runSync(leads, [recordingIntegration(sent)], statePath);

    expect(sent).toEqual(["ld_0002", "ld_0003"]);
  });

  // Регресія на інцидент: пошкоджений стан має зупинити прогін, а не
  // перетворитись на епоху й перерозіслати всю базу.
  it("на пошкодженому файлі стану скасовує прогін і нічого не надсилає", async () => {
    const sent: string[] = [];
    const statePath = join(dir, "sync-state.json");
    writeFileSync(statePath, '{"lastSync');
    vi.spyOn(console, "error").mockImplementation(() => {});

    const report = await runSync(leads, [recordingIntegration(sent)], statePath);

    expect(report.ok).toBe(false);
    expect(sent).toEqual([]);
  });

  // Помилку видно в типі результату, а не лише в журналі: інакше скасований
  // прогін не відрізнити від «нових лідів немає».
  it("скасований прогін не виглядає як порожній успішний", async () => {
    const statePath = join(dir, "sync-state.json");
    writeFileSync(statePath, '{"lastSync');
    vi.spyOn(console, "error").mockImplementation(() => {});

    const aborted = await runSync(leads, [recordingIntegration([])], statePath);
    const idle = await runSync([], [recordingIntegration([])], join(dir, "fresh.json"));

    expect(aborted.ok).toBe(false);
    expect(idle).toEqual({ ok: true, value: { pending: 0, delivered: 0, failed: 0 } });
  });

  // F1: lead.createdAt приходить із форми й буває неканонічним. Якщо його
  // записати як є, наступний прогін відкине власний файл стану.
  it("неканонічний createdAt не ламає наступний прогін", async () => {
    const statePath = join(dir, "sync-state.json");
    const odd = [makeLead("ld_0009", "2026-09-10T08:00:00Z")];

    const first = await runSync(odd, [recordingIntegration([])], statePath);
    expect(first.ok).toBe(true);

    const sent: string[] = [];
    const second = await runSync(odd, [recordingIntegration(sent)], statePath);

    expect(second).toEqual({ ok: true, value: { pending: 0, delivered: 0, failed: 0 } });
    expect(sent).toEqual([]);
  });
});
