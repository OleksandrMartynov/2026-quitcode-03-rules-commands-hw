---
paths:
  - "app/src/**/*.ts"
---

# Архітектура lead-sync

## Контекст

`lead-sync` перенесли з n8n-воркфлоу на три шари з фіксованим напрямом залежностей,
щоб новий канал доставки лідів додавався одним модулем, а не правками по всьому коду.
Ядро спільне для всіх клієнтських воркерів агенції, тому його межі жорсткі.

## Правило

### Шари й напрям залежностей

- `app/src/core/` — платформа: типи, HTTP, конфіг, парсинг, логер.
  **`core/` не імпортує нічого з решти проєкту.** Усередині файлів `core/`
  не має бути рядків `import ... from "../integrations/..."` чи
  `from "../sync/..."` — це помилка архітектури, а не дрібниця.
  Зворотний напрям (з `integrations/` і `sync/` у `core/`) — правильний і потрібний.
- `app/src/integrations/` — по одному модулю на зовнішню систему плюс реєстр
  `index.ts`. Імпортує лише з `core/`.
  **`integrations/` нічого не знає про `sync/`**: не імпортуй `../sync/*` —
  усе потрібне для відправки має прийти аргументом у `send(lead)`.
- `app/src/sync/` — запуск синхронізації і стан між запусками. Імпортує з `core/`
  і реєстр з `integrations/index.ts`.
  **Не звертайся до конкретного модуля інтеграції з `sync/`** — не пиши
  `import { slackNotify } from "../integrations/slack-notify.js"`; працюй через
  контракт `Integration` з `core/types.ts` і масив `integrations` з
  `integrations/index.ts`.

### Нова інтеграція — рівно три зміни

1. новий файл `app/src/integrations/<kebab-name>.ts`;
2. тест поруч — `app/src/integrations/<kebab-name>.test.ts`;
3. один рядок імпорту і один елемент масиву в `app/src/integrations/index.ts`.

Більше нічого. Не заводь підтеки, спільні «хелпери», базові класи чи фабрики:
якщо здається, що потрібен четвертий файл — зупинись, опиши, навіщо, і **чекай
відповіді**. Четвертий файл без відповіді не створюй.
Експортуй іменованим експортом, як `slack-notify.ts`
(`export const <camelName>: Integration = { … }`), а не `export default`.

> Вимога стосується **нових** модулів. `sheets-append.ts` має `export default` —
> це спадщина, як і порушення конвенцій у ньому. Міняти стиль експорту там не
> можна мимохідь: `index.ts` імпортує його як default, тож це правка другого
> файлу, а `/refactor` дозволяє рівно один. Отже
> `grep -n "export default" app/src/integrations/` дає один рядок, і це
> очікувано; два рядки означають, що правило порушив новий модуль.

### Публічний API ядра — рівно цей

| Модуль | Експорт |
|---|---|
| `core/types.ts` | `Lead`, `Result<T>`, `Integration` |
| `core/http.ts` | `postJson(url, body, options?)` → `Promise<Result<string>>`, `PostOptions` |
| `core/config.ts` | `readEnv(name, env?)` → `Result<string>` (другий параметр — для тестів, за замовчуванням `process.env`) |
| `core/parse.ts` | `parseJson(text, guard, label?)` → `Result<T>`, `Guard<T>`, `isRecord`, `isString`, `isNumber` |
| `core/log.ts` | `log.info`, `log.warn`, `log.error`, `redact(text)` |

**Іншого в ядрі не існує.** Не вигадуй `getJson`, `httpClient`, `logger.debug`,
`readEnvOrThrow`, `Result.map` чи поля, яких немає в `Lead`. Якщо потрібного
експорту немає — не додавай його до `core/` (див. `do-not-touch`), а зупинись
і опиши людині, чого бракує.

Імпорти відносні й **із розширенням `.js`** (`module: NodeNext`):
`import type { Lead } from "../core/types.js"`.

## Як перевірити

- `cd app && npm run check:rules` → у розділі `by rule` рядок `core-untouched  0`.
- `cd app && npm run typecheck` — зелений (зламаний імпорт видно тут).
- Нова інтеграція з'явилась **рівно в трьох місцях**:
  `git status --short app/src/integrations` показує два нові файли
  (`<name>.ts`, `<name>.test.ts`) і одну зміну в `index.ts`.
- Напрям імпортів — **чотири заборони, чотири команди**. Кожна має дати
  порожній вивід:
  ```bash
  # 1. core/ не імпортує нічого з решти проєкту
  grep -rnE "['\"](\.\./)+(integrations|sync)/" app/src/core/

  # 2. integrations/ нічого не знають про sync/
  grep -rnE "['\"](\.\./)+sync/" app/src/integrations/

  # 3. integrations/ не імпортують одне одного; реєстр index.ts — єдиний,
  #    кому можна, а тест законно імпортує свій модуль
  grep -rnE "['\"]\./" app/src/integrations/ \
    | grep -vE "^app/src/integrations/(index\.ts|[^:]*\.test\.ts):"

  # 4. sync/ працює через реєстр, а не з конкретним модулем інтеграції
  grep -rnE "['\"](\.\./)+integrations/" app/src/sync/ | grep -v "integrations/index\.js"
  ```
  Деталі, без яких перевірка мовчки пропускає порушення:
  `(\.\./)+`, а не `\.\./` — інакше `"../../integrations/foo.js"` не знайдеться;
  клас лапок `['"]`, а не лише `"` — TypeScript однаково приймає
  `from '../sync/run.js'`; і збіг по **самому шляху**, а не по слову `from` —
  інакше повз пройдуть `import "../sync/run.js"` заради побічного ефекту,
  `await import("../sync/run.js")` і `require("../sync/run.js")`.

  Перші дві команди перевіряють міжшаровий напрям, третя й четверта — те, що
  правило вимагає словами, але чого жоден `grep` тут раніше не перевіряв:
  сусідні інтеграції не зчеплені між собою, а `sync/` не знає імен конкретних
  модулів.
