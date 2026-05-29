import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const prod = process.argv[2] === "production";
const here = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(here, "src/main.ts")],
  bundle: true,
  outfile: join(here, "main.js"),
  platform: "browser",
  format: "cjs",
  target: "es2022",
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  external: [
    "obsidian",
    "electron",
    ...builtins,
  ],
  logLevel: "info",
});
