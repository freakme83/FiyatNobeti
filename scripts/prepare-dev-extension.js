import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), "..");
const RUNTIME_FILES = [
  "background.js",
  "manifest.json",
  "offscreen.html",
  "offscreen.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "src"
];
const DEV_BACKGROUND_SOURCE = `import {
  prepareAutomaticAlarmTestForDev,
  runAutomaticAlarmTestForDev,
  runOneAutomaticCheckForDev
} from "./background.js";
import { installDeveloperAutomaticAlarmTest } from "./dev-automatic-alarm.js";

const alarmTest = installDeveloperAutomaticAlarmTest({
  chromeApi: chrome,
  prepareTarget: prepareAutomaticAlarmTestForDev,
  runTarget: runAutomaticAlarmTestForDev
});

Object.defineProperty(globalThis, "fiyatNobetiDev", {
  value: Object.freeze({
    runOneAutomaticCheck: runOneAutomaticCheckForDev,
    scheduleOneAutomaticCheckTest: alarmTest.scheduleOneAutomaticCheckTest,
    getLastAutomaticAlarmTest: alarmTest.getLastAutomaticAlarmTest
  }),
  enumerable: true,
  configurable: false,
  writable: false
});
`;

export async function prepareDevExtension(root = defaultRoot) {
  const sourceRoot = resolve(root);
  const target = join(sourceRoot, ".fiyatnobeti-dev");
  if (dirname(target) !== sourceRoot || target !== resolve(sourceRoot, ".fiyatnobeti-dev")) {
    throw new Error("UNSAFE_DEV_TARGET");
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(target);
  for (const path of RUNTIME_FILES) {
    await cp(join(sourceRoot, path), join(target, path), { recursive: true });
  }
  await cp(join(sourceRoot, "scripts/dev-automatic-alarm.js"), join(target, "dev-automatic-alarm.js"));
  await writeFile(join(target, "background.dev.js"), DEV_BACKGROUND_SOURCE);

  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = "FiyatNöbeti (Geliştirici)";
  manifest.background.service_worker = "background.dev.js";
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return target;
}

if (resolve(process.argv[1] || "") === scriptPath) {
  const target = await prepareDevExtension();
  console.log(target);
}
