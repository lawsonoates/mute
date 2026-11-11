import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { key } from "../src/profile";

const bin = join(import.meta.dir, "../src/index.ts");

const toml = `model = "x"

[mcp_servers.linear]
url = "x"

[mcp_servers.chrome-devtools]
command = "npx"
args = ["chrome-devtools-mcp"]

[mcp_servers.chrome-devtools.env]
A = "1"

[mcp_servers."google"]
url = "g"
`;

let dir = "";
let env: Record<string, string | undefined> = {};

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, env });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

const cli = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["bun", bin, ...args], { cwd, env });
  return {
    code: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
};

const write = (path: string, text: string) => Bun.write(path, text);
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

// Stands in for husky: a pre-commit hook in a hooks directory.
const hooks = async (cwd: string, script: string) => {
  const file = join(dir, "hooks/pre-commit");
  await write(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
  git(cwd, "config", "core.hooksPath", join(dir, "hooks"));
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mute-"));
  env = {
    ...process.env,
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_AUTHOR_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    MUTE_HOME: join(dir, "home"),
  };
  const up = join(dir, "up");
  git(dir, "init", "-q", up);
  await write(
    join(up, ".mcp.json"),
    JSON.stringify({
      mcpServers: { "chrome-devtools": { command: "npx" }, linear: {} },
    }),
  );
  await write(join(up, ".codex/config.toml"), toml);
  await Promise.all(
    ["fd-a", "fd-b", "keep"].map((name) =>
      write(join(up, ".claude/skills", name, "SKILL.md"), name),
    ),
  );
  await write(join(up, "AGENTS.md"), "root");
  await write(join(up, "pkg/AGENTS.md"), "nested");
  await write(join(up, "pkg/index.ts"), "");
  git(up, "add", "-A");
  git(up, "commit", "-qm", "init");
  git(dir, "clone", "-q", up, join(dir, "down"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("mute", () => {
  test("hides skills, MCP servers and instructions without dirtying the index", async () => {
    const down = join(dir, "down");
    expect(cli(down, "skill", "fd-*").code).toBe(0);
    expect(cli(down, "mcp", "chrome-devtools").code).toBe(0);
    expect(cli(join(down, "pkg"), "instructions").code).toBe(0);

    expect(await exists(join(down, ".claude/skills/fd-a/SKILL.md"))).toBe(
      false,
    );
    expect(await exists(join(down, ".claude/skills/keep/SKILL.md"))).toBe(true);
    expect(await exists(join(down, "AGENTS.md"))).toBe(false);
    expect(await exists(join(down, "pkg/AGENTS.md"))).toBe(false);
    expect(
      Object.keys((await Bun.file(join(down, ".mcp.json")).json()).mcpServers),
    ).toEqual(["linear"]);
    const codex = Bun.TOML.parse(
      await Bun.file(join(down, ".codex/config.toml")).text(),
    ) as { mcp_servers: object };
    expect(Object.keys(codex.mcp_servers)).toEqual(["linear", "google"]);

    git(down, "add", "-A");
    expect(git(down, "status", "--porcelain")).toBe("");
    expect(cli(down, "status").stdout).toContain("checkout: applied");
  });

  test("hides a skill that is a symlink to one kept elsewhere", async () => {
    const up = join(dir, "up");
    const down = join(dir, "down");
    await write(join(up, "pkg/skills/linked/SKILL.md"), "linked");
    await symlink("../../pkg/skills/linked", join(up, ".claude/skills/linked"));
    git(up, "add", "-A");
    git(up, "commit", "-qm", "link");
    git(down, "pull", "-q");

    expect(cli(down, "skill", "linked").code).toBe(0);
    expect(await exists(join(down, ".claude/skills/linked"))).toBe(false);
    expect(await exists(join(down, "pkg/skills/linked/SKILL.md"))).toBe(true);
    expect(git(down, "status", "--porcelain")).toBe("");

    expect(cli(down, "restore", "skill", "linked").code).toBe(0);
    expect(await exists(join(down, ".claude/skills/linked/SKILL.md"))).toBe(
      true,
    );
  });

  test("keeps named skills visible when a glob mutes the rest", async () => {
    const down = join(dir, "down");
    expect(cli(down, "skill", "*").code).toBe(0);
    expect(cli(down, "keep", "keep").code).toBe(0);

    expect(await exists(join(down, ".claude/skills/fd-a/SKILL.md"))).toBe(
      false,
    );
    expect(await exists(join(down, ".claude/skills/keep/SKILL.md"))).toBe(true);
    expect(cli(down, "status").stdout).toContain("keep: keep (1)");

    expect(cli(down, "restore", "keep", "nope").stderr).toContain(
      "Not kept: nope",
    );
    expect(cli(down, "restore", "keep", "keep").code).toBe(0);
    expect(await exists(join(down, ".claude/skills/keep/SKILL.md"))).toBe(
      false,
    );
  });

  test.each([
    ["a fast-forward pull", []],
    ["a pull that rebases local commits", ["local"]],
  ])("applies the profile after %s", async (_, commits) => {
    const up = join(dir, "up");
    const down = join(dir, "down");
    cli(down, "skill", "fd-*");
    cli(down, "mcp", "chrome-devtools");
    for (const message of commits) {
      await write(join(down, "pkg/index.ts"), message);
      git(down, "commit", "-qam", message);
    }
    await write(join(up, ".claude/skills/fd-c/SKILL.md"), "fd-c");
    await write(
      join(up, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "chrome-devtools": {}, linear: {}, sentry: {} },
      }),
    );
    git(up, "add", "-A");
    git(up, "commit", "-qm", "add fd-c and sentry");
    git(down, "pull", "-q", "--rebase");

    expect(await exists(join(down, ".claude/skills/fd-c"))).toBe(false);
    expect(
      Object.keys((await Bun.file(join(down, ".mcp.json")).json()).mcpServers),
    ).toEqual(["linear", "sentry"]);
    expect(git(down, "status", "--porcelain")).toBe("");
    expect(cli(down, "status").stdout).toContain("checkout: applied");
  });

  test("restore brings back the committed files", async () => {
    const down = join(dir, "down");
    cli(down, "skill", "fd-a");
    cli(down, "mcp", "chrome-devtools");
    expect(cli(down, "restore", "mcp", "chrome-devtools").code).toBe(0);
    expect(await Bun.file(join(down, ".mcp.json")).text()).toBe(
      git(down, "show", "HEAD:.mcp.json"),
    );
    expect(cli(down, "r", "all").code).toBe(0);
    expect(await exists(join(down, ".claude/skills/fd-a/SKILL.md"))).toBe(true);
    expect(git(down, "status", "--porcelain")).toBe("");
    expect(git(down, "config", "--get", "core.sparseCheckout").trim()).not.toBe(
      "true",
    );
    expect(git(down, "config", "--local", "--list")).not.toContain("hook.mute");
  });

  test("writes overlays in a new worktree from the post-checkout hook", async () => {
    const down = join(dir, "down");
    cli(down, "skill", "keep");
    cli(down, "mcp", "chrome-devtools");
    // A hooks directory, as husky sets up, must not stop the config hook.
    git(down, "config", "core.hooksPath", ".husky/_");
    const tree = join(dir, "tree");
    git(down, "worktree", "add", "-q", tree);

    expect(await exists(join(tree, ".claude/skills/keep/SKILL.md"))).toBe(
      false,
    );
    expect(
      Object.keys((await Bun.file(join(tree, ".mcp.json")).json()).mcpServers),
    ).toEqual(["linear"]);
    expect(cli(tree, "status").stdout).toContain("checkout: applied");
    expect(git(tree, "status", "--porcelain")).toBe("");
  });

  test("the hook warns instead of failing the checkout", async () => {
    const down = join(dir, "down");
    cli(down, "mcp", "chrome-devtools");
    await write(
      cli(down, "status").stdout.match(/profile: (.+)/u)?.[1] ?? "",
      "{",
    );
    const result = Bun.spawnSync(["git", "switch", "-c", "other"], {
      cwd: down,
      env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("Invalid profile");
  });

  test("commit checks see muted files, which are hidden again afterwards", async () => {
    const down = join(dir, "down");
    cli(down, "skill", "fd-*");
    cli(down, "mcp", "chrome-devtools");
    cli(down, "instructions");
    await hooks(
      down,
      "test -f .claude/skills/fd-a/SKILL.md && test -f pkg/AGENTS.md && ! grep -q chrome-devtools .mcp.json",
    );
    await write(join(down, "pkg/index.ts"), "x");
    git(down, "commit", "-qam", "change");

    expect(await exists(join(down, ".claude/skills/fd-a/SKILL.md"))).toBe(
      false,
    );
    expect(await exists(join(down, ".claude/skills/fd-a"))).toBe(false);
    expect(await exists(join(down, "pkg/AGENTS.md"))).toBe(false);
    expect(await exists(join(down, "pkg/index.ts"))).toBe(true);
    expect(git(down, "status", "--porcelain")).toBe("");
    expect(cli(down, "status").stdout).toContain("checkout: applied");
  });

  test("the next checkout hides files left by a failed commit", async () => {
    const down = join(dir, "down");
    cli(down, "skill", "fd-a");
    await hooks(down, "exit 1");
    await write(join(down, "pkg/index.ts"), "x");
    git(down, "add", "pkg/index.ts");
    const result = Bun.spawnSync(["git", "commit", "-qm", "change"], {
      cwd: down,
      env,
    });
    expect(result.exitCode).not.toBe(0);
    expect(await exists(join(down, ".claude/skills/fd-a/SKILL.md"))).toBe(true);
    expect(git(down, "status", "--porcelain")).toBe("M  pkg/index.ts\n");

    git(down, "switch", "-q", "-c", "other");
    expect(await exists(join(down, ".claude/skills/fd-a/SKILL.md"))).toBe(
      false,
    );
  });

  test("applies the shared profile in a worktree from an unmuted checkout", async () => {
    const down = join(dir, "down");
    const tree = join(dir, "tree");
    git(down, "worktree", "add", "-q", tree);
    cli(down, "skill", "keep");

    expect(await exists(join(tree, ".claude/skills/keep/SKILL.md"))).toBe(true);
    expect(cli(tree, "apply").code).toBe(0);
    expect(await exists(join(tree, ".claude/skills/keep/SKILL.md"))).toBe(
      false,
    );
  });

  test("rejects names that match nothing", () => {
    const result = cli(join(dir, "down"), "mcp", "nope");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No MCP server matches nope");
  });

  test("refuses to overwrite local changes to an MCP config", async () => {
    const down = join(dir, "down");
    await write(
      join(down, ".mcp.json"),
      '{"mcpServers":{"chrome-devtools":{}}}',
    );
    const result = cli(down, "mcp", "chrome-devtools");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("local changes to .mcp.json");
  });

  test("leaves sparse-checkout patterns it does not own alone", () => {
    const down = join(dir, "down");
    git(down, "sparse-checkout", "set", "--no-cone", "/pkg/");
    const result = cli(down, "skill", "fd-a");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not manage");
  });

  test("refuses MCP servers it cannot remove line by line", async () => {
    const up = join(dir, "up");
    await write(
      join(up, ".codex/config.toml"),
      'mcp_servers = { inline = { url = "x" } }\n',
    );
    git(up, "commit", "-qam", "inline");
    const down = join(dir, "down");
    git(down, "pull", "-q");
    const result = cli(down, "mcp", "inline");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Cannot remove MCP servers");
  });
});

describe("key", () => {
  test.each([
    ["git@github.com:optechai/support.git", "github.com/optechai/support"],
    ["https://github.com/optechai/support.git", "github.com/optechai/support"],
    [
      "ssh://git@github.com:22/optechai/support/",
      "github.com/optechai/support",
    ],
    ["/tmp/../repos/up", "local/tmp/repos/up"],
  ])("%s", (url, expected) => {
    expect(key(url)).toBe(expected);
  });
});
