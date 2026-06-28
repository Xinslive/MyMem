import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["src/**/*.ts", "index.ts", "cli.ts"],
    rules: {
      // Prefer @ts-expect-error over @ts-ignore for better accountability
      "@typescript-eslint/ban-ts-comment": ["error", {
        "ts-ignore": true,
        "ts-expect-error": "allow-with-description",
      }],
      // Allow unused variables prefixed with underscore
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
      // Prefer const
      "prefer-const": "error",
      // Keep ordinary source strict; dynamic runtime-boundary files opt out below
      // with an explicit allowlist so `any` cannot keep spreading silently.
      "@typescript-eslint/no-explicit-any": "error",
      // Disable rules that conflict with existing patterns
      "@typescript-eslint/no-non-null-assertion": "off", // Used extensively in store.ts initialization
      "@typescript-eslint/no-inferrable-types": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // These rules require significant refactoring — defer to future cleanup
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-useless-assignment": "warn",
      "no-useless-escape": "warn",
      // preserve-caught-error requires attaching cause to all re-throws
      "preserve-caught-error": "off",
    },
  },
  {
    files: [
      "index.ts",
      "cli.ts",
      "src/auto-capture-hook.ts",
      "src/auto-recall-hook.ts",
      "src/cli/oauth.ts",
      "src/hook-enhancements.ts",
      "src/plugin-singleton.ts",
      "src/reflection-hook.ts",
    ],
    rules: {
      // These files sit directly on OpenClaw hook payloads, Commander option
      // objects, OAuth JSON, and plugin singleton boundaries whose external
      // shapes are still dynamic. Keep the exception centralized instead of
      // emitting dozens of background warnings on every lint run.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    ignores: ["node_modules/", "dist/", "**/*.d.ts", "~/**"],
  },
);
