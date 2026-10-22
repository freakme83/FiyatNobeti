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
  runOneAutomaticCheckForDev,
  diagnoseProductForDev,
  setDeveloperEventRecorderForDev
} from "./background.js";
import { installDeveloperAutomaticAlarmTest } from "./dev-automatic-alarm.js";
import { installDeveloperObservability } from "./dev-observability.js";

const observability = installDeveloperObservability({ chromeApi: chrome });
setDeveloperEventRecorderForDev(observability.record);
observability.record({ type: "service_worker_started" });

const alarmTest = installDeveloperAutomaticAlarmTest({
  chromeApi: chrome,
  prepareTarget: prepareAutomaticAlarmTestForDev,
  runTarget: runAutomaticAlarmTestForDev
});

Object.defineProperty(globalThis, "fiyatNobetiDev", {
  value: Object.freeze({
    runOneAutomaticCheck: runOneAutomaticCheckForDev,
    scheduleOneAutomaticCheckTest: alarmTest.scheduleOneAutomaticCheckTest,
    getLastAutomaticAlarmTest: alarmTest.getLastAutomaticAlarmTest,
    getAutomaticCheckDiagnostics: observability.getAutomaticCheckDiagnostics,
    diagnoseProduct: diagnoseProductForDev
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
  await cp(join(sourceRoot, "scripts/dev-observability.js"), join(target, "dev-observability.js"));
  await mkdir(join(target, "scripts"));
  await cp(join(sourceRoot, "scripts/dev-price-response.js"), join(target, "scripts/dev-price-response.js"));
  await writeFile(join(target, "background.dev.js"), DEV_BACKGROUND_SOURCE);
  await writeFile(join(target, "offscreen.dev.js"), 'import "./offscreen.js";\nimport { installDeveloperPriceParser } from "./scripts/dev-price-response.js";\ninstallDeveloperPriceParser();\n');
  const offscreenPath = join(target, "offscreen.html");
  await writeFile(offscreenPath, (await readFile(offscreenPath, "utf8")).replace('src="offscreen.js"', 'src="offscreen.dev.js"'));

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
