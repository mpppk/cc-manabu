import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { name, version } from "../src/version.ts";

test("package.json の name と version を公開する", () => {
  expect(name).toBe("cc-manabu");
  expect(version).toBe(pkg.version);
});
