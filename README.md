# mute

Hide a repository's skills, MCP servers and agent instructions (`AGENTS.md`, `CLAUDE.md`) from your local checkout, without changing anything you commit.

## Install

Download the Apple Silicon binary from the latest release. The repository is private, so this uses your `gh` login.

```bash
mkdir -p ~/.local/bin
gh release download -R lawsonoates/mute -p mute-darwin-arm64 -O ~/.local/bin/mute --clobber
chmod +x ~/.local/bin/mute
```

Make sure `~/.local/bin` is on your `PATH`. Run the same commands to update.

To run from source instead:

```bash
git clone git@github.com:lawsonoates/mute.git ~/mute
cd ~/mute
bun install
bun link
```

`bun link` puts `mute` in `~/.bun/bin` as a link to this checkout. Don't use `bun install -g`, because it ignores the dependency override in `package.json` and the CLI crashes on start.

## Agent skill

[`skills/mute/SKILL.md`](skills/mute/SKILL.md) tells coding agents why files are missing and when to run `mute apply`. Install it globally, not in the repositories you mute:

```bash
bunx skills add lawsonoates/mute -g
```

## Usage

Run these anywhere inside a repository.

```bash
mute skill 'fd-*' sync-prep   # hide skills by name or glob
mute mcp linear notion         # remove MCP servers from the repo's MCP configs
mute instructions              # hide every AGENTS.md and CLAUDE.md
mute status                    # show what is muted and whether this checkout matches
mute apply                     # re-apply the profile, such as after a pull

mute restore skill 'fd-*'      # restore by the exact entry you muted
mute restore mcp linear
mute restore instructions
mute restore all               # clear the profile and restore this checkout
mute r all                     # r is short for restore
```

Names and globs must match something tracked in the repository. `mute status` lists the entries you have muted.

## How it works

- **Skills and instructions** are hidden with sparse checkout (`git sparse-checkout set --no-cone`). Git leaves the files out of your working tree but keeps them in the index, so `git status` stays clean and nothing is staged as deleted.
- **MCP servers** are removed from local copies of `.mcp.json`, `.cursor/mcp.json` and `.codex/config.toml`. Those files are marked skip-worktree, so git ignores your edited copy.
- **Skill roots** checked: `.agents/skills`, `.claude/skills`, `.codex/skills`, `.cursor/skills`, `.opencode/skills`.
- **Profiles** are stored per repository at `~/.config/mute/<host>/<owner>/<repo>.json`, keyed by the `origin` remote, so every clone and worktree shares one profile. Set `MUTE_HOME` to store them somewhere else.

## Caveats

- **Current worktree only.** `mute` changes only the worktree you run them in. Other worktrees pick up the profile change after `mute apply`.
- **Git hooks.** mute adds hooks to the repository's shared git config (`hook.mute`, `hook.mute-pre-commit`, `hook.mute-post-commit`), so every worktree runs them. They run alongside hooks from `core.hooksPath`, such as husky's, and only warn on failure. They point at the mute binary that set them up, so run `mute apply` once after moving that binary. `mute restore all` removes them.
- **New worktrees.** `git worktree add` copies the sparse patterns but not the edited MCP configs. The `post-checkout` hook applies the profile, so new worktrees and later checkouts match it on their own.
- **Commit checks.** Hooks such as husky's may read files that mute hides. The `pre-commit` hook writes hidden files back to disk before those hooks run, and the `post-commit` hook removes them again. They stay out of `git status` throughout. If a commit fails its checks, the files stay on disk until the next commit, checkout or `mute apply`. Agents can read them while they are there.
- **After a pull.** If upstream changes a muted MCP config, your local copy stays as it was. `mute status` reports it as out of date until you run `mute apply`.
- **Local changes.** mute refuses to edit an MCP config that has uncommitted changes.
- **Existing sparse checkout.** mute refuses to touch a worktree that uses sparse checkout for anything else.
- **Codex inline tables.** MCP servers defined as inline tables in `.codex/config.toml` can't be removed. Only `[mcp_servers.<name>]` tables are supported.
- **Repo scripts.** Scripts that read a hidden file, such as checks that parse `AGENTS.md`, may fail locally while that file is muted.

## Development

```bash
bun test
bun run check       # format and lint
bun run fix
bun run typecheck
```

## Release

1. Bump `version` in `package.json` and push the commit to `master`.
2. Run `bun run release` on an Apple Silicon Mac.

The script refuses to run unless you're on `master` with a clean tree that matches `origin/master`, and the version's tag doesn't exist yet. It then runs the checks and tests, compiles `dist/mute-darwin-arm64`, checks the binary reports the right version, pushes a `v<version>` tag and creates a GitHub release with the binary attached.
