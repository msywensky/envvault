// How easy a new master password is to guess, estimated by zxcvbn-ts. Anyone
// with a copy of a vault that has no setup code can guess its password
// offline, paying only Argon2id's cost for each guess. Messages are fixed
// strings that never quote the password.
import type { ZxcvbnFactory } from '@zxcvbn-ts/core'

/** zxcvbn's score 3: an estimated 10^8 guesses or more. */
export const MIN_PASSWORD_SCORE = 3

const ADVICE = 'Use several random words, or let your password manager generate one.'

let checker: Promise<ZxcvbnFactory> | null = null

// Loaded on first use: the dictionaries are a few MB, and only creating a
// vault needs them. Levenshtein matching is left off: it made one check take
// up to a second on the main thread, for the same scores.
function load(): Promise<ZxcvbnFactory> {
  checker ??= (async () => {
    const [{ ZxcvbnFactory }, common, en] = await Promise.all([
      import('@zxcvbn-ts/core'),
      import('@zxcvbn-ts/language-common'),
      import('@zxcvbn-ts/language-en')
    ])
    const { translations } = en
    return new ZxcvbnFactory({
      translations: {
        ...translations,
        warnings: {
          ...translations.warnings,
          userInputs: "Names from this computer and EnvVault's settings are easy to guess."
        }
      },
      graphs: common.adjacencyGraphs,
      dictionary: { ...common.dictionary, ...en.dictionary }
    })
  })().catch((err: unknown) => {
    checker = null
    throw err
  })
  return checker
}

/**
 * Why `password` is too easy to guess, or null. `context` holds words an
 * attacker would try first, such as the machine's and folders' names.
 */
export async function passwordProblem(password: string, context: string[]): Promise<string | null> {
  const { score, feedback } = (await load()).check(password, context)
  if (score >= MIN_PASSWORD_SCORE) return null
  return `${feedback.warning || 'This password is too easy to guess.'} ${ADVICE}`
}
