#!/usr/bin/env bun
import { homedir } from "node:os";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Cause,
  Config,
  Console,
  Effect,
  Exit,
  Layer,
  Option,
  Path,
} from "effect";
import { CliError, Command } from "effect/cli";
import manifest from "../package.json";
import * as Checkout from "./checkout";
import { mute } from "./cli";
import * as Git from "./git";
import * as Profile from "./profile";

const services = Layer.unwrap(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = yield* Config.String("MUTE_HOME").pipe(
      Config.withDefault(path.join(homedir(), ".config", "mute")),
    );
    return Layer.mergeAll(
      Profile.layer(home),
      Checkout.layer.pipe(Layer.provide(Git.layer)),
    );
  }),
);

Effect.gen(function* () {
  const terminal = yield* Console.Console;
  const output: (readonly unknown[])[] = [];
  // Effect renders usage before a parse failure. Commit output to the right stream on exit.
  yield* Command.run(mute, { version: manifest.version }).pipe(
    Effect.catchTag("ShowHelp", (err) =>
      err.errors.length === 0 ? Effect.void : Effect.fail(err),
    ),
    Effect.provideService(Console.Console, {
      ...terminal,
      log: (...args) => output.push(args),
    }),
    Effect.onExit((exit) =>
      Effect.forEach(
        output,
        (args) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              terminal.log(...args);
            } else {
              terminal.error(...args);
            }
          }),
        { discard: true },
      ),
    ),
  );
}).pipe(
  Effect.provide(services),
  Effect.provide(BunServices.layer),
  Effect.catchCause((cause) => {
    process.exitCode = Cause.hasInterruptsOnly(cause) ? 130 : 1;
    const err = Cause.findErrorOption(cause);
    if (
      Option.isSome(err) &&
      CliError.isCliError(err.value) &&
      (err.value._tag === "ShowHelp" || err.value._tag === "UserError")
    ) {
      return Effect.void;
    }
    return Console.error(
      Option.isSome(err)
        ? `mute: ${err.value instanceof Error ? err.value.message : String(err.value)}`
        : Cause.pretty(cause),
    );
  }),
  BunRuntime.runMain,
);
