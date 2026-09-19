# AGENTS.md

`lead-sync` — воркер клієнта Studio Nova, перенесений з n8n-воркфлоу на TypeScript.
Раз на 5 хвилин бере нові заявки з форми сайту й розсилає їх по інтеграціях:
канал менеджерів у Slack, Google-таблиця, далі CRM і месенджери.
Node 22+, Vitest, нуль runtime-залежностей.

## Команди

Усі — з теки `app/`:

| Команда | Навіщо |
|---|---|
| `npm install` | встановити залежності (лише dev) |
| `npm test` | Vitest, один прогін |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:rules` | статична перевірка правил проєкту |

Перед комітом — усі три: `cd app && npm test && npm run typecheck && npm run check:rules`.

## Карта коду

```
app/src/
  core/          🔒 ЗАХИЩЕНО — платформа: типи, HTTP, конфіг, парсинг, логер
  integrations/  по модулю на зовнішню систему + реєстр index.ts
  sync/          запуск синхронізації і стан між запусками
```

`core/` під окремим рев'ю платформної команди. Разом із ним не редагуються
`app/scripts/`, `materials/`, `.coderabbit.yaml`, `.github/`, `.claude/` (правила
й хук) і `app/package.json` / `app/tsconfig.json` (чим запускається перевірка).

## Головні домовленості

Одним рядком кожна; повні формулювання, приклади й команди перевірки — у
`.claude/rules/`, дублювати їх сюди не треба.

1. Захищені шляхи не редагуються — упершись, зупинись і опиши потрібну зміну →
   [`.claude/rules/do-not-touch.md`](.claude/rules/do-not-touch.md)
2. Три шари, залежності лише в бік `core/`; нова інтеграція = модуль + тест +
   рядок у реєстрі → [`.claude/rules/architecture.md`](.claude/rules/architecture.md)
3. Публічний API ядра фіксований — нових експортів у ньому не вигадуй →
   [`.claude/rules/architecture.md`](.claude/rules/architecture.md)
4. Збої повертаються як `Result<T>`, а не кидаються винятком →
   [`.claude/rules/conventions.md`](.claude/rules/conventions.md)
5. Мережа, середовище, розбір JSON і журнал — тільки через відповідні функції
   ядра → [`.claude/rules/conventions.md`](.claude/rules/conventions.md)
6. Пошкоджені зовнішні дані стають помилкою, а не мовчазним значенням за
   замовчуванням → [`.claude/rules/conventions.md`](.claude/rules/conventions.md)
7. Email і телефон ліда в сповіщення не потрапляють →
   [`.claude/rules/conventions.md`](.claude/rules/conventions.md)
8. Нових залежностей не додаємо — нуль runtime-залежностей, і жодного пакета
   в `dependencies` чи `devDependencies` →
   [`.claude/rules/conventions.md`](.claude/rules/conventions.md)

## Джерела

- `materials/architecture-brief.md` — записка, з якої виведені правила (для людей).
- `app/scripts/check-rules.mjs` — що саме перевіряється статично.
