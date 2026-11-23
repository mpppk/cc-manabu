#!/usr/bin/env bun
import { handleCliError } from "./errors/index.ts";

const COMMAND_NAME = "cc-manabu";
const args = process.argv.slice(2);

// 引数なしの起動はサーバを立ち上げる（#25 で実装）。それまではヘルプを表示する。
const argv = args.length > 0 ? args : ["--help"];
const { runCliOrThrow } = await import("./cli.ts");
await runCliOrThrow(argv, COMMAND_NAME).catch(handleCliError);
