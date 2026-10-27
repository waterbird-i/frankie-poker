// Builds a self-contained folder a phone can run with plain Node.
//
// The multiplayer server needs exactly one third-party package (`ws`); every
// other import is a Node built-in. So "deploying" means copying three things
// into one directory:
//
//   .server/mobile/server.mjs   the bundled server
//   .server/mobile/dist/        the built client (index.html + table.html)
//   .server/mobile/node_modules/ws
//
// Run it with `npm run pack:server`, then copy `.server/mobile` to the phone.
// See docs/mobile-hotspot.zh-CN.md for the Termux walkthrough.

import { cp, mkdir, rm, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const out = path.join(root, ".server", "mobile");

const must = async (target) => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

if (!(await must(path.join(root, ".server", "server.mjs")))) {
  console.error("missing .server/server.mjs — run the esbuild step first");
  process.exit(1);
}
if (!(await must(path.join(root, "dist", "table.html")))) {
  console.error("missing dist/table.html — run `npm run build` first");
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "node_modules"), { recursive: true });

await cp(path.join(root, ".server", "server.mjs"), path.join(out, "server.mjs"));
await cp(path.join(root, "dist"), path.join(out, "dist"), { recursive: true });

// `ws` is dependency-free, so copying the package folder is the whole install.
const wsDir = path.join(root, "node_modules", "ws");
if (!(await must(wsDir))) {
  console.error("missing node_modules/ws — run `npm ci` first");
  process.exit(1);
}
await cp(wsDir, path.join(out, "node_modules", "ws"), { recursive: true });

const walk = async (dir) => {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await walk(full);
      bytes += inner.bytes;
      files += inner.files;
    } else {
      bytes += (await stat(full)).size;
      files += 1;
    }
  }
  return { bytes, files };
};

const { bytes, files } = await walk(out);
console.log(`packed ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${path.relative(root, out)}`);
console.log("copy this folder to the phone, then: node server.mjs");
