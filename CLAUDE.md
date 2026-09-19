# CLAUDE.md

@AGENTS.md

## Специфічне для Claude Code

- Правила проєкту — `.claude/rules/`. `do-not-touch.md` без `paths`, тож діє в
  кожній сесії; `architecture.md` і `conventions.md` прив'язані до
  `app/src/**/*.ts` і підтягуються, коли ти читаєш ці файли.
- Команди — `.claude/commands/`: `/analyze-error`, `/refactor`,
  `/generate-integration`.
- Хук `PreToolUse` у `.claude/settings.json` блокує запис у захищені шляхи.
  Якщо дію заблоковано — це не збій інструмента: перечитай
  `.claude/rules/do-not-touch.md` і зупинись, як там описано.
