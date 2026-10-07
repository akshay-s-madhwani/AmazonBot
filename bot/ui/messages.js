/**
 * EVERY STRING THE OPERATOR READS IN THIS CONSOLE, in one place.
 *
 * Same idea as apps/panel/src/messages.ts, and deliberately a SEPARATE file:
 * this console ships inside the bot package and is served off disk with no
 * bundler, so it cannot import from apps/panel — which does not travel with
 * the bot at all. The two files are siblings, not a shared module.
 *
 * Loaded as a plain ES module by console.js, which is already
 * `<script type="module">`, so this needs no build step.
 *
 * Interpolated copy is a FUNCTION so the whole sentence stays readable here
 * rather than being assembled from fragments at the call site. Anything that
 * returns HTML says so; the caller is still responsible for escaping the DATA
 * it passes in (console.js has `esc` for that) — these functions escape
 * nothing.
 *
 * The static chrome in index.html (the page title, section headings, the three
 * toolbar buttons) is not here: it is markup the browser renders without this
 * script, and pulling it into JS would mean the page says nothing until the
 * module loads.
 */

/** The em dash this console uses wherever a value is absent. */
export const NONE = "—";

export const msg = {
  common: {
    none: NONE,
  },

  errors: {
    http: (status) => `HTTP ${status}`,
    /** The poll itself failed — the manager on this machine is not answering. */
    managerUnreachable: "manager unreachable",
    readLog: (reason) => `could not read the log — ${reason}`,
    readSheet: (reason) => `could not read the sheet — ${reason}`,
  },

  link: {
    linked: "linked to master",
    notLinked: "not linked",
    noBotId: "no bot id",
  },

  /**
   * The pre-approval state. This is the only screen a freshly set up machine
   * has, and the operator reading it is standing at the machine — so it has to
   * say what to do next and where, not just that something is pending.
   */
  enrollment: {
    title: "Waiting to be approved",
    rejectedTitle: "Rejected by the control panel",
    explainHtml: (masterUrl) =>
      `This machine has announced itself to ${masterUrl} and is waiting for an ` +
      `operator. Open the control panel, go to <b>Bot Grid</b>, and approve the request ` +
      `showing this short id:`,
    meanwhile:
      "Until then this bot runs standalone — everything below still works, but nothing is " +
      "reported upstream.",
  },

  identity: {
    machine: "Machine",
    botId: "Bot id",
    botIdUnset: "unset",
    enrollment: "Enrollment",
    inFleetAs: (botId) => `in the fleet as ${botId}`,
    waitingForApproval: "waiting for approval",
    standalone: "standalone",
    controlPlane: "Control plane",
    linked: "linked",
    notConnected: "not connected",
    slotsAdvertised: "Slots published",
    acceptingWork: "Accepting work",
    draining: "draining",
    acceptingYes: "yes",
    agent: "Agent",
    agentVersion: (v) => `v${v}`,
  },

  slots: {
    empty: {
      title: "No slots running",
      body: "Start a job above and it will appear here.",
    },
    noRun: "no run",
    notStarted: "not started",
    stepAt: (index, key) => `step ${index} · ${key}`,
    /** Tooltip on one notch of the step track. */
    resumeAtTitle: (index, key) => `resume at ${index} · ${key}`,
    quiet: (duration) => `quiet ${duration}`,
    /** Meta row: a label and its value, shown as data rather than as chips. */
    meta: {
      step: "step",
      notStarted: "not started",
      quiet: "quiet",
      browser: "browser",
      sheetRow: "sheet row",
      pid: "pid",
    },
    /** Why "quiet" matters: it is what the watchdog measures against. */
    quietTitle: (limit) =>
      "time since the runner last reported" +
      (limit === null ? "" : ` · this step's limit is ${limit}`),
    browser: (duration) => `browser ${duration}`,
    browserTitle: "time the browser itself has been idle",
    sheetRow: (row) => `sheet row ${row}`,
    pid: (pid) => `pid ${pid ?? NONE}`,
    actions: {
      continue: "Continue",
      resumeAt: "Resume at…",
      logs: "Logs",
      shots: "Screenshots",
      stop: "Stop",
      endRun: "Cancel and close",
    },
  },

  actions: {
    continuing: (slot) => `slot ${slot} continuing`,
    resumingAt: (slot, step) => `slot ${slot} resuming at step ${step}`,
    /**
     * The browser deliberately survives both of these. Saying so is the whole
     * point — an operator who thinks the browser died will not come back for
     * the logged-in session that is still sitting there.
     */
    stopped: (slot) => `slot ${slot} stopped — its browser stays open`,
    ended: (slot) => `slot ${slot} cancelled — its browser is closing`,
    startedJobs: (instances) => `asked for ${instances} job(s)`,
    stoppedAll: "all slots stopped — browsers deliberately left open",
  },

  dialogs: {
    close: "close",

    logs: {
      title: (runId) => `Logs · ${runId}`,
      empty: "(no events yet)",
    },

    shots: {
      title: (runId) => `Screenshots · ${runId}`,
      empty: "No screenshots found for this run yet.",
      off:
        "Local screenshots are off. Set LOCAL_ARTIFACTS=true in bot/.env and " +
        "restart the bot to keep a copy on this machine.",
      step: (index, key) => `${index} · ${key}`,
      unknownStep: "(unrecognised filename)",
    },

    sheet: {
      title: "Jobs for this machine",
      empty: {
        title: "Nothing pending",
        body: "The master has no row addressed to this machine's bot id.",
      },
      /**
       * Says WHERE the node_id match is enforced, because that is the question
       * an operator asks when a row they expected does not appear here.
       */
      explainHtml: (instances) =>
        `The master's Config says ${instances} instance(s). It only returns rows whose ` +
        `<b>node_id</b> matches this machine — that exact match is what stops two bots racing ` +
        `for one account, and it is enforced on the master, not here.`,
      row: (rowNumber) => `row ${rowNumber}`,
      jobMeta: (userId, items, payment) => `user ${userId} · ${items} item(s) · ${payment}`,
      statusPending: "pending",
    },
  },
};
