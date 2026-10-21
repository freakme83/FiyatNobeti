import test from "node:test";
import assert from "node:assert/strict";
import {
  AMAZON_PERMISSION_ORIGIN,
  AMAZON_SHORT_LINK_PERMISSION_ORIGIN,
  createPermissionOnboarding,
} from "../src/permission-onboarding.js";
import { REQUIRED_AMAZON_ORIGINS, getMissingAmazonOrigins } from "../src/popup-permissions.js";

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
  const explanation = new FakeElement();
  const status = new FakeElement();
  const onboarding = createPermissionOnboarding({
    permissions,
    loadingView,
    onboardingView,
    normalView,
    permissionButton,
    explanation,
    status,
    onAuthorized,
  });
  return { onboarding, loadingView, onboardingView, normalView, permissionButton, explanation, status };
}

function permissionMock(initial = []) {
  const granted = new Set(initial);
  const requests = [];
  let requestHandler = async origins => {
    for (const origin of origins) granted.add(origin);
    return true;
  };
  let containsFailure = null;
  return {
    requests,
    granted,
    setRequestHandler(handler) { requestHandler = handler; },
    failContains(error) { containsFailure = error; },
    async contains(details) {
      assert.equal(details.origins.length, 1);
      if (containsFailure) throw containsFailure;
      return granted.has(details.origins[0]);
    },
    async request(details) {
      requests.push(structuredClone(details));
      return requestHandler(details.origins, granted);
    },
  };
}

test("fresh install shows onboarding and requests no permission on popup open", async () => {
  const permissions = permissionMock();
  let normalLoads = 0;
  const ui = setup(permissions, () => { normalLoads += 1; });

  await ui.onboarding.start();

  assert.equal(ui.loadingView.hidden, true);
  assert.equal(ui.onboardingView.hidden, false);
  assert.equal(ui.normalView.hidden, true);
  assert.match(ui.explanation.textContent, /Amazon Türkiye.*kısa paylaşım bağlantılarını/);
  assert.equal(normalLoads, 0);
  assert.deepEqual(permissions.requests, []);
});

test("the explicit onboarding click requests both missing origins together", async () => {
  const permissions = permissionMock();
  const ui = setup(permissions);
  await ui.onboarding.start();

  assert.deepEqual(permissions.requests, []);
  await ui.permissionButton.click();

  assert.deepEqual(permissions.requests, [{ origins: [AMAZON_PERMISSION_ORIGIN, AMAZON_SHORT_LINK_PERMISSION_ORIGIN] }]);
  assert.equal(ui.normalView.hidden, false);
});

test("an existing user with both permissions skips onboarding", async () => {
  const permissions = permissionMock(REQUIRED_AMAZON_ORIGINS);
  const ui = setup(permissions);

  await ui.onboarding.start();

  assert.equal(ui.onboardingView.hidden, true);
  assert.equal(ui.normalView.hidden, false);
  assert.deepEqual(permissions.requests, []);
});

test("an Amazon-only installation is offered completion of the missing short-link permission", async () => {
  const permissions = permissionMock([AMAZON_PERMISSION_ORIGIN]);
  const ui = setup(permissions);

  await ui.onboarding.start();

  assert.equal(ui.onboardingView.hidden, false);
  assert.equal(ui.normalView.hidden, true);
  assert.match(ui.explanation.textContent, /amzn.eu/);
  assert.deepEqual(permissions.requests, []);
  await ui.permissionButton.click();
  assert.deepEqual(permissions.requests, [{ origins: [AMAZON_SHORT_LINK_PERMISSION_ORIGIN] }]);
  assert.equal(ui.normalView.hidden, false);
});

test("only currently missing origins are requested", async () => {
  const permissions = permissionMock([AMAZON_SHORT_LINK_PERMISSION_ORIGIN]);
  const ui = setup(permissions);
  await ui.onboarding.start();
  await ui.permissionButton.click();

  assert.deepEqual(permissions.requests, [{ origins: [AMAZON_PERMISSION_ORIGIN] }]);
  assert.equal(ui.normalView.hidden, false);
});

test("partial approval keeps onboarding open and offers only the still-missing origin", async () => {
  const permissions = permissionMock();
  permissions.setRequestHandler(async (origins, granted) => {
    granted.add(AMAZON_PERMISSION_ORIGIN);
    return false;
  });
  const ui = setup(permissions);
  await ui.onboarding.start();
  await ui.permissionButton.click();

  assert.equal(ui.onboardingView.hidden, false);
  assert.equal(ui.normalView.hidden, true);
  assert.match(ui.explanation.textContent, /kısa paylaşım bağlantılarını kullanabilmek için amzn.eu/i);
  assert.match(ui.status.textContent, /İzin verilmedi/);
  permissions.setRequestHandler(async (origins, granted) => {
    for (const origin of origins) granted.add(origin);
    return true;
  });
  await ui.permissionButton.click();
  assert.deepEqual(permissions.requests, [
    { origins: [AMAZON_PERMISSION_ORIGIN, AMAZON_SHORT_LINK_PERMISSION_ORIGIN] },
    { origins: [AMAZON_SHORT_LINK_PERMISSION_ORIGIN] },
  ]);
  assert.equal(ui.normalView.hidden, false);
});

test("denied permission keeps onboarding available for retry", async () => {
  const permissions = permissionMock();
  permissions.setRequestHandler(async () => false);
  const ui = setup(permissions);
  await ui.onboarding.start();
  await ui.permissionButton.click();

  assert.equal(ui.onboardingView.hidden, false);
  assert.equal(ui.normalView.hidden, true);
  assert.equal(ui.permissionButton.disabled, false);
  assert.match(ui.status.textContent, /yeniden deneyebilirsiniz/);

  permissions.setRequestHandler(async (origins, granted) => {
    for (const origin of origins) granted.add(origin);
    return true;
  });
  await ui.permissionButton.click();
  assert.equal(ui.normalView.hidden, false);
});

test("rejected permission API calls are handled without exposing exception text", async () => {
  const permissions = permissionMock();
  const ui = setup(permissions);
  await ui.onboarding.start();
  permissions.setRequestHandler(async () => { throw new Error("internal browser detail"); });
  await ui.permissionButton.click();

  assert.equal(ui.onboardingView.hidden, false);
  assert.equal(ui.normalView.hidden, true);
  assert.match(ui.status.textContent, /Yeniden deneyebilirsiniz/);
  assert.doesNotMatch(ui.status.textContent, /internal browser detail/);
});

test("a failed permission-state lookup leaves an actionable onboarding state", async () => {
  const permissions = permissionMock();
  permissions.failContains(new Error("internal detail"));
  const ui = setup(permissions);
  await ui.onboarding.start();

  assert.equal(ui.onboardingView.hidden, false);
  assert.match(ui.status.textContent, /İzin durumu kontrol edilemedi/);
  assert.deepEqual(permissions.requests, []);
});

test("reopening after approval shows the normal UI from current permission state", async () => {
  const permissions = permissionMock();
  const first = setup(permissions);
  await first.onboarding.start();
  await first.permissionButton.click();

  const reopened = setup(permissions);
  await reopened.onboarding.start();
  assert.equal(reopened.onboardingView.hidden, true);
  assert.equal(reopened.normalView.hidden, false);
  assert.equal(permissions.requests.length, 1);
});

test("revoking either origin returns to onboarding without changing saved products", async () => {
  for (const revoked of REQUIRED_AMAZON_ORIGINS) {
    const products = { B0FZ9Y4GPF: { asin: "B0FZ9Y4GPF", lastSuccessfulPriceTry: 36399 } };
    const before = structuredClone(products);
    const permissions = permissionMock(REQUIRED_AMAZON_ORIGINS);
    permissions.granted.delete(revoked);
    const ui = setup(permissions);
    await ui.onboarding.start();

    assert.equal(ui.onboardingView.hidden, false, revoked);
    assert.equal(ui.normalView.hidden, true, revoked);
    assert.deepEqual(products, before);
    assert.deepEqual(permissions.requests, []);
  }
});

test("product submission preflight never prompts and accepts either URL type when both permissions exist", async () => {
  const permissions = permissionMock(REQUIRED_AMAZON_ORIGINS);
  assert.deepEqual(await getMissingAmazonOrigins(permissions), []);
  // Both the normal and short-link submission paths use this read-only permission gate.
  assert.deepEqual(await getMissingAmazonOrigins(permissions), []);
  assert.deepEqual(permissions.requests, []);
});

test("granting permissions initializes the normal UI without triggering a price fetch", async () => {
  const permissions = permissionMock();
  let fetches = 0;
  let viewInitializations = 0;
  const ui = setup(permissions, () => { viewInitializations += 1; });
  await ui.onboarding.start();
  await ui.permissionButton.click();

  assert.equal(viewInitializations, 1);
  assert.equal(fetches, 0);
  assert.equal(ui.normalView.hidden, false);
});

test("repeated permission-button clicks do not overlap requests", async () => {
  const permissions = permissionMock();
  let finishRequest;
  permissions.setRequestHandler(origins => new Promise(resolve => {
    finishRequest = result => {
      if (result) for (const origin of origins) permissions.granted.add(origin);
      resolve(result);
    };
  }));
  const ui = setup(permissions);
  await ui.onboarding.start();

  const first = ui.permissionButton.click();
  const second = ui.permissionButton.click();
  assert.equal(permissions.requests.length, 1);
  finishRequest(true);
  await Promise.all([first, second]);
  assert.equal(ui.permissionButton.disabled, false);
});
