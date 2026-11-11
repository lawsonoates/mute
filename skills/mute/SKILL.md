---
name: mute
description: Explains how the mute CLI hides a repository's skills, MCP servers and AGENTS.md or CLAUDE.md files from a local checkout, and runs it. Use when tracked files such as skills, agent instructions or MCP configs are missing from disk, when sparse checkout or skip-worktree shows up, after creating a worktree, or when asked to mute or restore something.
---

# mute

mute hides parts of a repository's agent context from the local checkout only. What is committed and pushed never changes. Missing skills, missing `AGENTS.md` or `CLAUDE.md` files and missing MCP servers are usually muted on purpose.

## Check the state

Run `mute status` from anywhere in the repository. It prints the profile path, the muted skills, MCP servers and instructions, and whether this checkout matches the profile.

If `checkout` reports out of date, run `mute apply`.

A profile can mute skills by glob and name the ones to keep. `mute skill '*'` with `mute keep good-update` hides every skill except `good-update`, including skills added upstream later. If it reports sparse-checkout patterns not managed by mute, leave them alone and tell the user.

If `mute` is not on the `PATH`, tell the user rather than working around the missing files.

## Rules

- Treat muted files as intentionally absent. Leave them off disk, and leave muted instructions unread through `git show` or the remote, unless the user asks.
- mute's git hooks apply the profile after a checkout, merge or pull, and in new worktrees. If `mute status` still reports drift, run `mute apply`. It is safe to run repeatedly.
- Muted files reappear on disk while a commit's hooks run, and stay after a commit that fails its hooks. Leave them unread. They are removed after the next successful commit or checkout, or by `mute apply`.
- Before editing a muted file, run the matching `mute restore` command, and only when the user wants that file changed. Edits to a muted MCP config are otherwise ignored by git.
- Leave `git sparse-checkout`, `git update-index --skip-worktree` and `sparse.expectFilesOutsideOfPatterns` to mute. Changing them by hand breaks its state.
- Commit as normal. Hidden files and edited MCP configs never show in `git status` and never reach a commit.

## Usage

The user asks for a new worktree to fix a bug, without the fd skills or the Linear MCP server, and the fix turns out to need a change to `.mcp.json`.

```bash
git worktree add ../fix-auth -b fix-auth
cd ../fix-auth
mute skill 'fd-*'             # add to the profile and hide here
mute mcp linear
mute status                   # checkout: applied

mute r mcp linear             # restore before editing a muted config
# edit .mcp.json, commit
mute mcp linear               # mute again once the change is committed
```

Other existing worktrees keep their old state until `mute apply` runs in them or their next checkout or merge. `mute r` is short for `mute restore`, which takes the exact profile entry, such as `'fd-*'` rather than one skill it matched. `mute restore all` clears the profile.

## Errors

- **No skill matches** or **No MCP server matches**: the name or glob matches nothing tracked. Check the spelling against the repository.
- **Not muted** or **Not kept**: `mute restore` takes the exact entry from the profile, such as `fd-*` rather than `fd-a`. Run `mute status` to list entries.
- **Commit or discard local changes**: an MCP config has uncommitted changes. Ask the user what to do with them.
- **Sparse-checkout patterns that mute does not manage**: the worktree already uses sparse checkout. Ask the user before running `git sparse-checkout disable`.
- **Cannot remove MCP servers**: the Codex config defines servers as inline tables. Tell the user, since mute only supports `[mcp_servers.<name>]` tables.
