/**
 * THE BOT'S LOCAL CONSOLE.
 *
 * Talks to the manager on this machine and nothing else. No framework: the
 * whole surface is one poll of GET /api/overview rendered into three regions,
 * which is less code than any abstraction over it would be, and it ships as a
 * file the manager can serve without a build.
 *
 * The rendering rule throughout: a slot's card answers "what is it doing, is
 * it waiting on me, and what can I do about it" without a second click.
 */

import { msg, NONE } from "./messages.js";

const POLL_MS = 1_000;

const el = {
  linkChip: document.getElementById("link-chip"),
  botChip: document.getElementById("bot-chip"),
  enroll: document.getElementById("enroll-card"),
  identity: document.getElementById("identity-card"),
  slots: document.getElementById("slots"),
  instances: document.getElementById("instances"),
  dialogHost: document.getElementById("dialog-host"),
  snackHost: document.getElementById("snackbar-host"),
};

let steps = [];
let localArtifacts = false;
let busy = null;
/** Rendered signature of the last paint, so an unchanged poll repaints nothing
 *  — otherwise every second would blow away focus and the open select. */
let lastSignature = "";

// ---------------------------------------------------------------- helpers

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/** "4s" / "3m 20s" — the watchdog thinks in seconds, so this does too. */
function duration(ms) {
  if (ms === null || ms === undefined) return NONE;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function api(path, init) {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : {},
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? msg.errors.http(res.status));
  return body;
}

function snack(message, bad) {
  el.snackHost.innerHTML = `<div class="md-snackbar${bad ? " error" : ""}" role="status">
    <span>${esc(message)}</span>
  </div>`;
  clearTimeout(snack.timer);
  snack.timer = setTimeout(() => (el.snackHost.innerHTML = ""), 5_000);
}

/** Runs an action with a single-flight guard, then repaints immediately. */
async function act(key, label, fn) {
  if (busy) return;
  busy = key;
  document.querySelectorAll("[data-act]").forEach((b) => (b.disabled = true));
  try {
    await fn();
    snack(label, false);
  } catch (err) {
    snack(err.message, true);
  } finally {
    busy = null;
    lastSignature = "";
    await refresh();
  }
}

// ---------------------------------------------------------------- render

/** Which colour role a slot status earns; mirrors the panel's mapping. */
function slotRole(slot) {
  if (slot.status === "FAILED") return "error";
  if (slot.stuck || slot.status === "STUCK") return "tertiary";
  if (slot.status === "DONE") return "success";
  if (!slot.alive) return "";
  return "primary";
}

function renderEnrollment(bot) {
  const e = bot.enrollment;
  if (e.state === "approved" || e.state === "standalone") {
    el.enroll.hidden = true;
    return;
  }
  el.enroll.hidden = false;
  el.enroll.innerHTML = `
    <div class="enroll">
      <span class="enroll-icon">${ICON_WAIT}</span>
      <div>
        <h2 class="md-title-lg">${e.rejection ? msg.enrollment.rejectedTitle : msg.enrollment.title}</h2>
        ${e.rejection ? `<p class="md-body-sm"><b>${esc(e.rejection)}</b></p>` : ""}
        <p class="md-body-sm">${msg.enrollment.explainHtml(esc(bot.masterUrl))}</p>
        <div class="short-id">${esc(e.shortId)}</div>
        <p class="md-body-sm">${msg.enrollment.meanwhile}</p>
      </div>
    </div>`;
}

function renderIdentity(bot) {
  const e = bot.enrollment;
  const enrollValue =
    e.state === "approved"
      ? `<span class="md-chip success dot">${msg.identity.inFleetAs(esc(e.botId))}</span>`
      : e.state === "pending"
        ? `<span class="md-chip warning dot">${msg.identity.waitingForApproval}</span>`
        : `<span class="md-chip">${msg.identity.standalone}</span>`;

  el.identity.innerHTML = `
    <div class="kv"><span>${msg.identity.machine}</span><b>${esc(bot.hostname)}</b></div>
    <div class="kv">
      <span>${msg.identity.botId}</span>
      <div>
        <b>${esc(bot.id || msg.identity.botIdUnset)}</b>
        <div class="md-body-sm md-muted">${esc(bot.idSource)}</div>
      </div>
    </div>
    <div class="kv"><span>${msg.identity.enrollment}</span><div>${enrollValue}</div></div>
    <div class="kv">
      <span>${msg.identity.controlPlane}</span>
      <div>${
        bot.link === "linked"
          ? `<span class="md-chip success dot">${msg.identity.linked}</span>`
          : `<span class="md-chip dot">${msg.identity.notConnected}</span>`
      }</div>
    </div>
    <div class="kv"><span>${msg.identity.slotsAdvertised}</span><b>${bot.workerCount}</b></div>
    <div class="kv"><span>${msg.identity.acceptingWork}</span><div>${
      bot.draining
        ? `<span class="md-chip warning dot">${msg.identity.draining}</span>`
        : `<span class="md-chip success dot">${msg.identity.acceptingYes}</span>`
    }</div></div>
    <div class="kv"><span>${msg.identity.agent}</span><span class="md-mono">${msg.identity.agentVersion(
      esc(bot.agentVersion),
    )}</span></div>`;
}

/**
 * One card per slot. The step track carries the position, the chips carry the
 * facts the watchdog uses, and the actions are exactly the ones the local
 * scripts expose — continue where it stopped, jump to a step, or end the run.
 */
function renderSlots(slots) {
  if (slots.length === 0) {
    el.slots.innerHTML = `<div class="md-card md-empty">
      <div class="md-title">${msg.slots.empty.title}</div>
      <div class="md-body-sm">${msg.slots.empty.body}</div>
    </div>`;
    return;
  }

  el.slots.innerHTML = slots
    .map((s) => {
      const role = slotRole(s);
      const attention = s.stuck || s.status === "STUCK";
      const stepIndex = s.step ? s.step.index : -1;
      const overQuiet = s.inactivityMs !== null && s.quietMs !== null && s.quietMs > s.inactivityMs;

      const track = steps
        .map((step, i) => {
          const cls =
            i < stepIndex
              ? "done"
              : i === stepIndex
                ? `here${attention ? " attention" : ""}${s.status === "FAILED" ? " failed" : ""}`
                : "";
          return `<button class="step-chip ${cls}" title="${msg.slots.resumeAtTitle(i, esc(step.key))}"
                    data-act data-resume="${s.slotIndex}" data-from="${i}"><b>${i}</b> ${esc(
                      step.key,
                    )}</button>`;
        })
        .join("");

      return `
      <article class="slot ${attention ? "attention" : ""} ${s.status === "FAILED" ? "failed" : ""}">
        <div class="slot-head">
          <span class="slot-n">${s.slotIndex}</span>
          <div class="slot-title">
            <b>${esc(s.account ?? NONE)}</b>
            <span>${esc(s.runId ?? msg.slots.noRun)}</span>
          </div>
          <span class="md-spacer"></span>
          <button class="md-btn text small md-state" data-act
                  data-retry="${s.slotIndex}">New attempt (PENDING)</button>
          <button class="md-btn text small md-state" data-act
                  data-stop="${s.slotIndex}">${msg.slots.actions.stop}</button>
          <span class="md-chip ${role} dot">${esc(s.status)}</span>
        </div>
        <div class="track">${track}</div>
        <div class="slot-meta">
          <span class="meta">
            <i>${msg.slots.meta.step}</i><b>${
              s.step
                ? `${s.step.index} · ${esc(s.step.key)}`
                : msg.slots.meta.notStarted
            }</b>
          </span>
          <span class="meta quiet ${overQuiet ? "over" : ""}"
                title="${msg.slots.quietTitle(
                  s.inactivityMs === null ? null : duration(s.inactivityMs),
                )}">
            <i>${msg.slots.meta.quiet}</i><b>${duration(s.quietMs)}</b>
          </span>
          <span class="meta" title="${msg.slots.browserTitle}">
            <i>${msg.slots.meta.browser}</i><b>${duration(s.browserIdleMs)}</b>
          </span>
          ${
            s.sheetRow
              ? `<span class="meta"><i>${msg.slots.meta.sheetRow}</i><b>${s.sheetRow}</b></span>`
              : ""
          }
          <span class="meta"><i>${msg.slots.meta.pid}</i><b>${s.pid ?? NONE}</b></span>
        </div>
        <div class="slot-actions">
          <button class="md-btn filled small md-state" data-act data-resume="${s.slotIndex}"
                  ${s.resumable ? "" : "disabled"}>${msg.slots.actions.continue}</button>
          <label class="md-field select">
            <select data-jump="${s.slotIndex}" ${s.resumable ? "" : "disabled"}>
              <option value="">${msg.slots.actions.resumeAt}</option>
              ${steps
                .map((step, i) => `<option value="${i}">${i} · ${esc(step.key)}</option>`)
                .join("")}
            </select>
          </label>
          <button class="md-btn text small md-state" data-act data-logs="${esc(s.runId ?? "")}"
                  ${s.runId ? "" : "disabled"}>${msg.slots.actions.logs}</button>
          <button class="md-btn text small md-state" data-act data-shots="${esc(s.runId ?? "")}"
                  ${s.runId && localArtifacts ? "" : "disabled"}>${msg.slots.actions.shots}</button>
          <span class="md-spacer"></span>
          <button class="md-btn text small danger md-state" data-act
                  data-cancel="${s.slotIndex}">${msg.slots.actions.endRun}</button>
        </div>
      </article>`;
    })
    .join("");
}

// ------------------------------------------------------------------ poll

async function refresh() {
  let data;
  try {
    data = await api("/api/overview");
  } catch {
    el.linkChip.className = "md-chip error dot";
    el.linkChip.textContent = msg.errors.managerUnreachable;
    return;
  }

  if (steps.length !== data.steps.length) steps = data.steps;

  const signature = JSON.stringify(data);
  if (signature === lastSignature) return;
  lastSignature = signature;

  localArtifacts = data.bot.localArtifacts === true;

  const linked = data.bot.link === "linked";
  el.linkChip.className = `md-chip dot ${linked ? "success" : "warning"}`;
  el.linkChip.textContent = linked ? msg.link.linked : msg.link.notLinked;
  el.botChip.textContent = data.bot.id || msg.link.noBotId;

  renderEnrollment(data.bot);
  renderIdentity(data.bot);
  renderSlots(data.slots);
}

// --------------------------------------------------------------- dialogs

function closeDialog() {
  el.dialogHost.innerHTML = "";
}

function openDialog(title, bodyHtml) {
  el.dialogHost.innerHTML = `
    <div class="md-scrim" data-close>
      <div class="md-dialog" role="dialog" aria-modal="true">
        <header>
          <h2 class="md-title-lg">${esc(title)}</h2>
          <span class="md-spacer"></span>
          <button class="md-btn icon text md-state" data-close
                  aria-label="${msg.dialogs.close}">✕</button>
        </header>
        <div class="dialog-body">${bodyHtml}</div>
      </div>
    </div>`;
}

async function showLogs(runId) {
  openDialog(msg.dialogs.logs.title(runId), `<div class="md-progress"></div>`);
  try {
    const res = await fetch(`/logs/${encodeURIComponent(runId)}?name=events.ndjson`);
    const text = await res.text();
    if (!res.ok) throw new Error(text);
    // Newest last is how the file reads, but the interesting end is the bottom,
    // so the pane is scrolled there once it is painted.
    const body = el.dialogHost.querySelector(".dialog-body");
    body.innerHTML = `<pre class="log">${esc(
      text.trimEnd() || msg.dialogs.logs.empty,
    )}</pre>`;
    const pre = body.querySelector(".log");
    pre.scrollTop = pre.scrollHeight;
  } catch (err) {
    el.dialogHost.querySelector(".dialog-body").innerHTML =
      `<div class="md-empty">${msg.errors.readLog(esc(err.message))}</div>`;
  }
}

async function showShots(runId) {
  openDialog(msg.dialogs.shots.title(runId), `<div class="md-progress"></div>`);
  const body = () => el.dialogHost.querySelector(".dialog-body");
  try {
    const res = await fetch(`/api/shots/${encodeURIComponent(runId)}`);
    const data = await res.json();
    if (res.status === 409) {
      body().innerHTML = `<div class="md-empty">${msg.dialogs.shots.off}</div>`;
      return;
    }
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    const shots = data.shots ?? [];
    if (shots.length === 0) {
      body().innerHTML = `<div class="md-empty">${msg.dialogs.shots.empty}</div>`;
      return;
    }
    body().innerHTML = `<div class="shots">${shots
      .map((shot) => {
        const label =
          shot.stepIndex === null
            ? msg.dialogs.shots.unknownStep
            : msg.dialogs.shots.step(shot.stepIndex, esc(shot.stepKey ?? ""));
        const src = `/shots/${encodeURIComponent(runId)}/${encodeURIComponent(shot.file)}`;
        return `<figure class="shot ${esc(shot.result ?? "")}">
            <a href="${src}" target="_blank" rel="noopener">
              <img src="${src}" alt="${esc(shot.file)}" loading="lazy">
            </a>
            <figcaption>
              <b>${label}</b>
              <span>${esc(shot.result ?? "")} · ${Math.round((shot.sizeBytes ?? 0) / 1024)} KB</span>
            </figcaption>
          </figure>`;
      })
      .join("")}</div>`;
  } catch (err) {
    body().innerHTML = `<div class="md-empty">${esc(err.message)}</div>`;
  }
}

async function showSheet() {
  openDialog(msg.dialogs.sheet.title, `<div class="md-progress"></div>`);
  try {
    const data = await api("/api/jobs");
    const body = el.dialogHost.querySelector(".dialog-body");
    if (data.jobs.length === 0) {
      body.innerHTML = `<div class="md-empty">
        <div class="md-title">${msg.dialogs.sheet.empty.title}</div>
        <div class="md-body-sm">${msg.dialogs.sheet.empty.body}</div>
      </div>`;
      return;
    }
    body.innerHTML = `
      <p class="md-body-sm md-muted">${msg.dialogs.sheet.explainHtml(data.instances)}</p>
      ${data.jobs
        .map(
          (j) => `<div class="sheet-row">
            <span class="md-chip">${msg.dialogs.sheet.row(j.rowNumber)}</span>
            <div class="md-list-text">
              <b>${esc(j.account)}</b>
              <span class="md-body-sm md-muted">${msg.dialogs.sheet.jobMeta(
                esc(j.userId),
                j.items,
                esc(j.payment),
              )}</span>
            </div>
            <span class="md-chip">${esc(j.status || msg.dialogs.sheet.statusPending)}</span>
          </div>`,
        )
        .join("")}`;
  } catch (err) {
    el.dialogHost.querySelector(".dialog-body").innerHTML =
      `<div class="md-empty">${msg.errors.readSheet(esc(err.message))}</div>`;
  }
}

// ---------------------------------------------------------------- events

document.addEventListener("click", (e) => {
  const t = e.target;

  // Close on the scrim itself (click-outside) or the explicit close button —
  // but never on a click that landed inside the dialog's content.
  if (t.matches?.(".md-scrim") || t.closest("button[data-close]")) return closeDialog();

  const resume = t.closest("[data-resume]");
  if (resume) {
    const slot = resume.dataset.resume;
    const from = resume.dataset.from;
    return act(
      `resume-${slot}`,
      from === undefined ? msg.actions.continuing(slot) : msg.actions.resumingAt(slot, from),
      () =>
        api(`/api/slots/${slot}/resume`, {
          method: "POST",
          body: JSON.stringify(from === undefined ? {} : { from: Number(from) }),
        }),
    );
  }

  const stop = t.closest("[data-stop]");
  const retry = t.closest("[data-retry]");
  if (retry) {
    const slot = retry.dataset.retry;
    return act(`retry-${slot}`, `slot ${slot}: fresh attempt queued after the current session closes`, () =>
      api(`/api/slots/${slot}/retry`, { method: "POST" }),
    );
  }
  if (stop) {
    const slot = stop.dataset.stop;
    return act(`stop-${slot}`, msg.actions.stopped(slot), () =>
      api(`/api/slots/${slot}/stop`, { method: "POST" }),
    );
  }
  const cancel = t.closest("[data-cancel]");
  if (cancel) {
    const slot = cancel.dataset.cancel;
    return act(`cancel-${slot}`, msg.actions.ended(slot), () =>
      api(`/api/slots/${slot}/cancel`, { method: "POST" }),
    );
  }

  const shots = t.closest("[data-shots]");
  if (shots && shots.dataset.shots) return showShots(shots.dataset.shots);

  const logs = t.closest("[data-logs]");
  if (logs && logs.dataset.logs) return showLogs(logs.dataset.logs);
});

document.addEventListener("change", (e) => {
  const jump = e.target.closest("[data-jump]");
  if (!jump || jump.value === "") return;
  const slot = jump.dataset.jump;
  const from = Number(jump.value);
  jump.value = "";
  act(`jump-${slot}`, msg.actions.resumingAt(slot, from), () =>
    api(`/api/slots/${slot}/resume`, {
      method: "POST",
      body: JSON.stringify({ from }),
    }),
  );
});

document.getElementById("btn-start").addEventListener("click", () => {
  const instances = Number(el.instances.value) || 1;
  act("start", msg.actions.startedJobs(instances), () =>
    api("/fleet/start", { method: "POST", body: JSON.stringify({ instances }) }),
  );
});

document.getElementById("btn-stop-all").addEventListener("click", () => {
  act("stop", msg.actions.stoppedAll, () =>
    api("/fleet/stop", { method: "POST" }),
  );
});

document.getElementById("btn-refresh-sheet").addEventListener("click", showSheet);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDialog();
});

// Material's press ripple and the app bar's scroll elevation, same as the panel.
document.addEventListener("pointerdown", (e) => {
  const target = e.target.closest?.(".md-state");
  if (!target || target.disabled) return;
  const rect = target.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const radius = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));
  const ripple = document.createElement("span");
  ripple.className = "md-ripple";
  ripple.style.left = `${x - radius}px`;
  ripple.style.top = `${y - radius}px`;
  ripple.style.width = ripple.style.height = `${radius * 2}px`;
  target.appendChild(ripple);
  ripple.addEventListener("animationend", () => ripple.remove());
});

window.addEventListener(
  "scroll",
  () => document.querySelector(".top-bar").classList.toggle("scrolled", window.scrollY > 4),
  { passive: true },
);

const ICON_WAIT = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none">
  <circle cx="12" cy="12" r="9.1" stroke="currentColor" stroke-width="1.7"/>
  <path d="M12 7v5.4l3.4 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
        stroke-linejoin="round"/>
</svg>`;

refresh();
setInterval(refresh, POLL_MS);
