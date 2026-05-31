// ESLint flat config для SafeFlow.
// Цель: рекомендованные правила @typescript-eslint + строгий запрет `any`.
// `any` разрешён только через явный `// eslint-disable-next-line` с комментарием почему.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  // Не анализируем сборку, зависимости, бенчмарк-результаты и бэкапы.
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "benchmark-results/**",
      "**/*.bak",
    ],
  },

  // Исходники TypeScript: рекомендованный набор + запрет any.
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Запрет `any`. Исключение — только через явный eslint-disable с причиной.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },

  // Тесты (node --test, .js) и служебные скрипты (.mjs): только базовые JS-правила.
  // Здесь допустимы console и динамика — это не рантайм-код пакета.
  {
    files: ["test/**/*.js", "scripts/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
