# Release Process

Этот документ — для мейнтейнеров. Описывает, как выпускать новые версии SafeFlo.

## Принципы

- **Дистрибуция — через `git clone`, не через npm registry.** Пользователи клонируют репозиторий и собирают из зафиксированного `package-lock.json`. Мы намеренно не публикуем пакет в npm: меньше доверенных посредников — меньше supply-chain поверхности.
- **Релиз — это тег, а не ручная команда.** Каждый релиз привязан к конкретному коммиту в `main`. Пуш тега `v*.*.*` запускает GitHub Actions, который прогоняет preflight-проверки и создаёт GitHub Release с release notes. Никаких "выпущу с локальной машины".
- **Версии — SemVer.** Пока проект в `0.x`, breaking changes допустимы в минорных релизах, но должны быть отмечены в CHANGELOG.

## Шаги

### 1. Подготовка

Убедитесь, что:

- [ ] `main` зелёный (последний CI-run прошёл).
- [ ] CHANGELOG.md обновлён: секция `[Unreleased]` содержит все изменения с прошлого релиза.
- [ ] Версия в `package.json` соответствует тому, что вы собираетесь выпустить.
- [ ] Все security-аудиты прошли локально: `npm test`, `node scripts/audit-mcp-descriptions.mjs`.

### 2. Финализация changelog

Откройте `CHANGELOG.md`, переместите содержимое `[Unreleased]` в новую секцию с версией и датой:

```diff
 ## [Unreleased]

+## [0.2.0] - 2026-06-15
+
 ### Добавлено
 - Новая функция X.
```

В конце файла обновите ссылки:

```diff
-[Unreleased]: https://github.com/G1ngercy/SafeFlo/compare/v0.1.0...HEAD
+[Unreleased]: https://github.com/G1ngercy/SafeFlo/compare/v0.2.0...HEAD
+[0.2.0]: https://github.com/G1ngercy/SafeFlo/compare/v0.1.0...v0.2.0
 [0.1.0]: https://github.com/G1ngercy/SafeFlo/releases/tag/v0.1.0
```

### 3. Обновление версии

```bash
# patch (0.1.0 → 0.1.1)
npm version patch --no-git-tag-version

# minor (0.1.0 → 0.2.0)
npm version minor --no-git-tag-version

# major (0.1.0 → 1.0.0)
npm version major --no-git-tag-version
```

Флаг `--no-git-tag-version` важен: мы создадим тег вручную после ревью.

### 4. Коммит и PR

```bash
git checkout -b release/v0.2.0
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v0.2.0"
git push origin release/v0.2.0
```

Откройте PR. Минимум один другой мейнтейнер должен его одобрить. Слейте через "Squash and merge" или "Rebase and merge" (не "Create a merge commit", чтобы история была чистой).

### 5. Тег и релиз

После merge в `main`:

```bash
git checkout main
git pull
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

С этого момента GitHub Actions автоматически (`.github/workflows/release.yml`):

1. Запустит preflight-проверки (`preflight`): type-check, build, тесты, аудит MCP-описаний, проверку совпадения тега и версии в `package.json`.
2. Создаст GitHub Release (`github-release`) с автогенерированными release notes из коммитов.

Публикации в npm registry нет — это сознательный выбор (см. «Принципы»).

### 6. Проверка после релиза

- [ ] Проверьте, что GitHub Release виден на https://github.com/G1ngercy/SafeFlo/releases и release notes корректны.
- [ ] Склонируйте тег в чистую директорию и убедитесь, что сборка проходит:
      `git clone --branch v0.2.0 https://github.com/G1ngercy/SafeFlo.git && cd SafeFlo && npm ci && npm run build && npm test`.
- [ ] Проверьте, что `node dist/cli.js init` работает в чистом проекте.

## Что делать, если релиз сломан

Если после релиза обнаружилась проблема:

1. **Не удаляйте тег и GitHub Release.** Кто-то мог уже склонировать эту версию; молчаливое удаление путает пользователей.
2. Выпустите patch-релиз с исправлением (повторите шаги 2–5 с новой версией).
3. Если проблема критическая — отметьте сломанный релиз: в его GitHub Release notes добавьте предупреждение и ссылку на исправленную версию.
4. Опубликуйте post-mortem в discussions.

## Чувствительные секреты

Release workflow **не требует никаких секретов**: он использует только встроенный `GITHUB_TOKEN`, который GitHub Actions выдаёт автоматически (с правами `contents: write` для создания Release). Токенов npm или других внешних сервисов в проекте нет — и заводить их не нужно.
