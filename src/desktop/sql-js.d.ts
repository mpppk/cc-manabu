// sql.js の配布物のうち、デスクトップアプリ版が直接読み込むもの
declare module "sql.js/dist/sql-wasm-inline.js" {
  import type { InitSqlJsStatic } from "sql.js";

  const initSqlJs: InitSqlJsStatic;
  export default initSqlJs;
}

declare module "sql.js/dist/sql-asm.js" {
  import type { InitSqlJsStatic } from "sql.js";

  const initSqlJs: InitSqlJsStatic;
  export default initSqlJs;
}
