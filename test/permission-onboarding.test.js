import test from "node:test";
import assert from "node:assert/strict";
import { AMAZON_PERMISSION_ORIGIN, createPermissionOnboarding } from "../src/permission-onboarding.js";
import { AMAZON_SHORT_LINK_PERMISSION_ORIGIN, requestShortLinkPermission } from "../src/popup-permissions.js";

class FakeElement {
  hidden = false;
  disabled = false;
  textContent = "";
  listeners = new Map();

  addEventListener(type, callback) { this.listeners.set(type, callback); }
  click() { return this.listeners.get("click")?.(); }
}

function setup(permissions, onAuthorized = () => {}) {
  const loadingView = new FakeElement();
  const onboardingView = new FakeElement();
  const normalView = new FakeElement();
  const permissionButton = new FakeElement();
  const status = new FakeElement();
  const onboarding = createPermissionOnboarding({
    permissions, loadingView, onboardingView, normalView, permissionButton, status, onAuthorized,
  });
  return { onboarding, loadingView, onboardingView, normalView, permissionButton, status };
}

function permissionMock(initial = false) {
  let granted = initial;
  const requests = [];
  return {
    requests,
    setGranted(value) { granted = value; },
    async contains(details) {
      assert.deepEqual(details, { origins: [AMAZON_PERMISSION_ORIGIN] });
      return granted;
    },
    async request(details) {
      requests.push(details);
      return granted;
    },
  };
}

test("fresh install shows onboarding and keeps normal product controls hidden", async () => {
  const permissions = permissionMock(false);
  let normalLoads = 0;
  const ui = setup(permissions, () => { normalLoads += 1; });

  await ui.onboarding.start();

  assert.equal(ui.loadingView.hidden, true);
  assert.equal(ui.onboardingView.hidden, false);
  assert.equal(ui.normalView.hidden, true);
  assert.equal(normalLoads, 0);
  assert.deepEqual(permissions.requests, []);
});

test("permission is requested only by the button with exactly the Amazon Türkiye origin", async () => {
  const permissions = permissionMock(false);
  const ui = setup(permissions);
  await ui.onboarding.start();
  assert.deepEqual(permissions.requests, []);

  await ui.permissionButton.click();

  assert.deepEqual(permissions.requests, [{ origins: ["https://www.amazon.com.tr/*"] }]);
  assert.equal(ui.onboardingView.hidden, false);
});

test("a confirmed grant transitions immediately to normal UI without a price check", async () => {
  const permissions = permissionMock(false);
  let normalLoads = 0;
  let fetches = 0;
  const ui = setup(permissions, () => { normalLoads += 1; });
  await ui.onboarding.start();
  permissions.request = async details => {
    permissions.requests.push(details);
    permissions.setGranted(true);
    return true;
  };

  await ui.permissionButton.click();

  assert.equal(ui.onboardingView.hidden, true);
  assert.equal(ui.normalView.hidden, false);
  assert.equal(normalLoads, 1);
  assert.equal(fetches, 0);
});

test("a true request result is not enough when contains reports that permission is absent", async () => {
  const permissions = permissionMock(false);
  const ui = setup(permissions);
  await ui.onboarding.start();
  permissions.request = async () => true;

  await ui.permissionButton.click();

  assert.equal(ui.normalView.hidden, true);
  assert.equal(ui.onboardingView.hidden, false);
  assert.match(ui.status.textContent, /İzin verilmedi/);
});

test("denial keeps onboarding available and a later retry can succeed", async () => {
  const permissions = permissionMock(false);
  const ui = setup(permissions);
  await ui.onboarding.start();

  await ui.permissionButton.click();
  assert.equal(ui.onboardingView.hidden, false);
  assert.equal(ui.permissionButton.disabled, false);
  assert.match(ui.status.textContent, /yeniden deneyebilirsiniz/);

  permissions.request = async details => {
    permissions.requests.push(details);
    permissions.setGranted(true);
    return true;
  };
  await ui.permissionButton.click();
  assert.equal(ui.normalView.hidden, false);
  assert.equal(permissions.requests.length, 2);
});

test("permission API rejections leave a recoverable onboarding state", async () => {
  const permissions = permissionMock(false);
  const ui = setup(permissions);
  await ui.onboarding.start();
  permissions.request = async () => { throw new Error("private implementation detail"); };

  await ui.permissionButton.click();

  assert.equal(ui.onboardingView.hidden, false);
  assert.equal(ui.normalView.hidden, true);
  assert.match(ui.status.textContent, /Yeniden deneyebilirsiniz/);
  assert.doesNotMatch(ui.status.textContent, /private implementation detail/);
});

test("already-authorized and reopened users go directly to normal UI", async () => {
  const permissions = permissionMock(true);
  let normalLoads = 0;
  const first = setup(permissions, () => { normalLoads += 1; });
  await first.onboarding.start();
  const reopened = setup(permissions, () => { normalLoads += 1; });
  await reopened.onboarding.start();

  assert.equal(first.normalView.hidden, false);
  assert.equal(reopened.normalView.hidden, false);
  assert.equal(first.onboardingView.hidden, true);
  assert.equal(reopened.onboardingView.hidden, true);
  assert.equal(permissions.requests.length, 0);
  assert.equal(normalLoads, 2);
});

test("revoked permission shows onboarding again without touching saved products", async () => {
  const products = { B0FZ9Y4GPF: { asin: "B0FZ9Y4GPF", lastSuccessfulPriceTry: 36399 } };
  const before = structuredClone(products);
  const permissions = permissionMock(false);
  let normalLoads = 0;
  const ui = setup(permissions, () => { normalLoads += 1; });

  await ui.onboarding.start();

  assert.equal(ui.onboardingView.hidden, false);
  assert.equal(normalLoads, 0);
  assert.deepEqual(products, before);
});

test("rapid repeated clicks create only one in-flight permission request", async () => {
  const permissions = permissionMock(false);
  let resolveRequest;
  permissions.request = details => {
    permissions.requests.push(details);
    return new Promise(resolve => { resolveRequest = resolve; });
  };
  const ui = setup(permissions);
  await ui.onboarding.start();

  const first = ui.permissionButton.click();
  const second = ui.permissionButton.click();
  assert.equal(permissions.requests.length, 1);
  resolveRequest(false);
  await Promise.all([first, second]);
  assert.equal(ui.permissionButton.disabled, false);
});

test("short-link permission remains separate and is requested only through its helper", async () => {
  const calls = [];
  const permissions = {
    async request(details) { calls.push(["request", details]); return true; },
    async contains(details) { calls.push(["contains", details]); return true; },
  };
  assert.equal(await requestShortLinkPermission(permissions), true);
  assert.deepEqual(calls, [
    ["request", { origins: [AMAZON_SHORT_LINK_PERMISSION_ORIGIN] }],
    ["contains", { origins: [AMAZON_SHORT_LINK_PERMISSION_ORIGIN] }],
  ]);
  assert.equal(AMAZON_SHORT_LINK_PERMISSION_ORIGIN, "https://amzn.eu/*");
});
