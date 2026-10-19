# EnvVault

[![CI](https://github.com/msywensky/envvault/actions/workflows/ci.yml/badge.svg)](https://github.com/msywensky/envvault/actions/workflows/ci.yml)

A desktop app (Electron + Vue 3 + TypeScript, macOS and Windows) that keeps each project's `.env` file in sync between your machines, through an **encrypted** vault: a folder synced between them (such as a Google Drive folder), or a private git repository. The sync folder or the git host only ever sees ciphertext. Plaintext stays in your repos, which EnvVault checks are git-ignored before it writes anything.

![Repositories view](docs/repos.png)

## Contents

- [How it works](#how-it-works)
- [Security](#security)
- [Setup](#setup)
- [Using it](#using-it)
  - [Machine-specific keys](#machine-specific-keys)
  - [`.env.example` checks](#envexample-checks)
  - [Editing the vault copy](#editing-the-vault-copy)
  - [Automatic pull](#automatic-pull)
  - [Mini mode](#mini-mode)
  - [Command line](#command-line)
  - [Claude Code skill](#claude-code-skill)
  - [Recovery](#recovery)
- [Settings](#settings)
- [Development](#development)
- [Roadmap](#roadmap)
- [License](#license)

## How it works

```
Projects folder (each machine)          Vault folder (synced by Google Drive etc.)
  api/.env      ── push ──▶ encrypt ──▶   api.env.enc
  web/.env      ◀── pull ── decrypt ◀──   web.env.enc
                                          meta.json   (KDF params, salt, key check)
```

The vault can also be a **private git repository** instead of a synced folder: the same files, on one branch, which EnvVault fetches and pushes itself (see [Git vaults](docs/security.md#git-vaults)).

**Sync status** is three-way: local file, vault copy, and what this machine last synced. That separates "local newer", "vault newer" and "conflict". A vault copy whose version went backwards (a rollback) is shown as a conflict, never offered as a simple pull. The one exception is when it is byte-identical to your local file: then nothing would change either way, and it shows as in sync.

| Status      | Meaning                                                                                      | Action                  |
| ----------- | -------------------------------------------------------------------------------------------- | ----------------------- |
| In sync     | Local and vault are byte-identical, apart from machine-specific values                       | —                       |
| Local only  | Never pushed                                                                                 | Push                    |
| Local newer | Only you changed it since the last sync                                                      | Push                    |
| Vault newer | Only another machine changed it                                                              | Pull                    |
| Conflict    | Both changed, or they differ and this machine never synced them, or the vault went backwards | Keep local / Keep vault |
| Vault only  | In the vault, but the repo isn't in your projects folder                                     | —                       |
| No .env     | Nothing on either side                                                                       | —                       |

Every push and pull shows a confirmation with the **key names** that will be added, removed or changed, never their values. Pushing over a vault copy that someone else changed needs an explicit "overwrite anyway". A pull first saves your current `.env` as `.env.bak.<timestamp>`.

To see exactly what a pull would change, click **Show raw diff** in the pull dialog. It shows a line-by-line diff from your `.env` to the vault copy with every value masked (`KEY=••••••••`); comments are shown as they are. Click **Show values** to see the values; they are hidden again after a minute (see [Env values](docs/security.md#env-values)).

![Resolving a conflict: key names only, explicit overwrite](docs/conflict.png)

## Security

EnvVault encrypts each `.env` with XChaCha20-Poly1305, under a key derived with Argon2id from your master password and a setup code that each of your machines keeps (on by default, always for a git vault). The sync folder or git host sees only ciphertext, your repo names, file sizes and when they changed. The key never leaves EnvVault's main process and is wiped when it locks, and env values reach the app's window only when you ask to see them. EnvVault doesn't protect against malware running as you while it's unlocked, a weak password without a setup code, or the plaintext `.env` files in your repos. [Security design and threat model](docs/security.md) has the details, including the vault's file format.

## Setup

Requirements: Node.js 22 or newer, git, and either a folder synced between your machines (for example `My Drive/EnvVault` in Google Drive for desktop) or a private git repository (git 2.32 or newer). The [GitHub CLI](https://cli.github.com), signed in with `gh auth login`, lets EnvVault create and list GitHub repositories for you; it's optional.

```sh
npm install
npm run dev        # run the app with hot reload
npm test           # unit + integration tests
npm run build      # typecheck and build to out/
```

## Using it

1. **First machine:** choose your projects folder (the folder that contains your git repos) and the vault, then create the vault with a master password of at least 12 characters. The vault is either:
   - **a synced folder:** pick it with the folder picker;
   - **a private git repository:** **Create a new vault repository** makes a private one on your GitHub account through the GitHub CLI, or, without it, opens GitHub's new-repository page so you can paste its URL. **Select an existing one** lists your private GitHub repositories, and always takes a pasted URL (GitHub, GitLab, a server of your own). Use a repository just for the vault: EnvVault refuses one that holds other files, and one that isn't private.
     Creating it also offers **Require a setup code on every machine**, on by default and always on for a git vault. EnvVault then shows the vault's setup code once (`EV-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXX`): save it in your password manager next to the master password, and type its last group to continue. You can show it again in Settings, after entering the password.
2. **Other machines:** choose the same vault folder (wait for Drive to finish syncing first) or the same repository, and unlock it with the same password, plus the setup code the first time on each machine. EnvVault won't offer to create a vault where encrypted files already are.
3. Push and pull from the Repositories table. For a conflict, pick **Keep local** (push, overwriting the vault copy) or **Keep vault** (pull, backing up your local file first).

### Machine-specific keys

Some values differ between machines, such as a local path. Put `# envvault:local` on the line directly above such a key:

```sh
API_URL=https://api.example.com
# envvault:local
DATA_DIR=/Users/me/data
```

- A push uploads the key without its value (`DATA_DIR=` under the marker), so the value never leaves this machine, and changing it doesn't make the repo "local newer".
- A pull never overwrites or deletes a key that is marked in your `.env` or in the vault copy. It keeps your line and adds the marker if your file didn't have it. A marked key you don't have yet is written empty, and the pull dialog lists it so you can fill it in.
- If the vault marks a key but your `.env` doesn't, pushing uploads your value and drops the marker. The push dialog warns you first.
- A marked key must be assigned only once in the file.

### `.env.example` checks

If a repo has a `.env.example`, the push and pull dialogs compare it with the `.env` you'll end up with (your file on push, the pulled result on pull). They warn, but never block, about:

- keys `.env.example` lists that your `.env` doesn't have. Keys commented out in the example count as optional;
- keys your `.env` has that `.env.example` doesn't document;
- values that are the same in both files and look like secrets, since `.env.example` is usually committed. A value looks like a secret if it is a URL with a password for a non-local host, 8+ characters under a key name such as `*_SECRET`, `*_TOKEN`, `*_PASSWORD` or `*_KEY`, or a long token-like string. Localhost URLs, ports, other plain values and browser-public keys (`VITE_`, `NEXT_PUBLIC_`, ...) are never flagged.

You can turn the checks off in Settings.

### Editing the vault copy

Click **Edit** on a repo to change its vault copy in a table of keys and values, without a local `.env`. On a repo with no `.env` and no vault copy, this creates one.

- Values are masked until you click **Show**. You can type or paste a new value into a masked field without displaying it. Multi-line values (such as a PEM key) need **Show** to edit.
- You can add, change and remove keys. Machine-specific keys are listed but have no value to edit, since the vault doesn't store one.
- Comments, blank lines, `export`, spacing and line endings stay as they are. A changed value keeps its line's prefix and trailing comment, and is quoted only as much as dotenv needs to read it back exactly.
- **Review changes** lists the key names that change. **Save to vault** writes a new version, unless the vault copy changed since you opened the editor; then reload and edit again.
- Saving never touches your local `.env` directly. A repo that has one shows "Vault newer" afterwards; automatic pull brings the edit in right away (or click **Pull** if it's off), keeping machine-specific values.

### Automatic pull

While EnvVault is unlocked, it checks every minute (and right after you unlock or save an edit) for repos whose vault copy changed on another machine while your `.env` didn't, and pulls them for you. You get a toast, and if EnvVault isn't the focused window, a system notification. macOS shows notifications only for code-signed apps, so unsigned builds (including dev runs) badge the Dock icon with the number of pulls and bounce it once instead; the badge clears when you switch to EnvVault. On Windows the taskbar button flashes if a notification can't be shown.

- It never pulls a conflict, a rollback, or a repo whose `.env` isn't git-ignored or is tracked; those keep their **Pull** button.
- It creates a missing `.env` when the vault has a copy, including one you deleted.
- It saves a backup first, like a manual pull. A running dev server that watches `.env` may restart when the file changes.
- It stops when EnvVault locks; it doesn't keep the vault unlocked. Turn it off in Settings.

### Mini mode

Click **Mini** next to a repo to shrink EnvVault to a small window, two rows tall, kept above your other windows: that repo's **Push** (or **Pull**) button next to the window's controls, and its status below. Hover over the status for the vault copy's version. Click **Full view** to go back.

<img src="docs/mini.png" width="422" alt="Mini mode: one repo's Push button and status">

- The status updates when the repo's `.env` changes, when you switch to the window, and every minute. These checks don't count as activity, so they don't keep the vault unlocked.
- **Push** still shows the review first: the window grows for it, then shrinks back.
- A conflict shows **Resolve…**, which goes back to the full window to choose which copy to keep.
- When EnvVault locks, the mini window asks for the master password. A machine that still needs the setup code unlocks in the full window.
- **On top** turns keeping it above other windows on or off. It's the same setting as _Keep the mini window on top_ in Settings.

### Command line

Turn on **Allow command-line access** in Settings. Then, while EnvVault is running and unlocked, run `envvault` inside a repo in your projects folder:

```sh
envvault status                  # this repo's status (--all for every repo)
envvault push                    # shows the key changes, asks, then pushes
envvault push --dry-run          # only shows them, with a token...
envvault push --expect <token>   # ...that pushes exactly what you saw, if nothing changed since
```

- Run `npm link` in this repo once to put `envvault` on your PATH, or run `node out/cli/envvault.mjs`. `npm run build` builds it. In a packaged app it's in `app.asar.unpacked/out/cli/`, and needs Node 22 or newer.
- It shows key names only, never values.
- It pushes only one-sided changes. If the vault copy changed on another machine, it tells you to resolve it in the app.
- Options:
  - `--repo <name>` picks a repo by name instead of the current folder;
  - `--json` prints JSON;
  - `--yes` pushes without asking.
- Exit codes:
  - 0: done;
  - 1: refused or failed;
  - 2: usage;
  - 3: locked;
  - 4: EnvVault isn't running, or command-line access is off.
- It doesn't count as activity, so EnvVault still auto-locks (if auto-lock is on); unlock it in the app.
- There's no pull command: automatic pull covers it.

### Claude Code skill

With command-line access on, click **Install** next to _Claude Code skill_ in Settings. That writes `~/.claude/skills/envvault/SKILL.md`, so in any project you can ask Claude to check or push the repo's `.env`, or type `/envvault`.

- Claude runs `status` and `push --dry-run` on its own, shows you the key changes and warnings, and asks before the real push. Claude Code also asks you to approve that command.
- The skill points at this copy of EnvVault's command. If you move or update EnvVault, Settings shows it as out of date: click **Update**.
- The skill tells Claude never to read `.env` files. To enforce that for Claude's file tools, add `Read(**/.env)` and `Read(**/.env.bak.*)` to the `deny` list of your Claude Code permissions.
- If Claude Code runs commands in its sandbox and the command reports that EnvVault isn't reachable, allow EnvVault's socket in the sandbox settings, or let the command run outside the sandbox.

### Recovery

There is no backdoor. If you lose the master password, or the setup code and every machine that has it, the vault can't be opened. Your repos' plaintext `.env` files are your remaining copies, so you could start a new vault and push them again.

## Settings

| Setting             | Default   | Notes                                                                   |
| ------------------- | --------- | ----------------------------------------------------------------------- |
| Projects folder     | —         | Repos are its direct subfolders that contain `.git`                     |
| Vault               | —         | A synced folder or a private git repository. Changing it locks EnvVault |
| Setup code          | —         | Shows this machine's setup code for the vault, after the password       |
| Machine name        | hostname  | Shown to other machines as "updated by"                                 |
| Auto-lock           | On, 5 min | 1–120 minutes of inactivity. Turning it off asks you to confirm first   |
| .env.example checks | On        | Warnings in the push and pull dialogs                                   |
| Automatic pull      | On        | Every minute while unlocked; one-sided changes only                     |
| Command-line access | Off       | The `envvault` command and the Claude Code skill                        |
| Mini window on top  | On        | Keeps the mini window above other windows                               |

Settings are stored in Electron's `userData` folder (`config.json`). The per-machine sync state, which holds no secrets, is stored next to it in `state.json`. While command-line access is on, its socket (`cli.sock`, macOS) and token (`cli-token`) are there too, a git vault's mirror is in `git-vaults/`, and vault secrets (sealed) are in `vault-secrets.json`.

## Development

```
src/
  core/      pure, unit-tested logic: crypto, .env diff, sync status, path safety
  main/      Electron main process: window, IPC, session, vault, repos, git, sync
  preload/   contextBridge API (sandboxed, bundled)
  shared/    channel names and types shared by all of them
  renderer/  Vue 3 UI
  cli/       the envvault command (plain Node; talks to the app over a socket)
tests/       Vitest: unit tests for core/, integration tests for main/
```

- `npm run lint`, `npm run typecheck` and `npm test` run in CI on macOS and Windows.
- `tests/sync.test.ts` exercises the real push/pull flows with real git and real crypto in temp folders, simulating two machines, over a vault folder and over a local git repository.
- To test without touching your real settings, run `npm run dev:profile -- [name]` (default name `test`). Each profile keeps its own settings and sync state in `envvault-<name>` next to the real data folder, and profiles can run side by side, so two of them can act as two "machines" on one computer. Add `--reset` to start the profile from scratch. A profile doesn't isolate the folders you pick in it, so choose a scratch vault folder and projects folder. Under the hood this sets `ENVVAULT_PROFILE=<name>`, which works only in unpackaged runs.

## Roadmap

- Unlock with the Bitwarden CLI.
- Run a command with the vault copy's values in its environment, without a `.env`.
- Change the master password.
- Packaged installers.

## License

[MIT](LICENSE)
