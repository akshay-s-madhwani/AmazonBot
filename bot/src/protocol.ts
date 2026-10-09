import { classify } from "./failures.js";

export type StepResult =
  | { status: "succeeded" | "skipped" }
  | { status: "failed"; failure_code: string; detail: string; retriable: boolean };

export type RunnerEvent =
  | {
      type: "runner.ready";
      run_id: string;
      pid: number;
      start_index: number;
      control_port: number;
    }
  | { type: "step.started"; run_id: string; step_index: number; step_key: string }
  /** A page stayed unloaded too long: the runner refreshed it and exits; restart this step (stall.ts). */
  | { type: "step.restart"; run_id: string; step_index: number; step_key: string; reason: string }
  | {
      type: "step.finished";
      run_id: string;
      step_index: number;
      step_key: string;
      result: StepResult;
      screenshot: string | null;
      url: string | null;
    }
  | { type: "run.finished"; run_id: string; outcome: "SUCCEEDED" | "FAILED" }
  | {
      type: "runner.waiting";
      run_id: string;
      port: number;
      reason?: "failed" | "paused";
      /** The last step the runner completed before parking. */
      after_step?: number;
    };

export interface RunnerConfig {
  run_id: string;
  cdp_url: string;
  slot_url: string;
  token: string;
  start_index: number;
  storage_state_path: string;
  artifacts_dir: string;
  /**
   * CHECKPOINT: park in the tab after this step succeeds instead of running on.
   * Absent means run to the end — which includes placing the order.
   */
  stop_after?: number;
  /**
   * REMOVE BLOCKS: the operator has aligned the checkout by hand. Checks that
   * would stop the run between proceed_to_buy and Pay Now are logged and
   * passed over — see UNBLOCKABLE_FROM in steps.ts.
   */
  unblocked?: boolean;
}

export async function postEvent(
  slotUrl: string,
  token: string,
  event: RunnerEvent,
): Promise<void> {
  try {
    await fetch(`${slotUrl}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(event),
    });
  } catch (err) {
    console.error(`[runner] failed to report ${event.type}: ${(err as Error).message}`);
  }
}

export function classifyFailure(reason: string): string {
  return classify(reason).code;
}
