#!/usr/bin/env bun

import { $ } from "bun";
import manifest from "../package.json";

const tag = `v${manifest.version}`;
const asset = "mute-darwin-arm64";
const out = `dist/${asset}`;

const fail = (message: string) => {
  console.error(message);
  process.exit(1);
};

// ---- guard ----
if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail("Release from an Apple Silicon Mac, so the binary gets signed");
}
if ((await $`git branch --show-current`.text()).trim() !== "master") {
  fail("Release from master");
}
if ((await $`git status --porcelain`.text()).trim() !== "") {
  fail("Commit or stash your changes first");
}
await $`git fetch --quiet --tags origin`;
if (
  (await $`git rev-parse HEAD`.text()) !==
  (await $`git rev-parse origin/master`.text())
) {
  fail("Push master, or pull its new commits, first");
}
if ((await $`git tag --list ${tag}`.text()).trim() !== "") {
  fail(`${tag} already exists. Bump version in package.json first.`);
}

// ---- verify ----
await $`bun run check`;
await $`bun run typecheck`;
await $`bun test`;

// ---- build ----
await $`rm -rf dist`;
await $`bun build --compile --minify --target=bun-darwin-arm64 src/index.ts --outfile ${out}`;
if ((await $`${out} --version`.text()).trim() !== `mute ${tag}`) {
  fail(`${out} does not report ${tag}`);
}

// ---- publish ----
await $`git tag ${tag}`;
await $`git push origin ${tag}`;
await $`gh release create ${tag} ${out} --verify-tag --generate-notes --title ${tag}`;
