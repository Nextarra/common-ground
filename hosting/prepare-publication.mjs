// Creates a new local owner-review directory only. Never pushes, deploys or uploads.
import { readFile, mkdir, writeFile, lstat, realpath } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
const forbidden = (path) =>
  path
    .split("/")
    .some(
      (part) =>
        [
          "..",
          "evidence",
          "SESSION.json",
          "MANIFEST.json",
          ".git",
          ".aws",
          ".codex",
          ".agents",
          "node_modules",
          "test-results",
          "playwright-report",
        ].includes(part) ||
        part.startsWith(".env") ||
        part.endsWith(".zip"),
    );
function safePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    forbidden(value)
  )
    throw new Error("Publication path is not allowed.");
  return value;
}
export async function preparePublication({
  projectRoot = defaultRoot,
  output,
}) {
  const root = await realpath(projectRoot);
  const destination = resolve(output);
  if (destination === root || !relative(root, destination).startsWith(".."))
    throw new Error(
      "Output must be a new sibling or temporary review directory.",
    );
  const allowlist = JSON.parse(
    await readFile(resolve(root, "hosting/PUBLICATION_ALLOWLIST.json"), "utf8"),
  );
  const destinations = new Set(),
    ready = [];
  for (const entry of allowlist.files) {
    const source = safePath(entry.source),
      target = safePath(entry.destination);
    if (destinations.has(target))
      throw new Error("Duplicate publication destination.");
    destinations.add(target);
    const path = resolve(root, source);
    const canonical = await realpath(path);
    const info = await lstat(path);
    if (canonical !== path || !info.isFile() || info.isSymbolicLink())
      throw new Error(
        "Publication source must be a regular file without symlink components.",
      );
    const bytes = await readFile(path);
    if (
      source === "hosting/runtime.env.example" &&
      /^\s*QLOO_API_KEY\s*=/m.test(bytes.toString())
    )
      throw new Error(
        "API-key assignments must never be included in publication inputs.",
      );
    ready.push({
      source,
      target,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  // No recursive delete/overwrite; a pre-existing destination fails closed.
  await mkdir(destination);
  for (const entry of ready) {
    const path = resolve(destination, entry.target);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.bytes, { flag: "wx", mode: 0o644 });
  }
  const manifest = {
    status: "LOCAL_REVIEW_ONLY_NOT_PUBLISHED",
    files: ready.map(({ source, target, bytes, sha256 }) => ({
      source,
      path: target,
      bytes: bytes.length,
      sha256,
    })),
  };
  await writeFile(
    resolve(destination, "PUBLICATION_MANIFEST.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  return { destination, files: ready.length, status: manifest.status };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output")
    throw new Error(
      "Usage: node hosting/prepare-publication.mjs --output <new-local-directory>",
    );
  console.log(JSON.stringify(await preparePublication({ output: args[1] })));
}
