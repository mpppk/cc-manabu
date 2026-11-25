#!/usr/bin/env bun
import { handleCliError } from "./errors/index.ts";

const COMMAND_NAME = "cc-manabu";
const args = process.argv.slice(2);
const pwa = args.length === 1 && args[0] === "--pwa";

if (args.length > 0 && !pwa) {
  const { runCliOrThrow } = await import("./cli.ts");
  await runCliOrThrow(args, COMMAND_NAME).catch(handleCliError);
} else {
  const { serve } = await import("./serve.ts");
  const { loadRuntimeConfig } = await import("./runtime-config.ts");
  await serve(loadRuntimeConfig(process.env, pwa)).catch(handleCliError);
}
