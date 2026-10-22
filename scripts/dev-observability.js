export const DEV_EVENT_STORAGE_KEY = "fiyatnobetiDeveloperAutomaticEvents";
export const DEV_EVENT_VERSION = 1;
export const MAX_DEV_EVENTS = 40;

const EVENT_TYPES = new Set([
  "service_worker_started", "automatic_alarm_scheduled", "automatic_alarm_delivered",
  "automatic_check_selected", "automatic_request_started", "automatic_check_completed",
  "automatic_check_skipped", "check_interrupted"
]);

function isoTime(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safeEvent(value) {
  if (!value || !EVENT_TYPES.has(value.type) || !isoTime(value.at)) return null;
  const event = { at: isoTime(value.at), type: value.type };
  if (typeof value.asin === "string" && /^[A-Z0-9]{10}$/.test(value.asin)) event.asin = value.asin;
  if (value.alarmName === "fiyatnobeti:automatic-price-check") event.alarmName = value.alarmName;
  if (isoTime(value.scheduledAt)) event.scheduledAt = isoTime(value.scheduledAt);
  if (["success", "failure", "busy", "skipped"].includes(value.outcome)) event.outcome = value.outcome;
  if (typeof value.errorCode === "string" && /^[A-Z0-9_]{1,60}$/.test(value.errorCode)) event.errorCode = value.errorCode;
  if (typeof value.requestStarted === "boolean") event.requestStarted = value.requestStarted;
  return event;
}

function normalize(value) {
  if (value?.version !== DEV_EVENT_VERSION || !Array.isArray(value.events)) {
    return { version: DEV_EVENT_VERSION, events: [] };
  }
  return {
    version: DEV_EVENT_VERSION,
    events: value.events.slice(-MAX_DEV_EVENTS).map(safeEvent).filter(Boolean)
  };
}

export function installDeveloperObservability({ chromeApi, now = () => Date.now() }) {
  let queue = Promise.resolve();
  const read = async () => {
    const stored = await chromeApi.storage.local.get(DEV_EVENT_STORAGE_KEY);
    return normalize(stored[DEV_EVENT_STORAGE_KEY]);
  };

  function record(event) {
    const safe = safeEvent({ ...event, at: new Date(now()).toISOString() });
    if (!safe) return Promise.resolve();
    const next = queue.then(async () => {
      const data = await read();
      data.events.push(safe);
      data.events = data.events.slice(-MAX_DEV_EVENTS);
      await chromeApi.storage.local.set({ [DEV_EVENT_STORAGE_KEY]: data });
    });
    queue = next.catch(() => {});
    return next;
  }

  async function getAutomaticCheckDiagnostics() {
    await queue;
    try { return await read(); }
    catch { return { version: DEV_EVENT_VERSION, events: [], errorCode: "DIAGNOSTIC_STORAGE_ERROR" }; }
  }

  return Object.freeze({ record, getAutomaticCheckDiagnostics });
}
