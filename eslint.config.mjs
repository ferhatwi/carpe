import tseslint from "typescript-eslint"
import eslintConfigPrettier from "eslint-config-prettier"

export default [
    {
        ignores: ["**/*.js", "node_modules/**", "dist/**", "icons/**", "_locales/**", "docs/**"]
    },
    ...tseslint.configs.recommended,
    {
        files: ["src/**/*.ts", "library/**/*.ts", "tests/**/*.ts", "tests/**/*.mts", "build.mjs", "release.mjs"],
        rules: {
            curly: ["error", "all"],
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_"
                }
            ]
        }
    },
    eslintConfigPrettier
]
