/**
 * Web settings editing: maximum download size, browser interaction
 * approval, idle expiry, download retention, browser visibility, and the
 * a-la-carte browser permissions submenu with its YOLO master override
 * (all staged through the root menu's shared Save/Cancel transaction).
 */
import {
  BROWSER_PERMISSION_FIELDS,
  type BrowserInteractionApproval,
  type BrowserPermissionField,
  type WebBrowserPermissions,
} from "../config";
import { alignedSettingsRows, formatByteSize, notify, type UiContext } from "./ui";
import { retainedChoice, retainedSelect } from "./menu";
import { editSettingText } from "./text-input";

export const BROWSER_APPROVAL_CHOICES: Record<BrowserInteractionApproval, string> = {
  ask: "Ask",
  "automatically-accept": "Automatically Accept",
  "automatically-deny": "Automatically Deny",
};

export async function selectWebSettings(
  ui: UiContext,
  initialMaxDownloadBytes: number,
  initialApproval: BrowserInteractionApproval,
  initialIdleExpiryMinutes: number,
  initialDownloadRetention: number,
  initialVisible: boolean,
  initialPermissions: WebBrowserPermissions,
): Promise<{ maxDownloadBytes: number; browserInteractionApproval: BrowserInteractionApproval; browserIdleExpiryMinutes: number; browserDownloadRetention: number; browserVisible: boolean; browserPermissions: WebBrowserPermissions }> {
  let maxDownloadBytes = initialMaxDownloadBytes;
  let browserInteractionApproval = initialApproval;
  let browserIdleExpiryMinutes = initialIdleExpiryMinutes;
  let browserDownloadRetention = initialDownloadRetention;
  let browserVisible = initialVisible;
  let browserPermissions = { ...initialPermissions };
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const [downloadRow, approvalRow, idleExpiryRow, retentionRow, visibilityRow, permissionsRow] = alignedSettingsRows([
      ["Maximum download", formatByteSize(maxDownloadBytes)],
      ["Browser interaction approval", BROWSER_APPROVAL_CHOICES[browserInteractionApproval]],
      ["Browser idle expiry", browserIdleExpiryMinutes === 0 ? "0 · idle close disabled" : `${browserIdleExpiryMinutes} minutes`],
      ["Download retention", browserDownloadRetention === 0 ? "0 · unlimited unsaved downloads" : `${browserDownloadRetention} unsaved per session`],
      ["Browser visibility", browserVisible ? "Headed · visible browser window" : "Headless · no window (default)"],
      ["Browser permissions", browserPermissionsSummary(browserPermissions)],
    ]);
    const choice = await retainedSelect(ui, {
      title: "Web settings",
      rows: [
        { key: "download", label: downloadRow },
        { key: "approval", label: approvalRow },
        { key: "idleExpiry", label: idleExpiryRow },
        { key: "retention", label: retentionRow },
        { key: "visibility", label: visibilityRow },
        { key: "permissions", label: permissionsRow },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return { maxDownloadBytes, browserInteractionApproval, browserIdleExpiryMinutes, browserDownloadRetention, browserVisible, browserPermissions };
    lastKey = choice;
    if (choice === "visibility") {
      await notify(ui, "Headless (default) keeps the QA browser without a window. Headed shows a real browser window with a native address bar. Saving a changed visibility applies it immediately to the live browser: the browser is replaced and its tabs, active page, and in-memory cookies/localStorage/IndexedDB are restored best-effort (never lossless; failures and redirects are reported). With no open browser it applies at the next BrowserOpen. The model's tools stay exactly the same either way.", "info");
      const selected = await retainedChoice(ui, "Browser visibility", ["Headless · no window (default)", "Headed · visible browser window"]);
      if (selected === "Headed · visible browser window") browserVisible = true;
      else if (selected === "Headless · no window (default)") browserVisible = false;
      continue;
    }
    if (choice === "permissions") {
      browserPermissions = await selectBrowserPermissions(ui, browserPermissions);
      continue;
    }
    if (choice === "approval") {
      await notify(ui, "Only confirmation-required actions: Ask prompts (no UI rejects); Automatically Accept approves without UI; Automatically Deny rejects. Already-permitted observations/local actions stay permitted; hard safety and role restrictions remain. Saved changes apply locally now and to newly launched workers.", "info");
      const selected = await retainedChoice(ui, "Browser interaction approval", Object.values(BROWSER_APPROVAL_CHOICES));
      const entry = Object.entries(BROWSER_APPROVAL_CHOICES).find(([, label]) => label === selected);
      if (entry) browserInteractionApproval = entry[0] as BrowserInteractionApproval;
      continue;
    }
    if (choice === "idleExpiry") {
      const entered = await editSettingText(
        ui,
        "Browser idle expiry in minutes (0 disables idle close)",
        String(browserIdleExpiryMinutes),
        "This UI does not support numeric input.",
      );
      if (entered === undefined) continue;
      // Empty input must stay rejected: Number("") would otherwise stage 0.
      const trimmed = entered.trim();
      const minutes = trimmed.length === 0 ? NaN : Number(trimmed);
      if (!Number.isSafeInteger(minutes) || minutes < 0) {
        await notify(ui, "Enter 0 to disable idle close, or a positive safe whole number of minutes.", "error");
        continue;
      }
      browserIdleExpiryMinutes = minutes;
      continue;
    }
    if (choice === "retention") {
      await notify(ui, "Maximum retained unsaved downloads per browser session. While the cap is reached, a new download cancels and releases the oldest retained one (after a live lowering, the next arrival may release more than one); saved files are never counted or affected. 0 disables count-based eviction entirely (normal save/close/revocation cleanup still applies). A lowered value takes effect when the next download arrives; editing this setting never deletes pending downloads.", "info");
      const entered = await editSettingText(
        ui,
        "Maximum retained unsaved downloads per browser session (0 = unlimited)",
        String(browserDownloadRetention),
        "This UI does not support numeric input.",
      );
      if (entered === undefined) continue;
      // Empty input must stay rejected: Number("") would otherwise stage 0.
      const trimmed = entered.trim();
      const retention = trimmed.length === 0 ? NaN : Number(trimmed);
      if (!Number.isSafeInteger(retention) || retention < 0) {
        await notify(ui, "Enter 0 for unlimited, or a positive safe whole number of retained unsaved downloads.", "error");
        continue;
      }
      browserDownloadRetention = retention;
      continue;
    }
    const entered = await editSettingText(
      ui,
      "Maximum download size in MiB",
      String(maxDownloadBytes / (1024 * 1024)),
      "This UI does not support numeric input.",
    );
    if (entered === undefined) continue;
    const mebibytes = Number(entered.trim());
    if (!Number.isSafeInteger(mebibytes) || mebibytes < 1 || mebibytes > 2_048) {
      await notify(ui, "Enter a whole number from 1 through 2048 MiB.", "error");
      continue;
    }
    maxDownloadBytes = mebibytes * 1024 * 1024;
  }
}

/** One-line state of the a-la-carte browser permissions for the Web row. */
function browserPermissionsSummary(permissions: WebBrowserPermissions): string {
  if (permissions.yolo) return "YOLO on";
  const enabled = BROWSER_PERMISSION_FIELDS.filter((field) => field !== "yolo" && permissions[field]).length;
  return `${enabled} of ${BROWSER_PERMISSION_FIELDS.length - 1} enabled`;
}

/**
 * Risk-appropriate enablement notices for the individual capability toggles
 * (issue #27). Disabling never warns: turning a permission off is
 * straightforward and can only reduce authority.
 */
const BROWSER_PERMISSION_ROWS: ReadonlyArray<{
  field: BrowserPermissionField;
  label: string;
  enableWarning?: string;
}> = [
  {
    field: "modelCredentialEntry",
    label: "Model credential entry",
    enableWarning: "Model credential entry lets the model type into password and credential fields. Entered values can still be exposed through tool results, model context, logs, and screenshots; masking alone does not protect secrets.",
  },
  {
    field: "modelCredentialSubmission",
    label: "Model credential submission",
    enableWarning: "Model credential submission lets the model submit forms containing credentials. It grants no broader network or filesystem authority. Human form submission is always allowed regardless of this toggle.",
  },
  {
    field: "modelUploads",
    label: "Model uploads",
    enableWarning: "Model uploads lets the model upload explicitly chosen host files into a page file input (BrowserUpload). Each upload follows the configured browser interaction approval policy and names the exact source paths; this is not permission for a page or model to read arbitrary host files. Human uploads are unaffected.",
  },
  {
    field: "modelDownloadSaving",
    label: "Model download saving",
    enableWarning: "Model download saving lets the model save retained pending downloads to explicitly chosen destinations, wherever the model's existing host write authority reaches (BrowserDownloadSave; relative paths resolve to the session working directory). Each save follows the configured browser interaction approval policy. Human downloads are unaffected.",
  },
  {
    field: "modelClipboard",
    label: "Model clipboard read/write",
    enableWarning: "Model clipboard access lets the model read from and write to the browser clipboard (the host system clipboard in a headed session; a per-instance virtual clipboard in headless mode), which can carry credentials or other secrets between applications.",
  },
  {
    field: "modelCamera",
    label: "Model camera",
    enableWarning: "Model camera grants camera access to the managed browser for model-driven sessions. This grants capability; it does not force activation.",
  },
  {
    field: "modelMicrophone",
    label: "Model microphone",
    enableWarning: "Model microphone grants microphone access to the managed browser for model-driven sessions. This grants capability; it does not force activation.",
  },
  {
    field: "modelGeolocation",
    label: "Model geolocation",
    enableWarning: "Model geolocation grants location access to the managed browser for model-driven sessions. Location is sensitive personal data.",
  },
  {
    field: "modelServiceWorkers",
    label: "Model service workers",
    enableWarning: "Model service workers allows service workers in the managed browser. This grants capability; it does not force registration or activation. The policy is fixed at browser launch, so enabling or disabling it while a browser session is live replaces that session in a controlled way (tabs, storage state, and granted permissions are restored best-effort and every loss is reported). Service-worker traffic still egresses only through the authenticated broker.",
  },
  {
    field: "modelPopupRestrictionOverride",
    label: "Model popup restriction override",
    enableWarning: "Model popup restriction override lifts the four-tab session limit for page-created popups while enabled: such popups are adopted as owned tabs with the same guards, routes, and broker egress as model-opened tabs. Model-initiated opens and ordinary browsing stay within the limit; already-adopted popup tabs remain open if you disable it.",
  },
  {
    field: "localNetworks",
    label: "Local networks (human and model)",
    enableWarning: "Local networks allows human and model navigation to loopback, private, and link-local addresses — including cloud metadata endpoints. This opens SSRF-style access to local services and instance metadata; use it only for intentional local-service or machine-role debugging.",
  },
];

const YOLO_PERMISSION_LABEL = "YOLO / allow everything";

const YOLO_ENABLE_WARNING =
  "YOLO enables every browser permission — model credential entry and submission, uploads, download saving, " +
  "clipboard read/write, camera, microphone, geolocation, service workers, popup restriction override, and local " +
  "network access including loopback, private, link-local, and cloud metadata addresses — and bypasses per-action " +
  "approval prompts (Ask, Automatically Accept, and Automatically Deny). Browsing can reach any destination with " +
  "full capability, and page content remains untrusted. This persists until you explicitly disable it; only a human " +
  "can enable or disable it.";

const YOLO_CONFIRM_MESSAGE =
  "Confirm enabling YOLO / allow everything for the managed browser. It stays enabled across restarts until you " +
  "disable it here; disabling is immediate and restores your saved individual permissions as the effective policy.";

/**
 * The Browser permissions submenu (issue #27): independently selectable
 * capability toggles plus the YOLO master override, staged like every other
 * settings section (Save/Cancel at the root).
 *
 * - Enabling an individual capability presents its risk-appropriate notice and
 *   then applies the staged toggle; disabling is straightforward.
 * - Every YOLO OFF → ON transition requires a prominent warning plus explicit
 *   interactive human confirmation. Cancellation, an unavailable confirm UI,
 *   or a failed save leaves it Off. Only this human-invoked command can enable
 *   it; page content and workers never reach this code path.
 * - YOLO ON → OFF is straightforward: no warning or confirmation, and the saved
 *   individual values become effective again exactly as stored.
 */
async function selectBrowserPermissions(ui: UiContext, initial: WebBrowserPermissions): Promise<WebBrowserPermissions> {
  let permissions = { ...initial };
  // Truthful status: every issue #27 capability is enforced. Credential
  // entry/submission, uploads, download saving, and clipboard read/write by
  // the interactive-browser tool actions; camera, microphone, and geolocation
  // as per-origin device grants issued on top-level navigation commits and
  // cleared live on disable (an unconfirmable engine clear fails the affected
  // session closed and is reported through the save rather than claimed
  // applied; a clear that does not settle within the cleanup deadline is
  // reported as still in flight and the affected session is closed to contain
  // any retained grants); service workers
  // at browser launch, with a
  // controlled replacement of a live browser when the saved policy changes;
  // the popup restriction override while it is enabled; local networks (and
  // YOLO's local-network effect) at the interactive egress broker.
  await notify(
    ui,
    "These stage the issue #27 browser permissions, and every capability is enforced. Credential entry/submission, uploads, download saving, and clipboard read/write are enforced by interactive-browser tool actions; camera, microphone, and geolocation apply as per-origin device permission grants issued when a tab commits to an origin (and cleared from live sessions when disabled — an unconfirmable engine clear closes the affected browser session instead of being claimed applied, and a clear that does not settle within the cleanup deadline is reported as still in flight and the affected session is closed to contain any retained grants); service workers apply at browser launch, so a saved change replaces the live browser in a controlled way that restores tabs, storage state, and granted permissions best-effort; the popup restriction override lifts the four-tab limit for page-created popups while enabled; local networks (including YOLO's local-network effect) is enforced at the interactive egress broker. Saved changes apply to the live session immediately.",
    "info",
  );
  // Caller-local last selection for this loop only: keys are the permission
  // field names (plus yolo/back), stable across the On/Off label flips, so a
  // toggled row stays highlighted on the re-show (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const rowLabels = alignedSettingsRows([
      ...BROWSER_PERMISSION_ROWS.map((row) => [row.label, permissions[row.field] ? "On" : "Off"] as const),
      [YOLO_PERMISSION_LABEL, permissions.yolo ? "On" : "Off"] as const,
    ]);
    const choice = await retainedSelect(ui, {
      title: "Browser permissions",
      rows: [
        ...BROWSER_PERMISSION_ROWS.map((row, index) => ({ key: row.field, label: rowLabels[index]! })),
        { key: "yolo", label: rowLabels[rowLabels.length - 1]! },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return permissions;
    lastKey = choice;
    if (choice === "yolo") {
      if (permissions.yolo) {
        permissions.yolo = false;
        await notify(ui, "YOLO disabled; the saved individual browser permissions are effective again.", "info");
      } else if (!await confirmYoloEnablement(ui)) {
        continue;
      } else {
        permissions.yolo = true;
      }
      continue;
    }
    const row = BROWSER_PERMISSION_ROWS.find((candidate) => candidate.field === choice);
    if (!row) continue;
    if (!permissions[row.field] && row.enableWarning) {
      await notify(ui, row.enableWarning, "warning");
    }
    permissions[row.field] = !permissions[row.field];
  }
}

/** Prominent warning plus explicit human confirmation for YOLO OFF → ON. */
async function confirmYoloEnablement(ui: UiContext): Promise<boolean> {
  await notify(ui, YOLO_ENABLE_WARNING, "warning");
  if (!ui.confirm) {
    await notify(ui, "YOLO requires an interactive confirmation dialog to enable; it stays Off.", "error");
    return false;
  }
  const confirmed = await ui.confirm("Enable YOLO / allow everything?", YOLO_CONFIRM_MESSAGE);
  if (!confirmed) {
    await notify(ui, "YOLO stays Off.", "info");
    return false;
  }
  return true;
}
