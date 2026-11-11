import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  args: Schema.Array(Schema.String),
  detail: Schema.String,
}) {
  override get message() {
    return `git ${this.args.join(" ")}: ${this.detail}`;
  }
}

export interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Interface {
  /** Top level of the current worktree. */
  readonly root: Effect.Effect<string, GitError>;
  /** Run git at the worktree root and return stdout, failing on a non-zero exit. */
  readonly run: (...args: string[]) => Effect.Effect<string, GitError>;
  /** Run git at the worktree root and return the exit code with the output. */
  readonly exec: (...args: string[]) => Effect.Effect<Result, GitError>;
  /** Like `run`, with `input` written to stdin. */
  readonly feed: (
    input: string,
    ...args: string[]
  ) => Effect.Effect<string, GitError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "mute/Git",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const spawn = Effect.fn("Git.spawn")(function* (
      args: string[],
      cwd?: string,
      input?: string,
    ) {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", args, {
          cwd,
          stdin:
            input === undefined
              ? "ignore"
              : Stream.encodeText(Stream.make(input)),
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { code: Number(code), stdout, stderr };
    }, Effect.scoped);

    const check = (args: string[]) => (result: Result) =>
      result.code === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(
            new GitError({
              args,
              detail: result.stderr.trim() || `exit code ${result.code}`,
            }),
          );

    const translate = (args: string[]) =>
      Effect.mapError(
        (cause: { readonly message: string }) =>
          new GitError({ args, detail: cause.message }),
      );

    const root = yield* Effect.cached(
      Effect.suspend(() => {
        const args = ["rev-parse", "--show-toplevel"];
        return spawn(args).pipe(
          translate(args),
          Effect.flatMap(check(args)),
          Effect.map((out) => out.trim()),
        );
      }),
    );

    const exec = (...args: string[]) =>
      Effect.flatMap(root, (cwd) => spawn(args, cwd).pipe(translate(args)));

    return Service.of({
      exec,
      feed: (input, ...args) =>
        Effect.flatMap(root, (cwd) =>
          spawn(args, cwd, input).pipe(
            translate(args),
            Effect.flatMap(check(args)),
          ),
        ),
      root,
      run: (...args) => exec(...args).pipe(Effect.flatMap(check(args))),
    });
  }),
);
