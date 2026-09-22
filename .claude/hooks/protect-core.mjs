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

import { existsSync, readFileSync, realpathSync } from "node:fs";
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
  // `.git/hooks/` — не «службова тека», а спосіб запустити код повз хук:
  // записаний туди `pre-commit` виконається як дочірній процес `git commit`,
  // а для дочірнього процесу `PreToolUse` не спрацьовує. Тека потрібна git-у,
  // не інструментам, тож писати в неї не має ніхто з них.
  ".git/",
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

// Підкоманди git, які не можуть переписати файл у робочому дереві. Знову
// allow-list, а не перелік «небезпечних»: `config --file`, `stash`, `archive -o`,
// `worktree`, `bundle`, `format-patch -o`, `submodule`, `filter-branch` пишуть
// у файли, і цей перелік ніколи не буде повним. `add` і `commit` тут законно:
// вони чіпають індекс і історію, а не файли в захищених шляхах — інакше
// блокувалося б повідомлення коміту, що згадує `.claude/rules/`.
const READ_ONLY_GIT = new Set([
  "diff", "status", "log", "show", "blame", "grep", "shortlog", "describe",
  "ls-files", "ls-tree", "ls-remote", "rev-parse", "rev-list", "cat-file",
  "name-rev", "whatchanged", "count-objects", "var", "help", "version",
  "add", "commit", "push", "fetch", "remote", "branch", "tag",
]);

// Лише те, що розпізнається напевно. Широкий regex по шел-командах дає хибні
// спрацювання на легітимних читаннях і все одно не ловить усі обхідні шляхи.
const BASH_BLOCKLIST = [
  {
    re: /\bcore\.hooksPath\b/i,
    why: "core.hooksPath переносить git-хуки в іншу теку, тобто дає запустити довільний код повз захист .git/hooks/: сам git-хук виконується дочірнім процесом, для якого PreToolUse не спрацьовує",
  },
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

// Обгортки, за якими ховається справжня команда: `env rm …`, `sudo rm …`,
// `/usr/bin/rm …`, `nice -n 5 rm …`. Без нормалізації перевірка першого токена
// дивиться на обгортку й пропускає запис.
const WRAPPERS = new Set([
  "env", "sudo", "doas", "command", "builtin", "exec",
  "nice", "nohup", "time", "stdbuf", "timeout", "setsid", "ionice",
]);

// Прапорці обгорток, які ЗАБИРАЮТЬ значення наступним токеном. Без цього
// `env -C . rm …` розбирався б так, що командою ставала «.», а `rm` і шлях
// лишались просто аргументами — і перевірка їх не бачила.
const WRAPPER_VALUE_FLAGS = {
  env: new Set(["-C", "--chdir", "-u", "--unset", "-S", "--split-string"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid"]),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
};

/**
 * Знімає прозорі обгортки (`env`, `sudo`, `/usr/bin/…`) і повертає справжню
 * команду. Другим значенням — `uncertain`: розбір упевнений чи ні.
 *
 * Невідомий прапорець обгортки робить розбір непевним: ми не знаємо, чи він
 * забирає наступний токен, тож не знаємо, де починається команда. У такому разі
 * не вгадуємо — викликач мусить перевірити всі токени й заблокувати, якщо
 * серед них є захищений шлях.
 */
function stripWrappers(tokens) {
  let i = 0;
  let uncertain = false;
  while (i < tokens.length) {
    // VAR=value перед командою — теж префікс.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) { i++; continue; }
    const name = basename(tokens[i]); // /usr/bin/rm -> rm
    if (!WRAPPERS.has(name)) break;
    const valueFlags = WRAPPER_VALUE_FLAGS[name] ?? new Set();
    i++;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      const flag = tokens[i].split("=")[0];
      const takesValue = valueFlags.has(flag) && !tokens[i].includes("=");
      i++;
      if (takesValue) i++;
      else if (!valueFlags.has(flag)) uncertain = true; // невідомий прапорець
    }
    // timeout 5s cmd — тривалість без прапорця.
    if (i < tokens.length && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[i]) && name === "timeout") i++;
  }
  // Виконуваний файл лишаємо без шляху, щоб /usr/bin/rm збігся з rm.
  const rest = i < tokens.length ? [basename(tokens[i]), ...tokens.slice(i + 1)] : [];
  return { tokens: rest, uncertain };
}

// Команди, які ГАРАНТОВАНО лише читають. Усе, чого тут немає, вважається
// таким, що може писати: перелічувати інструменти запису по одному — програшна
// гра (touch, mkdir, python3 -c, perl -i, node -e, будь-що наступне). Тому
// посилка інвертована: згадав захищений шлях — доведи, що лише читаєш.
const READ_ONLY_BASH = new Set([
  "cat", "bat", "head", "tail", "less", "more", "nl", "od", "xxd", "strings",
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "ls", "dir", "tree", "find", "stat", "file", "du", "wc", "basename", "dirname",
  "diff", "cmp", "md5", "md5sum", "shasum", "sha256sum", "cksum",
  "sort", "uniq", "cut", "tr", "column", "jq", "yq", "awk", "sed", "echo", "printf",
  "cd", "pwd", "true", "false", "test", "which", "type", "git",
  // node/npm/npx/python свідомо ВІДСУТНІ: вони виконують довільний код, тож
  // `node script.js app/src/core/x` читанням не є. На команди без захищеного
  // шляху (`cd app && npm test`) це не впливає — там нема чого захищати.
]);

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

/**
 * `cwd` приходить із того самого payload, що й шлях, тож довіряти йому як межі
 * не можна: `{"cwd":"/tmp","file_path":"app/src/core/log.ts"}` зарезолвився б
 * у `/tmp/app/src/core/log.ts`, тобто «поза репозиторієм» — і запис пройшов би.
 * Тому відносний шлях пробуємо від ОБОХ баз: заявленої і справжньої.
 */
function classify(rawPath, cwd) {
  return classifyIn(rawPath, [REPO_ROOT, cwd]);
}

/**
 * Те саме, але з довільним списком баз. Потрібно для `cd`: усередині однієї
 * Bash-команди `cd app/src/core && rm log.ts` робоча тека зсувається, і далі
 * `log.ts` означає вже `app/src/core/log.ts`. Обидві бази зсуваються разом,
 * щоб зсув не скасовував захист від підробленого `cwd`.
 */
function classifyIn(rawPath, bases) {
  for (const base of bases) {
    if (isAbsolute(rawPath) && base !== bases[0]) break; // абсолютний шлях від бази не залежить
    const hit = classifyAgainst(rawPath, base);
    if (hit) return hit;
  }
  return null;
}

/**
 * Куди саме зсунув `cd $VAR`, статично не знати. Замість того щоб вгадувати чи
 * блокувати все, питаємо конкретно: чи існує файл із таким відносним іменем
 * усередині якоїсь захищеної зони? `rm log.ts` після невідомого `cd` —
 * `app/src/core/log.ts` існує, отже блокуємо; `rm foo.txt` — ні, отже пропускаємо.
 */
function classifyAnywhere(rawPath) {
  if (isAbsolute(rawPath)) return null;
  for (const dir of PROTECTED_DIRS) {
    const candidate = resolve(REPO_ROOT, dir, rawPath);
    if (existsSync(candidate)) {
      return { rel: relative(realish(REPO_ROOT), realish(candidate)), zone: dir };
    }
  }
  return null;
}

/**
 * Шлях в аргументі не завжди є самим аргументом: `dd of=app/src/core/log.ts`,
 * `tar --file=app/src/core/x`, `D=app/src/core` ховають його праворуч від `=`.
 * Тому з токена робимо всі форми, які можуть виявитись шляхом, і перевіряємо
 * кожну. Голий прапорець (`-i`, `--recursive`) шляхом бути не може.
 */
function pathForms(token) {
  const forms = [];
  if (!token.startsWith("-")) forms.push(token);
  const eq = token.indexOf("=");
  if (eq > 0 && eq < token.length - 1) forms.push(token.slice(eq + 1));
  return forms;
}

/** Перша форма токена, що потрапляє в захищену зону, або null. */
function hitFor(token, bases, cwdUnknown) {
  for (const form of pathForms(token)) {
    const hit = classifyIn(form, bases) || (cwdUnknown ? classifyAnywhere(form) : null);
    if (hit) return hit;
  }
  return null;
}

function classifyAgainst(rawPath, base) {
  const target = realish(resolve(base, rawPath));
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

    // Те, чого не можна розібрати надійно, блокуємо, щойно в команді згадано
    // захищений шлях: змінна, підстановка, eval і -exec ховають справжню дію.
    // `$` тут будь-яке — `echo x > $D/log.ts` резолвиться лише в шелі, не тут.
    if (/\$|`|\beval\b|\b(?:ba)?sh\s+-c\b|-exec\b|-delete\b|\bxargs\b/.test(probe)) {
      for (const token of probe.split(/[\s;|&()<>]+/)) {
        // `D=app/src/core` — шлях сховано в присвоєнні; знімаємо `NAME=`,
        // інакше токен не впізнається як захищений.
        const bare = token.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "");
        const hit = bare && classify(bare, cwd);
        if (hit) {
          deny(
            `команду не можна розібрати надійно, а в ній згадано \`${hit.rel}\``,
            `змінні, підстановка, eval, -exec чи xargs ховають справжню дію: ` +
              `у захищеній зоні \`${hit.zone}\` такі команди блокуємо, а не вгадуємо`,
          );
        }
      }
    }

    // Команди, які пишуть у файл, названий аргументом. Розрізняємо два види,
    // бо інакше `cp app/src/core/log.ts /tmp/copy.ts` блокувався б даремно —
    // це читання з core, а не запис у нього.
    // `cd` всередині команди зсуває робочу теку для наступних сегментів, тож
    // бази несемо через цикл, а не беремо з payload на кожному кроці.
    let bases = [REPO_ROOT, cwd];
    let cwdUnknown = false;

    for (const part of probe.split(/[;|&]+/)) {
      const raw = part.trim().split(/\s+/).filter(Boolean);
      const { tokens, uncertain } = stripWrappers(raw);

      // Ціль перенаправлення: `> файл` і `>> файл`. Перевіряємо саме ціль, а не
      // наявність ">" будь-де, інакше `ls app/scripts > /tmp/x` хибно блокувалось
      // би — там у захищену зону нічого не пишеться.
      for (const m of part.matchAll(/\d?>>?\s*([^\s;|&()<>]+)/g)) {
        const hit = hitFor(m[1], bases, cwdUnknown);
        if (hit) {
          deny(`перенаправлення виводу у \`${hit.rel}\``, `цей шлях лежить у захищеній зоні \`${hit.zone}\``);
        }
      }

      // Розбір непевний — не вгадуємо: якщо в команді згадано захищений шлях,
      // блокуємо.
      if (uncertain) {
        for (const token of raw) {
          const hit = hitFor(token, bases, cwdUnknown);
          if (hit) {
            deny(
              `обгортку з невідомим прапорцем не можна розібрати, а в команді згадано \`${hit.rel}\``,
              `не знаємо, де закінчується обгортка й починається команда, тож у захищеній зоні \`${hit.zone}\` блокуємо`,
            );
          }
        }
      }
      if (tokens.length === 0) continue;

      // Пише в УСІ свої аргументи.
      // mv тут, а не серед «лише призначення»: перенесення з core ВИДАЛЯЄ
      // джерело, тобто змінює захищену зону так само, як запис у неї.
      const writesAllArgs = /^(?:tee|rm|mv|truncate|dd|chmod|chown|patch)$/.test(tokens[0]) ||
        (tokens[0] === "sed" && tokens.includes("-i")) ||
        (tokens[0] === "git" && tokens[1] === "apply");
      // Пише лише в ОСТАННІЙ аргумент — призначення.
      const writesLastArg = /^(?:cp|ln|install)$/.test(tokens[0]);

      const targets = writesAllArgs
        ? tokens.slice(1)
        : writesLastArg
          ? tokens.slice(-1)
          : [];

      for (const token of targets) {
        const hit = hitFor(token, bases, cwdUnknown);
        if (hit) {
          deny(
            `команда змінює \`${hit.rel}\``,
            `цей шлях лежить у захищеній зоні \`${hit.zone}\` (команда: ${cmd.slice(0, 120)})`,
          );
        }
      }

      // Backstop. Якщо в команді згадано захищений шлях, а верб не доведено
      // read-only — блокуємо. `sed -i`, `node -e`, `npm install` пишуть, тому
      // для них дозволу немає навіть попри те, що базовий верб у списку.
      const verb = tokens[0];
      const mutatingForm =
        (verb === "sed" && tokens.includes("-i")) ||
        (verb === "node" && tokens.includes("-e")) ||
        (verb === "npm" && tokens.includes("install")) ||
        (verb === "git" && !READ_ONLY_GIT.has((tokens[1] ?? "").replace(/^-+/, "") || "help"));
      const provablyReadOnly = READ_ONLY_BASH.has(verb) && !mutatingForm;
      if (!provablyReadOnly && !writesLastArg) {
        for (const token of tokens.slice(1)) {
          const hit = hitFor(token, bases, cwdUnknown);
          if (hit) {
            deny(
              `команду \`${verb}\` не доведено як read-only, а вона згадує \`${hit.rel}\``,
              `у захищеній зоні \`${hit.zone}\` дозволені лише команди з доведеним читанням; ` +
                `перелічувати інструменти запису по одному не можна — завжди знайдеться наступний`,
            );
          }
        }
      }

      // Шлях може сидіти всередині виразу, а не бути окремим токеном: у лапках,
      // у дужках, у тілі heredoc —
      //   python3 - <<PY … io.open(".claude/settings.json","w") … PY
      // Токенізація такого не бачить: `io.open(.claude/settings.json,w)` як
      // шлях нікуди не резолвиться. Тому для сегментів, не доведених як
      // read-only, шукаємо захищений префікс ще й підрядком у сирому тексті.
      // Для доведеного читання (`cat`, `grep`, `git diff`, `echo`) скану немає
      // — інакше блокувалося б і згадування шляху в повідомленні коміту.
      if (!provablyReadOnly) {
        const low = part.toLowerCase();
        for (const zone of [...PROTECTED_DIRS, ...PROTECTED_FILES]) {
          if (low.includes(zone.toLowerCase())) {
            deny(
              `команда \`${verb}\` згадує \`${zone}\` всередині виразу`,
              `у захищеній зоні \`${zone}\` дозволені лише команди з доведеним читанням; ` +
                `шлях у лапках, у дужках чи в тілі heredoc — це той самий запис`,
            );
          }
        }
      }

      // Сегмент був `cd` — далі відносні шляхи рахуються від нової теки.
      // Без цього `cd app/src/core && rm log.ts` проходив: `log.ts` від кореня
      // репозиторію не захищений, а що воно означає після `cd`, хук не бачив.
      if (verb === "cd") {
        const target = tokens.slice(1).find((t) => !t.startsWith("-"));
        if (!target || target === "-" || /[$`~*?]/.test(target)) {
          cwdUnknown = true; // `cd`, `cd -`, `cd $VAR` — статично не резолвиться
        } else {
          bases = bases.map((b) => resolve(b, target));
          cwdUnknown = false;
        }
      }
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
