import test from "node:test";
import assert from "node:assert/strict";
import { installDeveloperObservability, MAX_DEV_EVENTS, DEV_EVENT_STORAGE_KEY } from "../scripts/dev-observability.js";

function fixture() {
  const data = {};
  let now = Date.parse("2026-10-22T00:00:00Z");
  const chromeApi = { storage: { local: {
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  } } };
  return { data, setNow: value => { now = Date.parse(value); },
    observer: installDeveloperObservability({ chromeApi, now: () => now }) };
}

test("developer events distinguish schedule, delivery, request start, completion and remain bounded", async () => {
  const { data, observer, setNow } = fixture();
  const empty = await observer.getAutomaticCheckDiagnostics();
  assert.deepEqual(empty, { version: 1, events: [] });
  const alarmName = "fiyatnobeti:automatic-price-check";
  await observer.record({ type: "automatic_alarm_scheduled", alarmName, scheduledAt: "2026-10-22T06:00:00Z" });
  setNow("2026-10-22T06:01:00Z");
  await observer.record({ type: "automatic_alarm_delivered", alarmName });
  await observer.record({ type: "automatic_request_started", asin: "B0FZ9Y4GPF", requestStarted: true });
  await observer.record({ type: "automatic_check_completed", asin: "B0FZ9Y4GPF", outcome: "failure", errorCode: "PRICE_MISSING", requestStarted: true });
  const events = (await observer.getAutomaticCheckDiagnostics()).events;
  assert.deepEqual(events.map(event => event.type), [
    "automatic_alarm_scheduled", "automatic_alarm_delivered", "automatic_request_started", "automatic_check_completed"
  ]);
  assert.equal(events[0].scheduledAt, "2026-10-22T06:00:00.000Z");
  assert.equal(events[0].requestStarted, undefined);
  assert.equal(events[1].requestStarted, undefined);
  assert.equal(events[2].requestStarted, true);
  for (let index = 0; index < 70; index++) {
    await observer.record({ type: "automatic_check_skipped", asin: "B0FZ9Y4GPF" });
  }
  assert.equal(data[DEV_EVENT_STORAGE_KEY].version, 1);
  assert.equal((await observer.getAutomaticCheckDiagnostics()).events.length, MAX_DEV_EVENTS);
});

test("event recorder discards arbitrary URLs, HTML, headers and title-like fields", async () => {
  const { observer } = fixture();
  await observer.record({ type: "check_interrupted", asin: "B0FZ9Y4GPF", errorCode: "CHECK_INTERRUPTED",
    url: "https://private.example/a", html: "<html>secret</html>", cookies: "secret", title: "Secret" });
  const result = await observer.getAutomaticCheckDiagnostics();
  assert.deepEqual(result.events[0], {
    at: "2026-10-22T00:00:00.000Z", type: "check_interrupted", asin: "B0FZ9Y4GPF", errorCode: "CHECK_INTERRUPTED"
  });
  assert.doesNotMatch(JSON.stringify(result), /private|secret/i);
});
