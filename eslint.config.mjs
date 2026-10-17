import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import { builtinModules } from 'node:module'

// Every Node built-in by its bare name ("fs", "fs/promises", ...);
// "node:"-prefixed imports are caught by a pattern below.
const NODE_MODULES = builtinModules.filter((name) => !name.startsWith('_'))

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    rules: {
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/block-lang': [
        'error',
        {
          script: {
            lang: 'ts'
          }
        }
      ],
      // console.error is how main reports failures (never with values).
      'no-console': ['warn', { allow: ['error'] }]
    }
  },

  // Type-aware rules for the Node side and the tests. (.vue files are left
  // out to avoid configuring type-aware parsing through vue-eslint-parser.)
  {
    files: ['src/{main,core,preload,shared}/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error'
    }
  },

  // core/ is pure logic: no Electron, file system, processes or main code.
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'electron',
            'fs',
            'node:fs',
            'fs/promises',
            'node:fs/promises',
            'child_process',
            'node:child_process'
          ].map((name) => ({
            name,
            message: 'src/core must stay pure (no Electron, fs or processes).'
          })),
          patterns: [
            {
              group: ['**/main/**', '**/renderer/**'],
              message: 'core must not depend on main or renderer.'
            }
          ]
        }
      ]
    }
  },

  // The renderer talks to the system only through window.envvault.
  {
    files: ['src/renderer/**/*.{ts,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['electron', ...NODE_MODULES].map((name) => ({
            name,
            message: 'The renderer has no Node or Electron access; use window.envvault.'
          })),
          patterns: [
            { group: ['node:*'], message: 'The renderer has no Node access; use window.envvault.' },
            {
              group: ['**/core/**', '**/main/**', '**/preload/**'],
              message: 'The renderer may only import types from src/shared.'
            }
          ]
        }
      ],
      'vue/no-v-html': 'error'
    }
  },

  // shared/ is imported by main, preload and renderer alike: it must not
  // pull in any package or Node module.
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\.\\.?/).+',
              message: 'src/shared may only contain relative imports (it reaches every process).'
            }
          ]
        }
      ]
    }
  },

  // The sandboxed preload can only require('electron'); everything else must
  // be a relative import that gets bundled in.
  {
    files: ['src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!electron$|\\.\\.?/).+',
              message: 'Sandboxed preload: only "electron" and relative imports.'
            }
          ]
        }
      ]
    }
  },

  // Plain JS (scripts/) has no type annotations to add.
  {
    files: ['**/*.{js,mjs}'],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' }
  },

  eslintConfigPrettier
)
