// Test runner. Bundles every test/*.test.ts (aliasing `obsidian` to a Node-safe stub so
// the real src/ code runs unchanged), executes them, then runs the plain .mjs tests.
// Any thrown assertion fails the process. No framework, no config, no registration:
// a new test/*.test.mjs file is picked up simply by existing.
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// The shared license verifier decodes base64 with atob(), which the browser has and
// older Node did not. Node 16+ ships it globally; this keeps the suite honest on any
// runtime by proving the polyfill is never silently required.
if (typeof globalThis.atob !== "function") {
  globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "test");
const buildDir = path.join(testDir, ".build");
fs.mkdirSync(buildDir, { recursive: true });

const tsTests = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith(".test.ts"))
  .sort();

for (const file of tsTests) {
  const outfile = path.join(buildDir, file.replace(/\.ts$/, ".cjs"));
  await esbuild.build({
    entryPoints: [path.join(testDir, file)],
    bundle: true,
    outfile,
    format: "cjs",
    platform: "node",
    target: "node18",
    logLevel: "warning",
    alias: {
      obsidian: path.join(testDir, "obsidian-stub.ts"),
    },
  });
  const module = await import(pathToFileURL(outfile).href);
  // A .test.ts is bundled as CJS, where esbuild REJECTS top-level await — so an async test body
  // has to live in a function. Importing the module would then resolve while its assertions were
  // still pending, and a failure would surface after this line had already printed "ok".
  // A test that needs to await exports its promise as `done`; we wait for it here, so a rejected
  // assertion fails the run at the file that caused it.
  const done = module?.done ?? module?.default?.done;
  if (done && typeof done.then === "function") await done;
  console.log(`ok  ${file}`);
}

const mjsTests = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith(".test.mjs"))
  .sort();

for (const file of mjsTests) {
  await import(pathToFileURL(path.join(testDir, file)).href);
}

console.log("\nAll tests passed.");
