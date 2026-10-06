import { runAddresses } from "./address.js";
import { loadAddress, loadConfig } from "./config.js";
import { pause } from "./human.js";
import { runLogin } from "./login.js";
import { chromium, type Browser } from "./pw.js";
import { launchForRun } from "./shardx.js";

async function main(): Promise<number> {
  const cfg = loadConfig();
  const address = loadAddress();

  let browser: Browser | undefined;
  let stop: (() => Promise<void>) | undefined;
  try {
    const launched = await launchForRun({
      runId: `diag-${Date.now()}`,
      headless: cfg.headless,
    });
    stop = () => launched.session.stop();
    console.log(`[bot] launched ${launched.summary} for ${cfg.credentials.email}`);

    browser = await chromium.connectOverCDP(launched.cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());

    const login = await runLogin(page, cfg.credentials);
    if (!login.ok) {
      console.error(`[bot] login failed: ${login.reason}`);
      return 1;
    }
    console.log("[bot] login succeeded ✓");

    const addr = await runAddresses(page, [address]);
    if (!addr.ok) {
      console.error(`[bot] address step failed: ${addr.reason}`);
      return 1;
    }
    console.log(`[bot] address step ✓ (${addr.action})`);
    await pause("all done, settling before close");
    return 0;
  } finally {
    await browser?.close().catch(() => { });
    await stop?.().catch(() => { });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("[bot] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
