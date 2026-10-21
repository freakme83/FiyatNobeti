import test from "node:test";
import assert from "node:assert/strict";
import {
  DEV_AUTO_TEST_ALARM_PREFIX,
  DEV_AUTO_TEST_STORAGE_KEY,
  installDeveloperAutomaticAlarmTest
} from "../scripts/dev-automatic-alarm.js";

const START = Date.parse("2026-10-21T12:00:00.000Z");

function createHarness({ storage = {}, alarms = new Map(), start = START, runTarget } = {}) {
  let currentTime = start;
  let listener;
  let prepareCalls = 0;
  let runCalls = 0;
  const chromeApi = {
    storage: { local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(value) { Object.assign(storage, structuredClone(value)); }
    } },
    alarms: {
      onAlarm: { addListener(fn) { listener = fn; } },
      async get(name) { return alarms.get(name); },
      async create(name, info) { alarms.set(name, { name, scheduledTime: info.when }); },
      async clear(name) { return alarms.delete(name); }
    }
  };
  const install = () => installDeveloperAutomaticAlarmTest({
    chromeApi,
    now: () => currentTime,
    createTestId: () => "test-0001",
    prepareTarget: async () => {
      prepareCalls++;
      return { status: "ready", asin: "B0D47HCRZ6", productAddedAt: "2026-10-20T00:00:00.000Z" };
    },
    runTarget: async target => {
      runCalls++;
      return runTarget ? runTarget(target) : { status: "success", requestStarted: true };
    }
  });
  const testAlarm = () => [...alarms.values()].find(alarm => alarm.name.startsWith(DEV_AUTO_TEST_ALARM_PREFIX));
  const fire = async (alarm = testAlarm()) => {
    if (alarm?.name?.startsWith(DEV_AUTO_TEST_ALARM_PREFIX)) alarms.delete(alarm.name);
    return listener?.(alarm);
  };
  return {
    storage,
    alarms,
    install,
    fire,
    get prepareCalls() { return prepareCalls; },
    get runCalls() { return runCalls; },
    get testAlarm() { return testAlarm(); },
    setTime(value) { currentTime = value; },
    advance(ms) { currentTime += ms; },
    get now() { return currentTime; }
  };
}

test("scheduling creates one namespaced alarm without starting a fetch", async () => {
  const harness = createHarness();
  const api = harness.install();
  const result = await api.scheduleOneAutomaticCheckTest(2);

  assert.deepEqual(result, {
    testId: "test-0001",
    asin: "B0D47HCRZ6",
    requestedAt: "2026-10-21T12:00:00.000Z",
    scheduledAt: "2026-10-21T12:02:00.000Z",
    alarmName: `${DEV_AUTO_TEST_ALARM_PREFIX}test-0001`,
    status: "scheduled",
    deliveredAt: null,
    completedAt: null,
    requestStarted: false
  });
  assert.equal(harness.alarms.size, 1);
  assert.equal(harness.testAlarm.scheduledTime, START + 120_000);
  assert.equal(harness.runCalls, 0);
  assert.equal(harness.storage[DEV_AUTO_TEST_STORAGE_KEY].status, "scheduled");
});

test("pending test survives worker restart and the natural alarm completes one check", async () => {
  const harness = createHarness();
  const firstApi = harness.install();
  await firstApi.scheduleOneAutomaticCheckTest(2);

  const restartedApi = harness.install();
  assert.equal((await restartedApi.getLastAutomaticAlarmTest()).status, "scheduled");
  harness.advance(120_000);
  await harness.fire();

  const result = await restartedApi.getLastAutomaticAlarmTest();
  assert.equal(result.status, "success");
  assert.equal(result.deliveredAt, "2026-10-21T12:02:00.000Z");
  assert.equal(result.completedAt, "2026-10-21T12:02:00.000Z");
  assert.equal(result.requestStarted, true);
  assert.equal(harness.runCalls, 1);
  assert.equal(harness.testAlarm, undefined);
});

test("worker restart recreates a missing pending test alarm without fetching", async () => {
  const harness = createHarness();
  const firstApi = harness.install();
  await firstApi.scheduleOneAutomaticCheckTest(2);
  harness.alarms.clear();

  const restartedApi = harness.install();
  assert.equal((await restartedApi.getLastAutomaticAlarmTest()).status, "scheduled");
  assert.equal(harness.testAlarm.scheduledTime, START + 120_000);
  assert.equal(harness.runCalls, 0);
});

test("unrelated, stale and duplicate deliveries cannot start requests", async () => {
  const harness = createHarness();
  const api = harness.install();
  await api.scheduleOneAutomaticCheckTest(2);
  await harness.fire({ name: "unrelated", scheduledTime: START + 120_000 });
  await harness.fire({ name: `${DEV_AUTO_TEST_ALARM_PREFIX}test-0001`, scheduledTime: START + 60_000 });
  assert.equal(harness.runCalls, 0);

  harness.advance(120_000);
  const valid = { name: `${DEV_AUTO_TEST_ALARM_PREFIX}test-0001`, scheduledTime: START + 120_000 };
  await harness.fire(valid);
  await harness.fire(valid);
  assert.equal(harness.runCalls, 1);
  assert.equal((await api.getLastAutomaticAlarmTest()).status, "success");
});

test("duplicate delivery while the first check is running is harmless", async () => {
  let finish;
  let signalStarted;
  const gate = new Promise(resolve => { finish = resolve; });
  const started = new Promise(resolve => { signalStarted = resolve; });
  const harness = createHarness({ runTarget: async () => { signalStarted(); return gate; } });
  const api = harness.install();
  await api.scheduleOneAutomaticCheckTest(1);
  harness.advance(60_000);
  const delivered = { name: harness.testAlarm.name, scheduledTime: START + 60_000 };
  const first = harness.fire(delivered);
  await started;
  assert.equal((await api.getLastAutomaticAlarmTest()).status, "running");
  await harness.fire(delivered);
  assert.equal(harness.runCalls, 1);
  finish({ status: "success", requestStarted: true });
  await first;
  assert.equal((await api.getLastAutomaticAlarmTest()).status, "success");
});

test("only one pending test is allowed and delay is constrained to one through five minutes", async () => {
  const harness = createHarness();
  const api = harness.install();
  assert.equal((await api.scheduleOneAutomaticCheckTest(0)).errorCode, "INVALID_TEST_DELAY");
  assert.equal((await api.scheduleOneAutomaticCheckTest(6)).errorCode, "INVALID_TEST_DELAY");
  assert.equal((await api.scheduleOneAutomaticCheckTest(1.5)).errorCode, "INVALID_TEST_DELAY");
  assert.equal((await api.scheduleOneAutomaticCheckTest(2)).status, "scheduled");
  const duplicate = await api.scheduleOneAutomaticCheckTest(3);
  assert.equal(duplicate.status, "scheduled");
  assert.equal(duplicate.errorCode, "TEST_ALREADY_PENDING");
  assert.equal(harness.prepareCalls, 1);
  assert.equal(harness.alarms.size, 1);
});

test("delivery records skipped and failed outcomes without claiming a request started", async () => {
  for (const result of [
    { status: "skipped", errorCode: "AUTOMATIC_DISABLED", requestStarted: false },
    { status: "failure", errorCode: "PERMISSION_REQUIRED", requestStarted: false }
  ]) {
    const harness = createHarness({ runTarget: async () => result });
    const api = harness.install();
    await api.scheduleOneAutomaticCheckTest(1);
    harness.advance(60_000);
    await harness.fire();
    const diagnostic = await api.getLastAutomaticAlarmTest();
    assert.equal(diagnostic.status, result.status);
    assert.equal(diagnostic.errorCode, result.errorCode);
    assert.equal(diagnostic.requestStarted, false);
    assert.ok(diagnostic.deliveredAt);
    assert.ok(diagnostic.completedAt);
  }
});

test("a worker restart converts a claimed unfinished test to interrupted without replay", async () => {
  const storage = {
    [DEV_AUTO_TEST_STORAGE_KEY]: {
      version: 1,
      testId: "test-0001",
      asin: "B0D47HCRZ6",
      productAddedAt: "2026-10-20T00:00:00.000Z",
      requestedAt: "2026-10-21T11:58:00.000Z",
      scheduledAt: "2026-10-21T12:00:00.000Z",
      alarmName: `${DEV_AUTO_TEST_ALARM_PREFIX}test-0001`,
      status: "running",
      deliveredAt: "2026-10-21T12:00:00.000Z",
      completedAt: null,
      requestStarted: true,
      errorCode: null
    }
  };
  const harness = createHarness({ storage });
  const api = harness.install();
  const result = await api.getLastAutomaticAlarmTest();
  assert.equal(result.status, "interrupted");
  assert.equal(result.errorCode, "TEST_CHECK_INTERRUPTED");
  assert.equal(result.requestStarted, true);
  assert.equal(harness.runCalls, 0);
});
