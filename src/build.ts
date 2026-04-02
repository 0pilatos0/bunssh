import { join } from "path";
import { cpSync, readFileSync, writeFileSync } from "fs";

const ROOT = join(import.meta.dir, "..");
const FRONTEND = join(import.meta.dir, "frontend");
const DIST = join(ROOT, "dist");

// Bundle frontend TypeScript + CSS (xterm.css gets bundled as main.css)
const result = await Bun.build({
  entrypoints: [join(FRONTEND, "main.ts")],
  outdir: DIST,
  target: "browser",
  minify: true,
  sourcemap: "linked",
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Copy custom style.css to dist
cpSync(join(FRONTEND, "style.css"), join(DIST, "style.css"));

// Copy index.html and inject bundled CSS link
let html = readFileSync(join(FRONTEND, "index.html"), "utf-8");
html = html.replace(
  '<link rel="stylesheet" href="/style.css">',
  '<link rel="stylesheet" href="/main.css">\n  <link rel="stylesheet" href="/style.css">'
);
writeFileSync(join(DIST, "index.html"), html);

console.log("Build complete -> dist/");
for (const output of result.outputs) {
  console.log(`  ${output.path}`);
}
