import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
const exists = (path: string) => Bun.file(path).exists();

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

  test("keeps overlays across pulls and refreshes them on apply", async () => {
    const up = join(dir, "up");
    const down = join(dir, "down");
    cli(down, "mcp", "chrome-devtools");
    await write(
      join(up, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "chrome-devtools": {}, linear: {}, sentry: {} },
      }),
    );
    git(up, "commit", "-qam", "add sentry");
    git(down, "pull", "-q", "--rebase");

    expect(git(down, "status", "--porcelain")).toBe("");
    expect(cli(down, "status").stdout).toContain("out of date (.mcp.json)");
    cli(down, "apply");
    expect(
      Object.keys((await Bun.file(join(down, ".mcp.json")).json()).mcpServers),
    ).toEqual(["linear", "sentry"]);
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
  });

  test("writes overlays in a worktree that inherited the patterns", async () => {
    const down = join(dir, "down");
    cli(down, "skill", "keep");
    cli(down, "mcp", "chrome-devtools");
    const tree = join(dir, "tree");
    git(down, "worktree", "add", "-q", tree);

    // git worktree add copies the sparse patterns but not the overlay files.
    expect(await exists(join(tree, ".claude/skills/keep/SKILL.md"))).toBe(
      false,
    );
    expect(await exists(join(tree, ".mcp.json"))).toBe(false);
    expect(cli(tree, "status").stdout).toContain("out of date");

    expect(cli(tree, "apply").code).toBe(0);
    expect(
      Object.keys((await Bun.file(join(tree, ".mcp.json")).json()).mcpServers),
    ).toEqual(["linear"]);
    expect(cli(tree, "status").stdout).toContain("checkout: applied");
    expect(git(tree, "status", "--porcelain")).toBe("");
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
