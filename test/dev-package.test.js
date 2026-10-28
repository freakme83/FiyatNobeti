import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { prepareDevExtension } from "../scripts/prepare-dev-extension.js";
import { packageExtensions } from "../scripts/package-extensions.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("production manifest excludes the developer console entry point", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions, ["storage", "offscreen", "alarms", "notifications"]);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.notEqual(manifest.background.service_worker, "background.dev.js");
  assert.doesNotMatch(await readFile(resolve(root, "background.js"), "utf8"), /chrome\.notifications|presentPriceDropNotification|testPriceDropNotification/);
  assert.doesNotMatch(await readFile(resolve(root, "background.js"), "utf8"), /fiyatnobeti:dev:automatic-check-test:/);
  assert.equal((await readFile(resolve(root, "offscreen.html"), "utf8")).includes("offscreen.dev.js"), false);
  assert.equal((await readFile(resolve(root, "background.js"), "utf8")).includes("fiyatNobetiDev"), false);
  assert.equal((await readFile(resolve(root, "offscreen.js"), "utf8")).includes("PARSE_HTML_STRUCTURE_DIAG"), false);
});

test("developer preparation creates an isolated manifest that enables the console entry point", async () => {
  const target = resolve(root, ".fiyatnobeti-dev");
  try {
    assert.equal(await prepareDevExtension(root), target);
    const manifest = JSON.parse(await readFile(resolve(target, "manifest.json"), "utf8"));
    assert.equal(manifest.name, "FiyatNöbeti (Dev PR #8)");
    assert.equal(manifest.background.service_worker, "background.dev.js");
    const developerBackground = await readFile(resolve(target, "background.dev.js"), "utf8");
    assert.match(developerBackground, /scheduleOneAutomaticCheckTest/);
    assert.match(developerBackground, /getLastAutomaticAlarmTest/);
    assert.match(developerBackground, /diagnoseProduct: diagnoseProductForDev/);
    assert.match(developerBackground, /getAutomaticCheckDiagnostics/);
    assert.match(developerBackground, /testPriceDropNotification: notificationTest\.testPriceDropNotification/);
    assert.match(developerBackground, /setDeveloperPriceStructureObserverForDev/);
    assert.match(developerBackground, /getLastPriceStructureDiagnostic/);
    assert.match(developerBackground, /installDeveloperPriceDropNotificationTest/);
    assert.doesNotMatch(developerBackground, /notificationTest\.testPriceDropNotification\(\)/);
    assert.equal(manifest.permissions.includes("notifications"), true);
    assert.equal((await readFile(resolve(target, "scripts/dev-price-drop-notification.js"), "utf8")).includes("SYNTHETIC NOTIFICATION TEST"), true);
    assert.match(await readFile(resolve(target, "offscreen.html"), "utf8"), /offscreen.dev.js/);
    assert.match(await readFile(resolve(target, "offscreen.dev.js"), "utf8"), /installDeveloperPriceParser/);
    assert.match(await readFile(resolve(target, "scripts/dev-price-response.js"), "utf8"), /PARSE_HTML_STRUCTURE_DIAG/);
    assert.match(await readFile(resolve(target, "dev-automatic-alarm.js"), "utf8"), /fiyatnobeti:dev:automatic-check-test:/);

    const productionManifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
    assert.equal(productionManifest.background.service_worker, "background.js");
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("standard and developer ZIPs have loadable roots and only their runtime files", async () => {
  const target = resolve(root, ".fiyatnobeti-dev");
  const output = await mkdtemp(join(tmpdir(), "fiyatnobeti-packages-"));
  try {
    await prepareDevExtension(root);
    const packages = await packageExtensions(output, root);
    assert.equal(packages.standardZip, join(output, "fiyatnobeti-standard.zip"));
    assert.equal(packages.developerZip, join(output, "fiyatnobeti-developer.zip"));

    const standardEntries = spawnSync("unzip", ["-Z1", packages.standardZip], { encoding: "utf8" });
    const developerEntries = spawnSync("unzip", ["-Z1", packages.developerZip], { encoding: "utf8" });
    assert.equal(standardEntries.status, 0, standardEntries.stderr);
    assert.equal(developerEntries.status, 0, developerEntries.stderr);
    const standardFiles = standardEntries.stdout.split(/\r?\n/).filter(Boolean);
    const developerFiles = developerEntries.stdout.split(/\r?\n/).filter(Boolean);
    assert.ok(standardFiles.includes("manifest.json"));
    assert.ok(developerFiles.includes("manifest.json"));
    assert.ok(standardFiles.includes("background.js"));
    assert.ok(!standardFiles.includes("background.dev.js"));
    assert.ok(!standardFiles.includes("offscreen.dev.js"));
    assert.ok(!standardFiles.includes("dev-automatic-alarm.js"));
    assert.ok(!standardFiles.includes("dev-observability.js"));
    assert.ok(developerFiles.includes("background.dev.js"));
    assert.ok(developerFiles.includes("offscreen.dev.js"));
    assert.ok(developerFiles.includes("dev-automatic-alarm.js"));
    assert.ok(developerFiles.includes("dev-observability.js"));
    assert.ok(developerFiles.includes("scripts/dev-price-response.js"));
    assert.ok(!standardFiles.some(path => /(^|\/)(test|\.git|\.github|node_modules)(\/|$)/.test(path)));
    assert.ok(!developerFiles.some(path => /(^|\/)(test|\.git|\.github|node_modules)(\/|$)/.test(path)));

    const standardManifestResult = spawnSync("unzip", ["-p", packages.standardZip, "manifest.json"], { encoding: "utf8" });
    const developerManifestResult = spawnSync("unzip", ["-p", packages.developerZip, "manifest.json"], { encoding: "utf8" });
    assert.equal(standardManifestResult.status, 0);
    assert.equal(developerManifestResult.status, 0);
    assert.equal(JSON.parse(standardManifestResult.stdout).background.service_worker, "background.js");
    assert.equal(JSON.parse(developerManifestResult.stdout).background.service_worker, "background.dev.js");
    assert.deepEqual(JSON.parse(standardManifestResult.stdout).permissions, ["storage", "offscreen", "alarms", "notifications"]);
    assert.deepEqual(JSON.parse(developerManifestResult.stdout).permissions, ["storage", "offscreen", "alarms", "notifications"]);
    assert.equal(JSON.parse(await readFile(resolve(output, "developer/manifest.json"), "utf8")).manifest_version, 3);
    assert.equal(JSON.parse(await readFile(resolve(output, "standard/manifest.json"), "utf8")).manifest_version, 3);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
