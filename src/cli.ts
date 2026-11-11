import { basename } from "node:path";
import { Console, Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import {
  Service as Checkout,
  events,
  matches,
  type Plan,
  Unmatched,
} from "./checkout";
import { type Profile, Service as Store } from "./profile";

const quote = (part: string) => `'${part.replaceAll("'", `'\\''`)}'`;

// Points the hook at this exact build, because git clients started outside a
// shell may not have mute on PATH. A source checkout runs through bun.
const self = () => {
  const runtime = basename(process.execPath);
  const parts =
    runtime === "bun" || runtime.startsWith("bun-")
      ? [process.execPath, Bun.main]
      : [process.execPath];

  return [...parts.map(quote), "hook"].join(" ");
};

export class NotMuted extends Schema.TaggedError<NotMuted>()("NotMuted", {
  kind: Schema.String,

  name: Schema.String,
}) {
  override get message() {
    return `Not muted: ${this.kind} ${this.name}. Run \`mute status\` to list muted entries.`;
  }
}

const names = (label: string) =>
  Argument.String(label).pipe(Argument.atLeast(1));

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

const summary = (plan: Plan) => {
  const servers = [
    ...new Set(plan.overlays.flatMap((overlay) => overlay.servers)),
  ].sort();
  const lines = [
    ...(plan.skills.length > 0
      ? [`skills: ${plural(plan.skills.length, "skill")} hidden`]
      : []),
    ...(servers.length > 0
      ? [
          `mcp: ${servers.join(", ")} removed from ${plan.overlays.map((overlay) => overlay.file).join(", ")}`,
        ]
      : []),
    ...(plan.instructions
      ? ["instructions: AGENTS.md and CLAUDE.md hidden"]
      : []),
  ];
  return lines.length === 0 ? "Nothing muted" : lines.join("\n");
};

// Applies before saving, so a failed apply leaves the profile unchanged.
const update = <E, R>(
  change: (profile: Profile) => Effect.Effect<Profile, E, R>,
) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const checkout = yield* Checkout;
    const repo = yield* checkout.repo;
    const next = yield* change(yield* store.load(repo));
    const plan = yield* checkout.apply(next);
    yield* store.save(repo, next);
    yield* checkout.hook(plan.patterns.length > 0 ? self() : undefined);
    yield* checkout.conceal;
    yield* Console.log(summary(plan));
  });

const known = (
  kind: string,
  all: readonly string[],
  globs: readonly string[],
) =>
  Effect.forEach(
    globs,
    (glob) =>
      all.some((name) => matches([glob], name))
        ? Effect.void
        : Effect.fail(new Unmatched({ kind, name: glob })),
    { discard: true },
  );

const without = (
  kind: string,
  current: readonly string[],
  removed: readonly string[],
) =>
  Effect.gen(function* () {
    const missing = removed.find((name) => !current.includes(name));
    if (missing !== undefined) {
      return yield* new NotMuted({ kind, name: missing });
    }
    return current.filter((name) => !removed.includes(name));
  });

const skill = Command.make("skill", { names: names("names") }, (input) =>
  update((profile) =>
    Effect.gen(function* () {
      yield* known("skill", yield* (yield* Checkout).skills, input.names);
      return { ...profile, skills: [...profile.skills, ...input.names] };
    }),
  ),
).pipe(
  Command.withDescription(
    "Hide skill directories from this checkout. Globs such as 'fd-*' are allowed.",
  ),
);

const mcp = Command.make("mcp", { names: names("names") }, (input) =>
  update((profile) =>
    Effect.gen(function* () {
      yield* known("MCP server", yield* (yield* Checkout).servers, input.names);
      return { ...profile, mcps: [...profile.mcps, ...input.names] };
    }),
  ),
).pipe(
  Command.withDescription(
    "Remove MCP servers from this checkout's .mcp.json, .cursor/mcp.json and .codex/config.toml",
  ),
);

const instructions = Command.make("instructions", {}, () =>
  update((profile) => Effect.succeed({ ...profile, instructions: true })),
).pipe(Command.withDescription("Hide every AGENTS.md and CLAUDE.md"));

const apply = Command.make("apply", {}, () =>
  update((profile) => Effect.succeed(profile)),
).pipe(
  Command.withDescription(
    "Apply the repository's profile to this checkout, such as in a new worktree",
  ),
);

// A failing hook fails the checkout or commit itself, so this only warns.
const hook = Command.make(
  "hook",
  // Positional order follows key order, so the event comes first.
  {
    event: Argument.Literals("event", events),
    args: Argument.String("args").pipe(Argument.variadic),
  },
  (input) =>
    Effect.gen(function* () {
      const checkout = yield* Checkout;
      if (input.event === "pre-commit") {
        yield* checkout.reveal;
        return;
      }
      if (input.event === "post-checkout") {
        const store = yield* Store;
        const profile = yield* store.load(yield* checkout.repo);
        const state = yield* checkout.status(profile);
        if (!state.foreign && state.drift.length > 0) {
          yield* Console.log(
            `mute: ${summary(yield* checkout.apply(profile))}`,
          );
        }
      }
      // Also clears files left by a commit that failed its checks, since
      // post-commit only runs after a commit succeeds.
      yield* checkout.conceal;
    }).pipe(
      Effect.catch((err) =>
        Console.error(`mute: ${err.message}. Run \`mute status\`.`),
      ),
    ),
).pipe(
  Command.withDescription(
    "Run by the git hooks that mute sets up. Applies the profile after a checkout, and puts hidden files back on disk while a commit's checks run.",
  ),
);

const status = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const checkout = yield* Checkout;
    const repo = yield* checkout.repo;
    const profile = yield* store.load(repo);
    const state = yield* checkout.status(profile);
    const skills = yield* checkout.skills;
    const servers = yield* checkout.servers;
    const count = (all: readonly string[], glob: string) =>
      all.filter((name) => matches([glob], name)).length;
    const list = (all: readonly string[], globs: readonly string[]) =>
      globs.length === 0
        ? "none"
        : globs
            .map((glob) => {
              const found = count(all, glob);
              return found === 0 ? `${glob} (no match)` : `${glob} (${found})`;
            })
            .join(", ");
    const checked = (() => {
      if (state.foreign) {
        return "sparse-checkout patterns not managed by mute";
      }
      if (state.drift.length > 0) {
        return `out of date (${state.drift.join(", ")}). Run \`mute apply\`.`;
      }
      return "applied";
    })();
    yield* Console.log(
      [
        `repo: ${repo}`,
        `profile: ${store.path(repo)}`,
        `skills: ${list(skills, profile.skills)}`,
        `mcp: ${list(servers, profile.mcps)}`,
        `instructions: ${profile.instructions ? "muted" : "none"}`,
        `checkout: ${checked}`,
      ].join("\n"),
    );
  }),
).pipe(
  Command.withDescription(
    "Show the profile and whether this checkout matches it",
  ),
);

const unskill = Command.make("skill", { names: names("names") }, (input) =>
  update((profile) =>
    without("skill", profile.skills, input.names).pipe(
      Effect.map((skills) => ({ ...profile, skills })),
    ),
  ),
).pipe(Command.withDescription("Restore skills muted by these exact entries"));

const unmcp = Command.make("mcp", { names: names("names") }, (input) =>
  update((profile) =>
    without("MCP server", profile.mcps, input.names).pipe(
      Effect.map((mcps) => ({ ...profile, mcps })),
    ),
  ),
).pipe(
  Command.withDescription("Restore MCP servers muted by these exact entries"),
);

const uninstructions = Command.make("instructions", {}, () =>
  update((profile) => Effect.succeed({ ...profile, instructions: false })),
).pipe(Command.withDescription("Restore every AGENTS.md and CLAUDE.md"));

const all = Command.make("all", {}, () =>
  update(() => Effect.succeed({ instructions: false, mcps: [], skills: [] })),
).pipe(
  Command.withDescription(
    "Clear the repository's profile and restore this checkout. Other worktrees keep their state until `mute apply`.",
  ),
);

const restore = Command.make("restore").pipe(
  Command.withAlias("r"),
  Command.withDescription("Restore what mute hid from this checkout"),
  Command.withSubcommands([unskill, unmcp, uninstructions, all]),
);

export const mute = Command.make("mute").pipe(
  Command.withDescription(
    "Hide a repository's skills, MCP servers and agent instructions from a local checkout without changing what you commit",
  ),
  Command.withSubcommands([
    skill,
    mcp,
    instructions,
    apply,
    status,
    restore,
    hook,
  ]),
);
