/**
 * P4-3 Distillation Job Runner
 *
 * This module provides a standalone script to run P4-3 distillation manually or as a cron job.
 * Run with: tsx src/cron/p4-distillation-job.ts
 */

import { ObservationStore } from "../store/observation-store.js";
import { runDistillation } from "./p4-metrics-distillation.js";

async function main() {
  console.log("🧠 P4-3: Running metrics distillation into skill-workshop proposals\n");

  try {
    // Initialize observation store (reads from data/observations.db)
    console.log("📊 Loading observation store...");
    const observationStore = new ObservationStore();

    // Run distillation
    const threshold = process.env.P4_DISTILL_THRESHOLD
      ? parseInt(process.env.P4_DISTILL_THRESHOLD, 10)
      : undefined;

    console.log(`🔍 Checking for patterns exceeding threshold=${threshold ?? "default (3)"}`);
    const result = await runDistillation(observationStore, threshold);

    // Output results
    console.log(`\n✅ Distillation complete:`);
    console.log(`   - Proposals created: ${result.proposalsCreated}`);
    console.log(`   - Patterns crossed: ${result.patternsCrossed}`);
    console.log(`   - Skipped: ${result.skipped.length}`);

    if (result.skipped.length > 0) {
      console.log(`\n   Skipped patterns:`);
      for (const skip of result.skipped) {
        console.log(`     - ${skip.pattern}: ${skip.reason}`);
      }
    }

    if (result.error) {
      console.error(`\n❌ Error: ${result.error}`);
      process.exit(1);
    }

    observationStore.close();
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { main };
