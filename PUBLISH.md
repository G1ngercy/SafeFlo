# Публикация репозитория на GitHub

Этот документ — для вас как первого мейнтейнера. Пошаговая инструкция от пустого репозитория до зелёного CI и опубликованного npm-пакета.

## 0. Перед началом

Что нужно иметь под рукой:

- GitHub-аккаунт.
- Локально установленный git и Node.js >= 20.
- (Опционально) npm-аккаунт для публикации пакета в npm registry.

## 1. Замените плейсхолдеры

В нескольких файлах есть плейсхолдер `YOUR-ORG` (имя организации/пользователя GitHub) и `@YOUR-USERNAME` (ваш GitHub username):

```bash
# Из корня репозитория, замените на свои значения:
ORG="your-github-org"     # например, "alexr-safeflow"
USER="your-username"      # например, "alexr"

# macOS (требует пустой '' после -i):
find . -type f \( -name "*.md" -o -name "*.yml" -o -name "*.json" -o -name "CODEOWNERS" \) \
  -not -path "./node_modules/*" -not -path "./dist/*" -not -path "./.git/*" \
  -exec sed -i '' "s/YOUR-ORG/$ORG/g; s/YOUR-USERNAME/$USER/g" {} +

# Linux:
find . -type f \( -name "*.md" -o -name "*.yml" -o -name "*.json" -o -name "CODEOWNERS" \) \
  -not -path "./node_modules/*" -not -path "./dist/*" -not -path "./.git/*" \
  -exec sed -i "s/YOUR-ORG/$ORG/g; s/YOUR-USERNAME/$USER/g" {} +
```

Проверьте, что замена прошла корректно:

```bash
grep -rn "YOUR-ORG\|YOUR-USERNAME" \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
  --exclude="*.tar.gz"
# Должно быть пусто.
```

## 2. Создайте репозиторий на GitHub

Создайте **пустой** репозиторий через https://github.com/new:

- Name: `safeflow`
- Description: `Локальная и прозрачная платформа оркестрации AI-агентов для Claude Code`
- Public
- **НЕ** инициализируйте README, .gitignore или LICENSE — у нас уже есть.

## 3. Локальная инициализация git

```bash
cd /path/to/safeflow

git init -b main
git add .
git status                                  # проверьте, что не попадает лишнего
git commit -m "feat: initial public release"
git remote add origin git@github.com:YOUR-ORG/safeflow.git
git push -u origin main
```

После пуша CI запустится автоматически. Должны пройти все 4 джобы (`test`, `audit`, `package-checks`, `lint`).

## 4. Настройка репозитория

### 4.1. Branch protection

В **Settings → Branches → Add rule** для ветки `main`:

- ✓ Require a pull request before merging
  - ✓ Require approvals (1+)
  - ✓ Dismiss stale pull request approvals when new commits are pushed
- ✓ Require status checks to pass before merging
  - Выберите: `test (Node 22 on ubuntu-latest)`, `audit`, `package-checks`, `lint`
  - ✓ Require branches to be up to date before merging
- ✓ Require conversation resolution before merging
- ✓ Do not allow bypassing the above settings

### 4.2. Security settings

**Settings → Security**:

- ✓ **Private vulnerability reporting** — включите. Это даёт пользователям кнопку "Report a vulnerability" на странице Security.
- ✓ **Dependency graph** — включите (обычно уже включён по умолчанию).
- ✓ **Dependabot alerts** — включите.
- ✓ **Dependabot security updates** — включите.
- ✓ **Code scanning** → **Set up CodeQL** → рекомендуется "Default" конфигурация.
- ✓ **Secret scanning** — включите.

### 4.3. Discussions

**Settings → Features → Discussions** — включите. У нас в `.github/ISSUE_TEMPLATE/config.yml` ссылка ведёт туда.

### 4.4. Issues

Issues по умолчанию включены. Шаблоны (`bug_report.yml`, `feature_request.yml`) появятся автоматически.

### 4.5. Actions permissions

**Settings → Actions → General**:

- **Actions permissions**: "Allow actions and reusable workflows" с белым списком или "Allow OWNER, and select non-OWNER, actions and reusable workflows".
- **Workflow permissions**: "Read repository contents and packages permissions" (минимум по умолчанию). Наши workflows явно повышают разрешения там, где нужно.
- ✓ "Require approval for all outside collaborators"

## 5. (Опционально) Публикация в npm

Если вы хотите, чтобы пакет был доступен через `npm install safeflow`:

### 5.1. Имя пакета

Проверьте, свободно ли имя `safeflow`:

```bash
npm view safeflow
# Если возвращает 404 — имя свободно.
# Если нет — выберите другое (например, @your-org/safeflow в package.json).
```

### 5.2. npm-токен

1. Залогиньтесь на https://www.npmjs.com.
2. Включите 2FA, если ещё не включено (Account → Profile → Two-Factor Authentication).
3. **Access Tokens** → **Generate New Token** → тип **Granular Access Token**:
   - Expiration: 90 days (для regular rotation)
   - Packages and scopes: только `safeflow`
   - Permissions: Read and write
   - Allowed IP ranges: оставьте пустым (GitHub Actions не имеет фиксированных IP)
4. Скопируйте токен — он показывается только один раз.

### 5.3. Добавьте секрет в GitHub

В репозитории: **Settings → Secrets and variables → Actions → New repository secret**:

- Name: `NPM_TOKEN`
- Value: (вставьте токен)

### 5.4. Первый релиз

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

Workflow `Release` запустится автоматически (см. `.github/workflows/release.yml`):

1. Прогонит все CI-проверки заново.
2. Создаст GitHub Release с release notes.
3. Опубликует пакет в npm с `--provenance` (криптографическая подпись от GitHub).

После публикации проверьте:

```bash
npm view safeflow
# Должна быть видна версия 0.1.0 и поле "publish.signatures" с provenance.
```

## 6. Что добавить в About-секцию репозитория

Кликните на шестерёнку рядом с About:

- **Description**: `Локальная и прозрачная платформа оркестрации AI-агентов для Claude Code. MCP-сервер с памятью, планированием и координацией без сетевых вызовов.`
- **Website**: ссылка на доки или npm-страницу (если опубликован)
- **Topics** (теги): `mcp`, `claude-code`, `ai-agents`, `orchestration`, `local-first`, `typescript`, `security`, `prompt-injection-protection`, `sqlite`

## 7. Анонс

Когда репозиторий готов и CI зелёный, можно объявить о проекте. Несколько идей:

- **Show HN** на Hacker News с акцентом на security-модель.
- Пост в r/LocalLLaMA, r/ClaudeAI, r/programming.
- Twitter/X / Mastodon с упоминанием Anthropic Claude Code community.
- Если у вас есть блог — техническая статья про путь от анализа уязвимостей ruflo до архитектурных решений SafeFlow. Это сильный нарратив.

## 8. После публикации

В первые недели после релиза:

- Проверяйте issue и discussions ежедневно.
- Отвечайте на security advisory в течение 3 дней (как обещано в SECURITY.md).
- Следите за dependabot PR — обновляйте зависимости еженедельно.
- Если что-то ломается — `npm deprecate` старая версия и быстрый patch.

Удачного релиза.
