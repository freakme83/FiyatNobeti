import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDevExtension } from "../scripts/prepare-dev-extension.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("production manifest excludes the developer console entry point", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  assert.equal(manifest.background.service_worker, "background.js");
  assert.notEqual(manifest.background.service_worker, "background.dev.js");
  assert.doesNotMatch(await readFile(resolve(root, "background.js"), "utf8"), /fiyatnobeti:dev:automatic-check-test:/);
});

test("developer preparation creates an isolated manifest that enables the console entry point", async () => {
  const target = resolve(root, ".fiyatnobeti-dev");
  try {
    assert.equal(await prepareDevExtension(root), target);
    const manifest = JSON.parse(await readFile(resolve(target, "manifest.json"), "utf8"));
    assert.equal(manifest.name, "FiyatNöbeti (Geliştirici)");
    assert.equal(manifest.background.service_worker, "background.dev.js");
    const developerBackground = await readFile(resolve(target, "background.dev.js"), "utf8");
    assert.match(developerBackground, /scheduleOneAutomaticCheckTest/);
    assert.match(developerBackground, /getLastAutomaticAlarmTest/);
    assert.match(await readFile(resolve(target, "dev-automatic-alarm.js"), "utf8"), /fiyatnobeti:dev:automatic-check-test:/);

    const productionManifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
    assert.equal(productionManifest.background.service_worker, "background.js");
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
