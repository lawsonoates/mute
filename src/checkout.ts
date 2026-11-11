import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import { type GitError, Service as Git } from "./git";
import { key, type Profile } from "./profile";

export class Foreign extends Schema.TaggedError<Foreign>()("Foreign", {}) {
  override get message() {
    return "This worktree has sparse-checkout patterns that mute does not manage. Run `git sparse-checkout disable` first.";
  }
}

export class Dirty extends Schema.TaggedError<Dirty>()("Dirty", {
  files: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Commit or discard local changes to ${this.files.join(", ")} first`;
  }
}

export class Unmatched extends Schema.TaggedError<Unmatched>()("Unmatched", {
  kind: Schema.String,
  name: Schema.String,
}) {
  override get message() {
    return `No ${this.kind} matches ${this.name}`;
  }
}

export class Unsupported extends Schema.TaggedError<Unsupported>()(
  "Unsupported",
  { file: Schema.String, detail: Schema.String },
) {
  override get message() {
    return `Cannot remove MCP servers from ${this.file}: ${this.detail}`;
  }
}

export type Error =
  Dirty | Foreign | GitError | PlatformError | Unmatched | Unsupported;

export const matches = (globs: readonly string[], name: string) =>
  globs.some((glob) => new Bun.Glob(glob).match(name));

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface Format {
  readonly servers: (text: string) => string[];
  readonly strip: (text: string, names: ReadonlySet<string>) => string;
}

const json: Format = {
  servers: (text) => {
    const data: unknown = JSON.parse(text);
    return record(data) && record(data.mcpServers)
      ? Object.keys(data.mcpServers)
      : [];
  },
  strip: (text, names) => {
    const data: unknown = JSON.parse(text);
    if (!(record(data) && record(data.mcpServers))) {
      return text;
    }
    data.mcpServers = Object.fromEntries(
      Object.entries(data.mcpServers).filter(([name]) => !names.has(name)),
    );
    return `${JSON.stringify(data, null, 2)}\n`;
  },
};

const unquote = (part: string) => {
  if (part.startsWith('"')) {
    return String(JSON.parse(part));
  }
  if (part.startsWith("'")) {
    return part.slice(1, -1);
  }
  return part;
};

// Splits a dotted TOML key such as mcp_servers."a.b".env into its parts.
const segments = (header: string) =>
  [...header.matchAll(/\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^.\s"']+)\s*\.?/gu)].map(
    ([, part = ""]) => unquote(part),
  );

const parse = (text: string) => {
  const data: unknown = Bun.TOML.parse(text);
  return record(data) ? data : {};
};

const tables = (text: string) => {
  const data = parse(text);
  return record(data.mcp_servers) ? data.mcp_servers : {};
};

const toml: Format = {
  servers: (text) => Object.keys(tables(text)),
  strip: (text, names) => {
    let skip = false;
    const kept = text.split("\n").filter((line) => {
      const header = /^\s*\[\[?([^[\]]+)\]\]?\s*(?:#.*)?$/u.exec(line);
      if (header) {
        const [scope, name = ""] = segments(header[1] ?? "");
        skip = scope === "mcp_servers" && names.has(name);
      }
      return !skip;
    });
    const out = kept.join("\n");
    // Line edits cannot see inline tables or multiline values, so prove the
    // result only lost the muted servers.
    const expected = {
      ...parse(text),
      mcp_servers: Object.fromEntries(
        Object.entries(tables(text)).filter(([name]) => !names.has(name)),
      ),
    };
    if (
      !Bun.deepEquals({ ...parse(out), mcp_servers: tables(out) }, expected)
    ) {
      throw new globalThis.Error(
        "servers must be defined as [mcp_servers.<name>] tables",
      );
    }
    return out;
  },
};

const configs = [
  { file: ".mcp.json", format: json },
  { file: ".cursor/mcp.json", format: json },
  { file: ".codex/config.toml", format: toml },
];

const roots = [
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
  ".cursor/skills",
  ".opencode/skills",
];

const instructions = ["!**/AGENTS.md", "!**/CLAUDE.md"];

const escape = (path: string) => path.replace(/[\\*?[]/gu, "\\$&");

// mute writes "/*" followed only by exclusions; anything else is someone else's.
const owned = (patterns: readonly string[]) =>
  patterns[0] === "/*" &&
  patterns.slice(1).every((line) => line.startsWith("!"));

const split = (out: string) => out.split("\0").filter((entry) => entry !== "");

export interface Overlay {
  readonly file: string;
  readonly servers: readonly string[];
  readonly text: string;
}

export interface Plan {
  readonly instructions: boolean;
  readonly overlays: readonly Overlay[];
  readonly patterns: readonly string[];
  readonly skills: readonly string[];
}

export interface Status extends Plan {
  readonly drift: readonly string[];
  readonly foreign: boolean;
}

export interface Interface {
  /** Profile key derived from the origin remote. */
  readonly repo: Effect.Effect<string, GitError>;
  /** Names of the skills tracked in the repository. */
  readonly skills: Effect.Effect<readonly string[], Error>;
  /** Names of the MCP servers in the tracked config files. */
  readonly servers: Effect.Effect<readonly string[], Error>;
  readonly apply: (profile: Profile) => Effect.Effect<Plan, Error>;
  readonly status: (profile: Profile) => Effect.Effect<Status, Error>;
  /**
   * Sets the repository's hooks to run `command` with the hook's event, or
   * removes them. The hooks live in the shared config, so every worktree runs
   * them.
   */
  readonly hook: (command: string | undefined) => Effect.Effect<void, GitError>;
  /** Writes hidden files back to disk, such as for a commit's checks. */
  readonly reveal: Effect.Effect<void, Error>;
  /** Removes hidden files that `reveal` wrote. */
  readonly conceal: Effect.Effect<void, Error>;
}

export const events = [
  "post-checkout",
  "post-merge",
  "pre-commit",
  "post-commit",
] as const;

export class Service extends Context.Service<Service, Interface>()(
  "mute/Checkout",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const dirs = Effect.fn("Checkout.dirs")(function* () {
      // A skill is a directory with at least one tracked file under a root, or
      // a symlink there to a skill the repository keeps somewhere else.
      const entries = split(
        yield* git.run("ls-files", "-s", "-z", "--", ...roots),
      )
        .map((entry) => ({
          link: entry.startsWith("120000 "),
          parts: entry.slice(entry.indexOf("\t") + 1).split("/"),
        }))
        .filter(
          (entry) =>
            entry.parts.length >= 4 || (entry.parts.length === 3 && entry.link),
        )
        .map((entry) => ({
          dir: entry.parts.slice(0, 3).join("/"),
          name: entry.parts[2] ?? "",
        }));
      return new Map(
        [...Map.groupBy(entries, (entry) => entry.name)].map(([name, list]) => [
          name,
          [...new Set(list.map((entry) => entry.dir))].sort(),
        ]),
      );
    });

    const tracked = Effect.fn("Checkout.tracked")(function* () {
      const files = new Set(
        split(
          yield* git.run(
            "ls-files",
            "-z",
            "--",
            ...configs.map((config) => config.file),
          ),
        ),
      );
      return yield* Effect.forEach(
        configs.filter((config) => files.has(config.file)),
        (config) =>
          git
            .run("show", `:${config.file}`)
            .pipe(Effect.map((text) => ({ ...config, text }))),
      );
    });

    const attempt = <A>(file: string, run: () => A) =>
      Effect.try({
        catch: (cause) =>
          new Unsupported({
            detail:
              cause instanceof globalThis.Error ? cause.message : String(cause),
            file,
          }),
        try: run,
      });

    const plan = Effect.fn("Checkout.plan")(function* (profile: Profile) {
      const skills = [...(yield* dirs())]
        .filter(
          ([name]) =>
            matches(profile.skills, name) && !matches(profile.keep, name),
        )
        .sort(([a], [b]) => a.localeCompare(b));
      const overlays = (yield* Effect.forEach(yield* tracked(), (config) =>
        Effect.gen(function* () {
          const servers = (yield* attempt(config.file, () =>
            config.format.servers(config.text),
          )).filter((name) => matches(profile.mcps, name));
          if (servers.length === 0) {
            return [];
          }
          const text = yield* attempt(config.file, () =>
            config.format.strip(config.text, new Set(servers)),
          );
          return [{ file: config.file, servers, text }];
        }),
      )).flat();
      const patterns = [
        // No trailing slash, so the pattern also matches a symlinked skill.
        ...skills.flatMap(([, found]) =>
          found.map((dir) => `!/${escape(dir)}`),
        ),
        ...(profile.instructions ? instructions : []),
        ...overlays.map((overlay) => `!/${escape(overlay.file)}`),
      ];
      return {
        instructions: profile.instructions,
        overlays,
        patterns: patterns.length === 0 ? [] : ["/*", ...patterns],
        skills: skills.map(([name]) => name),
      };
    });

    const current = Effect.fn("Checkout.current")(function* () {
      const result = yield* git.exec("sparse-checkout", "list");
      return result.code === 0
        ? Option.some(result.stdout.split("\n").filter((line) => line !== ""))
        : Option.none();
    });

    const skipped = Effect.fn("Checkout.skipped")(function* () {
      const out = yield* git.run(
        "ls-files",
        "-t",
        "-z",
        "--",
        ...configs.map((config) => config.file),
      );
      return new Set(
        split(out)
          .filter((entry) => entry.startsWith("S "))
          .map((entry) => entry.slice(2)),
      );
    });

    // Paths outside mute's patterns. Overlays are excluded because they stay on
    // disk with their servers removed.
    const hidden = Effect.fn("Checkout.hidden")(function* () {
      const have = yield* current();
      if (Option.isNone(have) || !owned(have.value)) {
        return [];
      }
      const overlays = new Set(configs.map((config) => config.file));
      return split(yield* git.run("ls-files", "-t", "-z"))
        .filter((entry) => entry.startsWith("S "))
        .map((entry) => entry.slice(2))
        .filter((file) => !overlays.has(file));
    });

    const servers = Effect.gen(function* () {
      const found = yield* Effect.forEach(yield* tracked(), (config) =>
        attempt(config.file, () => config.format.servers(config.text)),
      );
      return [...new Set(found.flat())].sort();
    });

    return Service.of({
      apply: Effect.fn("Checkout.apply")(function* (profile) {
        const root = yield* git.root;
        const want = yield* plan(profile);
        const have = yield* current();
        if (Option.isSome(have) && !owned(have.value)) {
          return yield* new Foreign();
        }
        const hidden = yield* skipped();
        const kept = new Set(want.overlays.map((overlay) => overlay.file));
        // Git only restores a file it finds missing, so drop overlays that are
        // going away before changing the patterns.
        yield* Effect.forEach(
          [...hidden].filter((file) => !kept.has(file)),
          (file) => fs.remove(path.join(root, file), { force: true }),
          { discard: true },
        );
        const fresh = [...kept].filter((file) => !hidden.has(file));
        if (
          fresh.length > 0 &&
          (yield* git.run("status", "--porcelain", "-z", "--", ...fresh)) !== ""
        ) {
          return yield* new Dirty({ files: fresh });
        }
        if (want.patterns.length === 0) {
          if (Option.isSome(have)) {
            yield* git.run("sparse-checkout", "disable");
            yield* git.exec(
              "config",
              "--worktree",
              "--unset",
              "sparse.expectFilesOutsideOfPatterns",
            );
          }
          return want;
        }
        yield* git.run("sparse-checkout", "set", "--no-cone", ...want.patterns);
        // Overlays sit on skip-worktree paths; without this git would notice
        // them and start tracking their changes.
        yield* git.run(
          "config",
          "--worktree",
          "sparse.expectFilesOutsideOfPatterns",
          "true",
        );
        yield* Effect.forEach(
          want.overlays,
          (overlay) =>
            Effect.gen(function* () {
              const target = path.join(root, overlay.file);
              yield* fs.makeDirectory(path.dirname(target), {
                recursive: true,
              });
              yield* fs.writeFileString(target, overlay.text);
            }),
          { discard: true },
        );
        return want;
      }),
      conceal: Effect.gen(function* () {
        const root = yield* git.root;
        const files = yield* hidden();
        yield* Effect.forEach(
          files,
          (file) => fs.remove(path.join(root, file), { force: true }),
          { concurrency: 16, discard: true },
        );
        // Git drops directories it leaves empty, so do the same. Deepest
        // first, so a parent is empty by the time it is checked.
        const dirs = [
          ...new Set(
            files.flatMap((file) =>
              file
                .split("/")
                .slice(0, -1)
                .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
            ),
          ),
        ].sort((a, b) => b.split("/").length - a.split("/").length);
        yield* Effect.forEach(
          dirs,
          (dir) =>
            Effect.gen(function* () {
              const target = path.join(root, dir);
              const entries = yield* fs
                .readDirectory(target)
                .pipe(Effect.orElseSucceed(() => undefined));
              // Bun's rm refuses a directory without recursive, even an empty one.
              if (entries?.length === 0) {
                yield* fs.remove(target, { recursive: true });
              }
            }),
          { discard: true },
        );
      }),
      // Config hooks run alongside the hooks directory, so a repository's own
      // hooks, such as husky's, still run. Git runs config hooks first, so
      // pre-commit checks see the files that reveal writes.
      hook: Effect.fn("Checkout.hook")(function* (command) {
        for (const event of events) {
          const name = event === "post-checkout" ? "mute" : `mute-${event}`;
          if (command === undefined) {
            yield* git.exec(
              "config",
              "--local",
              "--remove-section",
              `hook.${name}`,
            );
            continue;
          }
          yield* git.run("config", "--local", `hook.${name}.event`, event);
          yield* git.run(
            "config",
            "--local",
            `hook.${name}.command`,
            `${command} ${event}`,
          );
        }
      }),
      repo: git
        .run("remote", "get-url", "origin")
        .pipe(Effect.map((url) => key(url))),
      reveal: Effect.gen(function* () {
        const files = yield* hidden();
        if (files.length > 0) {
          yield* git.feed(
            files.map((file) => `${file}\0`).join(""),
            "checkout-index",
            "-f",
            "-z",
            "--stdin",
            "--ignore-skip-worktree-bits",
          );
        }
      }),
      servers,
      skills: dirs().pipe(Effect.map((found) => [...found.keys()].sort())),
      status: Effect.fn("Checkout.status")(function* (profile) {
        const root = yield* git.root;
        const want = yield* plan(profile);
        const sparse = yield* current();
        if (Option.isSome(sparse) && !owned(sparse.value)) {
          return { ...want, drift: [], foreign: true };
        }
        const have = Option.getOrElse(sparse, () => []);
        const patterns =
          have.length === want.patterns.length &&
          have.every((line, index) => line === want.patterns[index])
            ? []
            : ["sparse-checkout patterns"];
        const overlays = yield* Effect.forEach(want.overlays, (overlay) =>
          Effect.gen(function* () {
            const target = path.join(root, overlay.file);
            const text = (yield* fs.exists(target))
              ? yield* fs.readFileString(target)
              : undefined;
            return text === overlay.text ? [] : [overlay.file];
          }),
        );
        return {
          ...want,
          drift: [...patterns, ...overlays.flat()],
          foreign: false,
        };
      }),
    });
  }),
);
