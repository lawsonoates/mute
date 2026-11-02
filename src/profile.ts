import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

const Names = Schema.Array(Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);

export const Profile = Schema.Struct({
  instructions: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  mcps: Names,
  skills: Names,
});
export type Profile = typeof Profile.Type;

export const empty: Profile = { instructions: false, mcps: [], skills: [] };

const File = Schema.fromJsonString(Profile, { space: 2 });

export class ProfileError extends Schema.TaggedError<ProfileError>()(
  "ProfileError",
  { path: Schema.String, detail: Schema.String },
) {
  override get message() {
    return `Invalid profile ${this.path}: ${this.detail}`;
  }
}

export type Error = ProfileError | PlatformError;

/**
 * Turns a remote URL into a stable relative path, so that every clone and
 * worktree of a repository shares one profile.
 */
export const key = (url: string) => {
  const trimmed = url
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  const scp = /^[^/@]+@([^:/]+):(.+)$/u.exec(trimmed);
  const parts = (() => {
    if (scp) {
      return [scp[1], scp[2]];
    }
    if (URL.canParse(trimmed)) {
      const parsed = new URL(trimmed);
      return parsed.protocol === "file:"
        ? ["local", decodeURIComponent(parsed.pathname)]
        : [parsed.hostname, decodeURIComponent(parsed.pathname)];
    }
    return ["local", trimmed];
  })();
  return parts
    .flatMap((part = "") => part.split(/[/\\]+/u))
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .join("/");
};

export interface Interface {
  readonly path: (repo: string) => string;
  readonly load: (repo: string) => Effect.Effect<Profile, Error>;
  readonly save: (repo: string, profile: Profile) => Effect.Effect<void, Error>;
}

export class Service extends Context.Service<Service, Interface>()(
  "mute/Profile",
) {}

export const layer = (root: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = path.resolve(root);
      const file = (repo: string) => path.join(home, `${repo}.json`);

      return Service.of({
        load: Effect.fn("Profile.load")(function* (repo) {
          const target = file(repo);
          if (!(yield* fs.exists(target))) {
            return empty;
          }
          return yield* Schema.decodeUnknownEffect(File)(
            yield* fs.readFileString(target),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProfileError({ detail: cause.message, path: target }),
            ),
          );
        }),
        path: file,
        save: Effect.fn("Profile.save")(function* (repo, profile) {
          const target = file(repo);
          const text = yield* Schema.encodeEffect(File)({
            instructions: profile.instructions,
            mcps: [...new Set(profile.mcps)].sort(),
            skills: [...new Set(profile.skills)].sort(),
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProfileError({ detail: cause.message, path: target }),
            ),
          );
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.writeFileString(target, `${text}\n`);
        }),
      });
    }),
  );
