import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const prod = process.argv[2] === "production";
const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, "dist");
const outputMain = join(outdir, "main.js");
const copyTargets = ["manifest.json", "styles.css"];

const external = [
  "obsidian",
  "electron",
  "@codemirror/state",
  "@codemirror/view",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/search",
  "@codemirror/autocomplete",
  "@codemirror/lint",
  "@codemirror/collab",
  "@lezer/common",
  ...builtins,
];

await mkdir(outdir, { recursive: true });
await esbuild.build({
  entryPoints: [join(here, "src/main.ts")],
  bundle: true,
  outfile: outputMain,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  external,
  logLevel: "info",
});

await Promise.all(copyTargets.map(async (file) => {
  try {
    await copyFile(join(here, file), join(outdir, file));
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}));

if (prod) {
  const { size } = await stat(outputMain);
  console.log(`Production plugin written to ${outdir} (${(size / 1024).toFixed(1)} KiB main.js)`);
}
