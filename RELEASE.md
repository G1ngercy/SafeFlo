# Release Process

Этот документ — для мейнтейнеров. Описывает, как выпускать новые версии SafeFlow.

## Принципы

- **Релизы — через теги, не через ручной `npm publish`.** Это значит, что каждый релиз привязан к конкретному коммиту, и пакет в npm собран через GitHub Actions с криптографической attestation (provenance).
- **Тег = единственная команда для публикации.** Никаких "опубликую с локальной машины" — это путь к supply-chain атакам.
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
-[Unreleased]: https://github.com/YOUR-ORG/safeflow/compare/v0.1.0...HEAD
+[Unreleased]: https://github.com/YOUR-ORG/safeflow/compare/v0.2.0...HEAD
+[0.2.0]: https://github.com/YOUR-ORG/safeflow/compare/v0.1.0...v0.2.0
 [0.1.0]: https://github.com/YOUR-ORG/safeflow/releases/tag/v0.1.0
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

### 5. Тег и публикация

После merge в `main`:

```bash
git checkout main
git pull
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

С этого момента GitHub Actions автоматически:

1. Запустит preflight-проверки (`.github/workflows/release.yml` → `preflight`).
2. Создаст GitHub Release с автогенерированными release notes.
3. Опубликует пакет в npm с `--provenance`.

### 6. Проверка после релиза

- [ ] Проверьте на https://www.npmjs.com/package/safeflow, что новая версия видна.
- [ ] Проверьте, что у пакета есть бейдж "Verified" (это означает успешный provenance).
- [ ] Установите свежую версию в чистом проекте и убедитесь, что `npx safeflow init` работает.
- [ ] Проверьте, что GitHub Release виден на https://github.com/YOUR-ORG/safeflow/releases.

## Что делать, если релиз сломан

Если что-то пошло не так после публикации:

1. **Не удаляйте версию из npm.** Это путаница для пользователей, которые уже её установили.
2. Опубликуйте patch-релиз с исправлением.
3. Если уязвимость критическая — `npm deprecate safeflow@0.2.0 "Critical bug, use 0.2.1+"`.
4. Опубликуйте post-mortem в discussions.

## Чувствительные секреты

Для работы release workflow в GitHub Actions нужен секрет:

- `NPM_TOKEN` — токен с правами публикации в npm. Создаётся на https://www.npmjs.com/settings/YOUR-USERNAME/tokens. Тип: **Automation** (с двухфакторной защитой).

Никогда не храните токены локально в `.npmrc` — используйте только GitHub secrets. Когда меняете токен, ротируйте его сразу же.
