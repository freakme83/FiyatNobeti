export const DEV_AUTO_TEST_ALARM_PREFIX = "fiyatnobeti:dev:automatic-check-test:";
export const DEV_AUTO_TEST_STORAGE_KEY = "fiyatnobetiDeveloperAutomaticAlarmTest";

const MIN_DELAY_MINUTES = 1;
const MAX_DELAY_MINUTES = 5;
const TEST_VERSION = 1;

function publicDiagnostic(record) {
  if (!record) return { status: "empty" };
  return {
    testId: record.testId,
    asin: record.asin,
    requestedAt: record.requestedAt,
    scheduledAt: record.scheduledAt,
    alarmName: record.alarmName,
    status: record.status,
    deliveredAt: record.deliveredAt,
    completedAt: record.completedAt,
    requestStarted: record.requestStarted,
    ...(record.errorCode ? { errorCode: record.errorCode } : {})
  };
}

function normalizeStoredRecord(value) {
  if (!value || value.version !== TEST_VERSION || typeof value.testId !== "string" ||
      typeof value.asin !== "string" || typeof value.productAddedAt !== "string" ||
      typeof value.requestedAt !== "string" || typeof value.scheduledAt !== "string" ||
      typeof value.alarmName !== "string" || !value.alarmName.startsWith(DEV_AUTO_TEST_ALARM_PREFIX) ||
      !["scheduled", "running", "success", "failure", "skipped", "interrupted"].includes(value.status)) return null;
  return {
    version: TEST_VERSION,
    testId: value.testId.slice(0, 100),
    asin: value.asin.slice(0, 10),
    productAddedAt: value.productAddedAt,
    requestedAt: value.requestedAt,
    scheduledAt: value.scheduledAt,
    alarmName: value.alarmName.slice(0, 180),
    status: value.status,
    deliveredAt: typeof value.deliveredAt === "string" ? value.deliveredAt : null,
    completedAt: typeof value.completedAt === "string" ? value.completedAt : null,
    requestStarted: value.requestStarted === true,
    errorCode: typeof value.errorCode === "string" ? value.errorCode.slice(0, 80) : null
  };
}

export function installDeveloperAutomaticAlarmTest({
  chromeApi,
  prepareTarget,
  runTarget,
  now = () => Date.now(),
  createTestId = () => crypto.randomUUID()
}) {
  let mutationQueue = Promise.resolve();
  const withLock = task => {
    const next = mutationQueue.then(task, task);
    mutationQueue = next.catch(() => {});
    return next;
  };
  const readRecord = async () => {
    const stored = await chromeApi.storage.local.get(DEV_AUTO_TEST_STORAGE_KEY);
    return normalizeStoredRecord(stored[DEV_AUTO_TEST_STORAGE_KEY]);
  };
  const saveRecord = record => chromeApi.storage.local.set({ [DEV_AUTO_TEST_STORAGE_KEY]: record });

  const startup = withLock(async () => {
    const record = await readRecord();
    if (!record) return;
    if (record.status === "running") {
      record.status = "interrupted";
      record.completedAt = new Date(now()).toISOString();
      record.errorCode = "TEST_CHECK_INTERRUPTED";
      await saveRecord(record);
      await chromeApi.alarms.clear(record.alarmName);
      return;
    }
    if (record.status !== "scheduled") return;
    if (!await chromeApi.alarms.get(record.alarmName)) {
      const scheduledMs = Date.parse(record.scheduledAt);
      const when = Number.isFinite(scheduledMs) && scheduledMs > now() ? scheduledMs : now() + 60_000;
      await chromeApi.alarms.create(record.alarmName, { when });
    }
  });

  async function scheduleOneAutomaticCheckTest(delayMinutes) {
    await startup;
    if (!Number.isInteger(delayMinutes) || delayMinutes < MIN_DELAY_MINUTES || delayMinutes > MAX_DELAY_MINUTES) {
      return { status: "failure", errorCode: "INVALID_TEST_DELAY" };
    }
    return withLock(async () => {
      const existing = await readRecord();
      if (existing && ["scheduled", "running"].includes(existing.status)) {
        return { ...publicDiagnostic(existing), errorCode: "TEST_ALREADY_PENDING" };
      }

      const target = await prepareTarget();
      if (target.status !== "ready") {
        return {
          status: target.status === "busy" ? "busy" : target.status,
          asin: target.asin || null,
          errorCode: target.errorCode || "TEST_TARGET_UNAVAILABLE"
        };
      }

      const requestedMs = now();
      const scheduledMs = requestedMs + delayMinutes * 60_000;
      const testId = createTestId();
      const record = {
        version: TEST_VERSION,
        testId,
        asin: target.asin,
        productAddedAt: target.productAddedAt,
        requestedAt: new Date(requestedMs).toISOString(),
        scheduledAt: new Date(scheduledMs).toISOString(),
        alarmName: `${DEV_AUTO_TEST_ALARM_PREFIX}${testId}`,
        status: "scheduled",
        deliveredAt: null,
        completedAt: null,
        requestStarted: false,
        errorCode: null
      };
      if (existing?.alarmName) await chromeApi.alarms.clear(existing.alarmName);
      await saveRecord(record);
      try {
        await chromeApi.alarms.create(record.alarmName, { when: scheduledMs });
      } catch {
        record.status = "failure";
        record.completedAt = new Date(now()).toISOString();
        record.errorCode = "TEST_ALARM_CREATE_FAILED";
        await saveRecord(record);
      }
      return publicDiagnostic(record);
    });
  }

  async function getLastAutomaticAlarmTest() {
    await startup;
    return publicDiagnostic(await withLock(readRecord));
  }

  async function handleTestAlarm(alarm) {
    if (typeof alarm?.name !== "string" || !alarm.name.startsWith(DEV_AUTO_TEST_ALARM_PREFIX)) return;
    await startup;
    const claimed = await withLock(async () => {
      const record = await readRecord();
      if (!record || record.status !== "scheduled" || alarm.name !== record.alarmName) return null;
      const expectedTime = Date.parse(record.scheduledAt);
      if (!Number.isFinite(alarm.scheduledTime) || Math.abs(alarm.scheduledTime - expectedTime) > 1000) return null;
      record.status = "running";
      record.deliveredAt = new Date(now()).toISOString();
      record.errorCode = null;
      await saveRecord(record);
      await chromeApi.alarms.clear(record.alarmName);
      return { ...record };
    });
    if (!claimed) return;

    let result;
    try {
      result = await runTarget({ asin: claimed.asin, productAddedAt: claimed.productAddedAt });
    } catch {
      result = { status: "failure", errorCode: "TEST_CHECK_FAILED", requestStarted: false };
    }
    await withLock(async () => {
      const current = await readRecord();
      if (!current || current.testId !== claimed.testId || current.status !== "running") return;
      current.status = ["success", "failure", "skipped"].includes(result.status) ? result.status : "failure";
      current.completedAt = new Date(now()).toISOString();
      current.requestStarted = result.requestStarted === true;
      current.errorCode = result.errorCode || null;
      await saveRecord(current);
    });
  }

  chromeApi.alarms.onAlarm.addListener(handleTestAlarm);
  startup.catch(() => {});

  return Object.freeze({ scheduleOneAutomaticCheckTest, getLastAutomaticAlarmTest });
}
