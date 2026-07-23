import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { DispatchAckTracker } from "../bag/dispatch-ack-tracker.js";
import {
  getRegisteredCrons,
  resetCronRegistryForTest,
} from "../cron/registry.js";
import { OperationalEventStore } from "../store/operational-event-store.js";
import { DispatchDeliveryScheduler } from "./dispatch-delivery-scheduler.js";

const NOW = new Date("2026-07-23T03:00:00.000Z");

describe("DispatchDeliveryScheduler cron liveness", () => {
  let scheduler: DispatchDeliveryScheduler | undefined;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    resetCronRegistryForTest();
  });

  afterEach(() => {
    scheduler?.stop();
    scheduler = undefined;
    resetCronRegistryForTest();
    jest.useRealTimers();
  });

  test("stamps markCronRun when the heartbeat tick fires", () => {
    scheduler = new DispatchDeliveryScheduler({
      eventStore: {} as OperationalEventStore,
      ackTracker: {} as DispatchAckTracker,
      heartbeatMs: 1_000,
    });

    scheduler.start();

    expect(
      getRegisteredCrons().find((cron) => cron.name === "dispatch-delivery-scheduler"),
    ).toEqual(
      expect.objectContaining({
        schedule: "every 1s",
        lastRunAt: null,
      }),
    );

    jest.advanceTimersByTime(1_000);

    expect(
      getRegisteredCrons().find((cron) => cron.name === "dispatch-delivery-scheduler"),
    ).toEqual(
      expect.objectContaining({
        lastRunAt: "2026-07-23T03:00:01.000Z",
      }),
    );
  });
});
