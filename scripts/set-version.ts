#!/usr/bin/env bun
/**
 * package.json の version を書き換える（release.yml から使う）。
 *
 *   bun scripts/set-version.ts 0.1.0
 */
import path from "node:path";

const version = process.argv[2];
if (
  version === undefined ||
  !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)
) {
  console.error("usage: bun scripts/set-version.ts <semver>（例: 0.1.0）");
  process.exit(1);
}

const file = path.join(import.meta.dir, "..", "package.json");
const pkg = await Bun.file(file).json();
pkg.version = version;
await Bun.write(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`version: ${version}`);
