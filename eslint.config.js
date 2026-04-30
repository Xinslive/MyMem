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
      // Warn on any — remaining instances in hook/CLI code need gradual cleanup
      "@typescript-eslint/no-explicit-any": "warn",
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
    ignores: ["node_modules/", "dist/", "**/*.d.ts", "~/**"],
  },
);
