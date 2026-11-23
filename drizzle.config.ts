import { defineConfig } from "drizzle-kit";

// マイグレーション SQL の生成専用（bunx drizzle-kit generate）。実行時は src/db/migrate.ts が適用する。
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
});
