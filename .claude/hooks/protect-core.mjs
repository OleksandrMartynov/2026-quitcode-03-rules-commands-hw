#!/usr/bin/env node
// PreToolUse-хук репозиторію lead-sync: не дає записати у захищені шляхи.
//
// Контракт Claude Code (див. довідку по hooks):
//   stdin  — JSON виклику інструмента: { session_id, cwd, hook_event_name,
//            tool_name, tool_input, ... }
//   exit 2 — дію ЗАБЛОКОВАНО, stderr показують моделі
//   будь-який інший код виходу — дію ПРОПУЩЕНО
//
// Наслідок, на якому тримається весь захист: неперехоплений виняток — це exit 1,
// тобто ДОЗВІЛ. Тому зовнішній try/catch нижче веде в exit(2): хук, який упав,
// мусить блокувати, а не пропускати.
//
// Node, а не bash — щоб працювало і на Windows.

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Корінь репозиторію рахуємо від розташування самого скрипта (.claude/hooks/ -> ../..),
// а не від cwd і не від $CLAUDE_PROJECT_DIR: обидва бувають іншими, а змінна ще й
// не розгортається однаково на всіх платформах.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Має збігатися зі списком у .claude/rules/do-not-touch.md.
//
// `.claude/` тут навмисно: правило, яке агент може переписати перед тим, як його
// порушити, — не правило. Хук, що не боронить сам себе, знімається одним Edit,
// після чого захищеним не лишається нічого. Самоблокування — це задум, а не
// побічний ефект: людина редагує ці файли поза сесією агента.
const PROTECTED_DIRS = [
  "app/src/core/",
  "app/scripts/",
  "materials/",
  ".github/",
  ".claude/",
];
// package.json і tsconfig.json — це не код, а те, ЧИМ запускається перевірка.
// Підмінивши скрипт `check:rules` або послабивши `strict`, можна отримати
// «зелені» числа, не полагодивши нічого.
const PROTECTED_FILES = [".coderabbit.yaml", "app/package.json", "app/tsconfig.json"];

const PATH_FIELDS = ["file_path", "notebook_path", "path", "filePath"];

// Читання захищених файлів дозволене — забороняється лише запис. Ці інструменти
// пропускаємо навіть якщо в payload є шлях у захищеній зоні. Перелік — саме
// allow-list, а не deny-list: невідомий інструмент зі шляхом усе одно перевіряється
// — але лише якщо matcher у .claude/settings.json узагалі покличе хук. Зараз це
// Write|Edit|NotebookEdit|MultiEdit і Bash; інструмент поза цим переліком до хука
// не доходить, і сам скрипт про це знати не може.
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "NotebookRead",
  "LS",
  "WebFetch",
  "WebSearch",
]);

// Лише те, що розпізнається напевно. Широкий regex по шел-командах дає хибні
// спрацювання на легітимних читаннях і все одно не ловить усі обхідні шляхи.
const BASH_BLOCKLIST = [
  {
    re: /--write-lock\b/,
    why: "режим --write-lock перезаписує app/scripts/core.lock.json поточними хешами ядра: після нього check:rules показує core-untouched 0 навіть на зміненому ядрі",
  },
];

/**
 * Прибирає лапки перед пошуком у команді: у шелі `--write""-lock` і
 * `--write-'lock'` розгортаються в `--write-lock`, тож пошук по сирому рядку
 * обходиться однією парою лапок. Це не робить перевірку стійкою до довільного
 * шелу (змінні, `eval`, base64 лишаються поза нею) — межу описано в
 * docs/verification.md, — але закриває найдешевший обхід.
 */
const unquote = (cmd) => cmd.replace(/["']/g, "");

function deny(what, why) {
  process.stderr.write(
    `protect-core: заблоковано — ${what}\n` +
      `Причина: ${why}\n` +
      `Захищені зони: app/src/core/**, app/scripts/**, materials/**, .github/**, ` +
      `.claude/**, .coderabbit.yaml, app/package.json, app/tsconfig.json. ` +
      `Їх не редагують — ні інструментом запису, ні через shell.\n` +
      `Якщо задача не виконується без цієї зміни — зупинись і опиши людині: який файл, ` +
      `яку саме зміну і чому вона потрібна. Обхідний шлях не шукай.\n` +
      `Див. .claude/rules/do-not-touch.md\n`,
  );
  process.exit(2);
}

// Резолвимо симлінки по найглибшому наявному предку й доклеюємо неіснуючий хвіст,
// щоб (а) симлінк у core не був чорним ходом і (б) ще не створений файл теж резолвився.
// ".." уже згорнуто в resolve().
function realish(p) {
  const abs = resolve(p);
  const tail = [];
  let head = abs;
  for (;;) {
    try {
      const real = realpathSync.native(head);
      return tail.length ? resolve(real, ...tail.slice().reverse()) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs; // нічого по цьому шляху не існує
      tail.push(basename(head));
      head = parent;
    }
  }
}

function classify(rawPath, cwd) {
  const target = realish(resolve(cwd, rawPath));
  const root = realish(REPO_ROOT);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null; // поза репозиторієм
  // Нижній регістр: файлові системи macOS і Windows не чутливі до регістру,
  // тож APP/SRC/CORE/log.ts інакше пройшов би повз префікс.
  const posix = rel.split(sep).join("/").toLowerCase();
  // Збіг по межі сегмента: "app/src/core/" не чіпляє "app/src/core-helpers/",
  // але сама тека "app/src/core" (без слеша) теж має бути захищена.
  const dir = PROTECTED_DIRS.find((d) => {
    const low = d.toLowerCase();
    return posix.startsWith(low) || posix === low.slice(0, -1);
  });
  if (dir) return { rel, zone: dir };
  const file = PROTECTED_FILES.find((f) => posix === f.toLowerCase());
  if (file) return { rel, zone: file };
  return null;
}

try {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }

  // Порожній stdin — виклику інструмента немає (Claude Code завжди надсилає payload).
  // Це людина запустила скрипт руками: захищати нічого.
  if (raw.trim() === "") process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Непорожній, але нерозбірний: запис Є, а розсудити його не можемо. Fail closed.
    deny("не вдалося розібрати вхідний JSON хука", "хук не може перевірити ціль запису");
  }

  // Розібраний, але неочікуваної форми payload — це теж «не можу розсудити запис».
  // Без цієї перевірки рядок чи null замість об'єкта тихо дав би exit 0, тобто дозвіл.
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    deny("вхідний JSON хука не є об'єктом", "хук не може перевірити ціль запису");
  }
  if (
    payload.tool_input !== undefined &&
    (payload.tool_input === null ||
      typeof payload.tool_input !== "object" ||
      Array.isArray(payload.tool_input))
  ) {
    deny("поле tool_input не є об'єктом", "хук не може перевірити ціль запису");
  }

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input = payload.tool_input ?? {};
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();

  // Читання дозволене — забороняється лише запис.
  if (READ_ONLY_TOOLS.has(toolName)) process.exit(0);

  if (toolName === "Bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    const probe = unquote(cmd);
    for (const { re, why } of BASH_BLOCKLIST) {
      if (re.test(cmd) || re.test(probe)) deny(`команда \`${cmd.slice(0, 200)}\``, why);
    }
    process.exit(0);
  }

  const candidates = [];
  for (const f of PATH_FIELDS) {
    const v = input[f];
    if (typeof v === "string" && v.trim() !== "") candidates.push(v);
  }
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (e && typeof e.file_path === "string" && e.file_path.trim() !== "") {
        candidates.push(e.file_path);
      }
    }
  }

  // Поля зі шляхом немає — це не той запис, який ми вміємо перевірити. Пропускаємо:
  // блокувати тут означало б ламати сторонні інструменти, нічого не захистивши.
  if (candidates.length === 0) process.exit(0);

  for (const c of candidates) {
    const hit = classify(c, cwd);
    if (hit) {
      deny(`запис у \`${hit.rel}\` (${toolName})`, `цей шлях лежить у захищеній зоні \`${hit.zone}\``);
    }
  }

  process.exit(0);
} catch (err) {
  // Помилка в самому хуку не повинна перетворитись на тихий дозвіл.
  deny("внутрішня помилка хука", String(err && err.message ? err.message : err));
}
