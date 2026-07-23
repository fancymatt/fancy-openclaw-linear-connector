export interface StaleCronForSelfHeal {
  name: string;
  schedule: string;
  lastRunAt: string | null;
  overdueByMs: number;
}

export interface StaleCronSelfHealResult {
  attempted: Array<{ name: string; attempt: number }>;
  capped: Array<{ name: string; attempts: number }>;
  staleCrons: StaleCronForSelfHeal[];
}

const attemptsByWindow = new Map<string, Map<string, number>>();

export async function handleStaleCronsOnce(options: {
  staleCrons: StaleCronForSelfHeal[];
  detectionWindowId: string;
  now: Date;
  reinitializeCron: (cron: StaleCronForSelfHeal) => Promise<void> | void;
}): Promise<StaleCronSelfHealResult> {
  const attempted: Array<{ name: string; attempt: number }> = [];
  const capped: Array<{ name: string; attempts: number }> = [];
  let attemptsForWindow = attemptsByWindow.get(options.detectionWindowId);
  if (!attemptsForWindow) {
    attemptsForWindow = new Map<string, number>();
    attemptsByWindow.set(options.detectionWindowId, attemptsForWindow);
  }

  for (const cron of options.staleCrons) {
    const attempts = attemptsForWindow.get(cron.name) ?? 0;
    if (attempts >= 1) {
      capped.push({ name: cron.name, attempts });
      continue;
    }

    const nextAttempt = attempts + 1;
    attemptsForWindow.set(cron.name, nextAttempt);
    await options.reinitializeCron(cron);
    attempted.push({ name: cron.name, attempt: nextAttempt });
  }

  return { attempted, capped, staleCrons: options.staleCrons };
}

export function resetStaleCronSelfHealForTest(): void {
  attemptsByWindow.clear();
}
