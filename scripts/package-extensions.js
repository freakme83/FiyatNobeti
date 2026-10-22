import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(scriptPath), "..");
const RUNTIME_FILES = [
  "background.js",
  "manifest.json",
  "offscreen.html",
  "offscreen.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "icons",
  "src"
];
const DEVELOPER_FILES = [
  "background.dev.js",
  "dev-automatic-alarm.js",
  "dev-observability.js",
  "offscreen.dev.js",
  "scripts/dev-price-response.js",
  "scripts/dev-price-drop-notification.js"
];

async function listFiles(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path, root));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
    else throw new Error(`UNSUPPORTED_PACKAGE_ENTRY:${relative(root, path)}`);
  }
  return files.sort();
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

async function validatePackage(directory, kind) {
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert(manifest.manifest_version === 3, `${kind}_NOT_MV3`);
  assert(typeof manifest.background?.service_worker === "string", `${kind}_MISSING_SERVICE_WORKER`);
  assert(typeof manifest.action?.default_popup === "string", `${kind}_MISSING_POPUP`);
  const files = new Set(await listFiles(directory));
  assert(files.has(manifest.background.service_worker), `${kind}_SERVICE_WORKER_MISSING`);
  assert(files.has(manifest.action.default_popup), `${kind}_POPUP_MISSING`);
  assert(files.has("offscreen.html") && files.has("offscreen.js"), `${kind}_OFFSCREEN_MISSING`);
  assert(files.has("popup.css") && files.has("popup.js"), `${kind}_POPUP_RUNTIME_MISSING`);
  assert(files.has("src/url.js"), `${kind}_MODULES_MISSING`);

  const expected = new Set();
  for (const path of RUNTIME_FILES) {
    if (path === "src" || path === "icons") {
      for (const file of await listFiles(join(sourceRoot, path), join(sourceRoot, path))) expected.add(`${path}/${file}`);
    } else expected.add(path);
  }
  if (kind === "developer") {
    for (const path of DEVELOPER_FILES) expected.add(path);
  }
  assert(files.size === expected.size && [...files].every(path => expected.has(path)), `${kind}_UNEXPECTED_PACKAGE_FILES`);

  if (kind === "standard") {
    assert(manifest.background.service_worker === "background.js", "STANDARD_WRONG_SERVICE_WORKER");
    assert(!files.has("background.dev.js") && !files.has("offscreen.dev.js"), "STANDARD_HAS_DEV_ENTRY_POINT");
    assert(!files.has("dev-automatic-alarm.js") && !files.has("dev-observability.js"), "STANDARD_HAS_DEV_MODULE");
    assert(!files.has("scripts/dev-price-drop-notification.js"), "STANDARD_HAS_DEV_NOTIFICATION_TEST");
    assert(![...files].some(path => path.startsWith("scripts/")), "STANDARD_HAS_DEV_SCRIPT");
    const original = JSON.parse(await readFile(join(sourceRoot, "manifest.json"), "utf8"));
    assert(JSON.stringify(manifest) === JSON.stringify(original), "STANDARD_MANIFEST_CHANGED");
  } else {
    assert(manifest.background.service_worker === "background.dev.js", "DEVELOPER_WRONG_SERVICE_WORKER");
    assert(files.has("background.dev.js") && files.has("offscreen.dev.js"), "DEVELOPER_ENTRY_POINT_MISSING");
    assert(files.has("dev-automatic-alarm.js") && files.has("dev-observability.js"), "DEVELOPER_DIAGNOSTICS_MISSING");
    assert(files.has("scripts/dev-price-response.js"), "DEVELOPER_PRICE_DIAGNOSTICS_MISSING");
    assert(files.has("scripts/dev-price-drop-notification.js"), "DEVELOPER_NOTIFICATION_TEST_MISSING");
    const html = await readFile(join(directory, "offscreen.html"), "utf8");
    assert(html.includes('src="offscreen.dev.js"'), "DEVELOPER_WRONG_OFFSCREEN_ENTRY_POINT");
  }
}

function createZip(directory, archivePath) {
  const result = spawnSync("zip", ["-q", "-r", archivePath, "."], { cwd: directory, encoding: "utf8" });
  if (result.error) throw result.error;
  assert(result.status === 0, `ZIP_FAILED:${result.stderr || result.status}`);
  const listing = spawnSync("unzip", ["-Z1", archivePath], { encoding: "utf8" });
  if (listing.error) throw listing.error;
  assert(listing.status === 0, `ZIP_LIST_FAILED:${listing.stderr || listing.status}`);
  const names = listing.stdout.split(/\r?\n/).filter(Boolean).map(name => name.replace(/^\.\//, ""));
  assert(names.includes("manifest.json"), "ZIP_ROOT_MANIFEST_MISSING");
  return names;
}

export async function packageExtensions(outputRoot, root = sourceRoot) {
  const resolvedRoot = resolve(root);
  const targetRoot = resolve(outputRoot);
  const developerSource = join(resolvedRoot, ".fiyatnobeti-dev");
  const standardDirectory = join(targetRoot, "standard");
  const developerDirectory = join(targetRoot, "developer");
  const standardZip = join(targetRoot, "fiyatnobeti-standard.zip");
  const developerZip = join(targetRoot, "fiyatnobeti-developer.zip");

  assert(targetRoot !== resolvedRoot && !resolvedRoot.startsWith(`${targetRoot}/`), "UNSAFE_PACKAGE_OUTPUT");
  await readFile(join(developerSource, "manifest.json"), "utf8");
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(standardDirectory, { recursive: true });
  await mkdir(developerDirectory, { recursive: true });

  for (const path of RUNTIME_FILES) {
    await cp(join(resolvedRoot, path), join(standardDirectory, path), { recursive: true });
    await cp(join(developerSource, path), join(developerDirectory, path), { recursive: true });
  }
  for (const path of DEVELOPER_FILES) {
    await cp(join(developerSource, path), join(developerDirectory, path), { recursive: true });
  }

  await validatePackage(standardDirectory, "standard");
  await validatePackage(developerDirectory, "developer");
  const standardEntries = createZip(standardDirectory, standardZip);
  const developerEntries = createZip(developerDirectory, developerZip);
  assert(standardEntries.filter(name => !name.endsWith("/")).length === (await listFiles(standardDirectory)).length, "STANDARD_ZIP_UNEXPECTED_ENTRIES");
  assert(developerEntries.filter(name => !name.endsWith("/")).length === (await listFiles(developerDirectory)).length, "DEVELOPER_ZIP_UNEXPECTED_ENTRIES");
  return { standardZip, developerZip };
}

if (resolve(process.argv[1] || "") === scriptPath) {
  const outputRoot = resolve(process.argv[2] || join(sourceRoot, "artifacts", "extension-packages"));
  const packages = await packageExtensions(outputRoot);
  console.log(packages.standardZip);
  console.log(packages.developerZip);
}
