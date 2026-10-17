import type { Status } from "@allclear/shared";
import { aggregateStatus, deriveSnapshotComponent, isFaultSeverity } from "@allclear/shared";

import { AdminField, AdminForm, AdminSelect } from "@/components/admin/admin-form";
import { DateTimeField } from "@/components/admin/datetime-field";
import { LocalTime } from "@/components/local-time";
import { StatusBadge } from "@/components/status-badge";
import { readPage, readPublicStatus } from "@/lib/admin-api";
import { statusTone } from "@/lib/status-display";
import { cn } from "@/lib/utils";
import {
  addChangeUpdateAction,
  closeManualImpactAction,
  createChangeAction,
  createComponentAction,
  createManualImpactAction,
  createProbeAction,
  createSectionAction,
  deleteComponentAction,
  deleteProbeAction,
  deleteSectionAction,
  renamePageAction,
  rebuildSnapshotAction,
  setChangeStatusAction,
  updateComponentAction,
  updateProbeAction,
  updateSectionAction,
} from "../../actions";

/**
 * Everything the console can change about one page.
 *
 * ## The shape of this page
 *
 * Six sections in the order the data nests: the page itself, its sections, the
 * components inside them, the probe targets on those components, the changes
 * that describe incidents, and the hand-entered impacts that feed the uptime
 * maths. Each section is a list of rows plus the form that adds one.
 *
 * ## Why the derived status is shown here
 *
 * The console edits stored rows. What a visitor sees is *derived* from those rows
 * at read time — statuses come from active impacts and probe evidence, not from a
 * column. An editor that only showed the stored data would let an operator
 * believe they had fixed something when they had only changed an input nothing
 * reads. So the panel at the top is the real public read path, the same call the
 * status page makes.
 *
 * ## Why several writes are missing on purpose
 *
 * There is no delete for a page, no delete for a change, and no editing of a
 * probe-generated impact. Each is a real gap and each is deliberate:
 *
 *   * Deleting a page cascades to its components and their impacts, and the
 *     public URL and every RSS reader's subscription die with it. That is a
 *     decision that wants a conversation, not a button next to a table.
 *   * A change is the public record of an incident. Correcting one is an update,
 *     which is supported; erasing one is not.
 *   * A probe-generated impact is owned by the probe state machine, which will
 *     reopen it on the next failing observation. A close button would appear to
 *     work and then silently stop working.
 */

export const dynamic = "force-dynamic";

const FAULT_SEVERITIES = [
  { value: "degraded_performance", label: "degraded_performance" },
  { value: "partial_outage", label: "partial_outage" },
  { value: "full_outage", label: "full_outage" },
];

const CHANGE_STATUSES = [
  { value: "scheduled", label: "scheduled" },
  { value: "in_progress", label: "in_progress" },
  { value: "verifying", label: "verifying" },
  { value: "resolved", label: "resolved" },
  { value: "completed", label: "completed" },
];

export default async function AdminPageDetail({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [detail, publicRead] = await Promise.all([readPage(slug), readPublicStatus(slug)]);

  if (!detail.ok || detail.data === null) {
    return (
      <div className="flex flex-col gap-3" data-testid="page-unavailable">
        <h1 className="text-xl font-semibold tracking-tight">Could not read {slug}</h1>
        <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">
          {detail.status === 404
            ? "No page has that slug."
            : "The request to the API did not complete."}
        </p>
        <a href="/admin" className="text-sm underline underline-offset-4">
          Back to the page list
        </a>
      </div>
    );
  }

  const { page, sections, components, probes, changes, impacts } = detail.data;

  // The public read is best-effort: the console must still be usable when the
  // snapshot cannot be built, and that is exactly when an operator needs it.
  const snapshot = publicRead.ok ? publicRead.data?.snapshot ?? null : null;
  const derived = new Map<string, { status: Status; reason: string }>(
    snapshot === null
      ? []
      : snapshot.components.map((component) => [
          component.publicId,
          deriveSnapshotComponent(component, Math.floor(Date.now() / 1000)),
        ]),
  );
  const overall =
    snapshot === null ? null : aggregateStatus([...derived.values()].map((entry) => entry.status));

  const componentName = new Map(components.map((c) => [c.public_id, c.name]));
  const enabledProbes = probes.filter((probe) => probe.enabled === 1).length;

  return (
    <>
      <div className="flex flex-col gap-2">
        <a href="/admin" className="text-xs text-slate-500 underline underline-offset-4 dark:text-slate-400">
          ← All pages
        </a>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{page.name}</h1>
          <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{page.slug}</span>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            version {page.snapshot_version}
          </span>
          <a
            href={`/status/${encodeURIComponent(page.slug)}`}
            className="text-xs underline underline-offset-4"
          >
            Open public page
          </a>
        </div>
      </div>

      <SnapshotPanel
        slug={page.slug}
        overall={overall}
        components={components}
        derived={derived}
        error={
          publicRead.ok
            ? publicRead.data?.snapshot === null
              ? "The public read returned no snapshot."
              : null
            : (publicRead.transportError ?? `api returned ${publicRead.status}`)
        }
      />

      <section className="flex flex-col gap-3" data-testid="page-settings">
        <SectionHeading>Page</SectionHeading>
        <div className="flex flex-wrap items-end gap-4">
          <AdminForm action={renamePageAction} submitLabel="Rename" variant="outline" inline>
            <input type="hidden" name="slug" value={page.slug} />
            <AdminField name="name" label="Display name" defaultValue={page.name} required />
          </AdminForm>
          <AdminForm action={rebuildSnapshotAction} submitLabel="Rebuild snapshot" variant="outline" inline>
            <input type="hidden" name="slug" value={page.slug} />
          </AdminForm>
        </div>
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          The slug is not editable: it identifies the public URL, summary, checkpoints, and feed.
          Saves update the D1 summary immediately server-side. Public hot caches across locations may
          retain the previous summary for up to 30 seconds; this is not a globally simultaneous update.
          KV fallback checkpoints run independently, every 600 seconds when due and within budget.
        </p>
      </section>

      <section className="flex flex-col gap-3" data-testid="sections">
        <SectionHeading>
          Sections <Count n={sections.length} />
        </SectionHeading>
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          A grouping label for components. Deleting one keeps its components and moves them to the
          page root.
        </p>

        <ul className="flex flex-col gap-2">
          {sections.map((section) => (
            <li
              key={section.public_id}
              className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
              data-section={section.public_id}
            >
              <AdminForm action={updateSectionAction} submitLabel="Save" variant="outline" size="sm" inline>
                <input type="hidden" name="sectionPublicId" value={section.public_id} />
                <AdminField name="name" label="Name" defaultValue={section.name} required />
              </AdminForm>
              <AdminForm
                action={deleteSectionAction}
                submitLabel="Delete"
                variant="destructive"
                size="sm"
                confirm={`Delete the section "${section.name}"? Its components move to the page root.`}
                inline
              >
                <input type="hidden" name="sectionPublicId" value={section.public_id} />
              </AdminForm>
            </li>
          ))}
          {sections.length === 0 ? <Empty>No sections.</Empty> : null}
        </ul>

        <AdminForm action={createSectionAction} submitLabel="Add section" inline testId="create-section">
          <input type="hidden" name="slug" value={page.slug} />
          <AdminField name="name" label="Name" placeholder="Core services" required />
          <AdminField name="description" label="Description" placeholder="Optional" />
        </AdminForm>
      </section>

      <section className="flex flex-col gap-3" data-testid="components">
        <SectionHeading>
          Components <Count n={components.length} />
        </SectionHeading>

        <ul className="flex flex-col gap-2">
          {components.map((component) => {
            const entry = derived.get(component.public_id);
            return (
              <li
                key={component.public_id}
                className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
                data-component={component.public_id}
              >
                <AdminForm action={updateComponentAction} submitLabel="Save" variant="outline" size="sm" inline>
                  <input type="hidden" name="componentPublicId" value={component.public_id} />
                  {/* The marker is what lets this form and a rename-only form
                      share one action: without it, a form that did not render the
                      select would look identical to one that chose "page root". */}
                  <input type="hidden" name="sectionEdited" value="1" />
                  <AdminField name="name" label="Name" defaultValue={component.name} required />
                  <div className="flex w-44 flex-col gap-1.5">
                    <label
                      htmlFor={`section-${component.public_id}`}
                      className="text-xs font-medium text-slate-600 dark:text-slate-400"
                    >
                      Section
                    </label>
                    <select
                      id={`section-${component.public_id}`}
                      name="sectionPublicId"
                      defaultValue={component.section_public_id ?? ""}
                      data-field="sectionPublicId"
                      className="h-9 rounded-md border border-slate-300 bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-slate-700 dark:bg-slate-900"
                    >
                      <option value="">(page root)</option>
                      {sections.map((section) => (
                        <option key={section.public_id} value={section.public_id}>
                          {section.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </AdminForm>
                <AdminForm
                  action={deleteComponentAction}
                  submitLabel="Delete"
                  variant="destructive"
                  size="sm"
                  confirm={`Delete the component "${component.name}"? Its probe targets go with it.`}
                  inline
                >
                  <input type="hidden" name="componentPublicId" value={component.public_id} />
                </AdminForm>
                {entry ? (
                  <span className="ml-auto pb-1.5" data-derived={entry.status}>
                    <StatusBadge status={entry.status} label={entry.status} />
                  </span>
                ) : null}
              </li>
            );
          })}
          {components.length === 0 ? <Empty>No components.</Empty> : null}
        </ul>

        <AdminForm action={createComponentAction} submitLabel="Add component" inline testId="create-component">
          <input type="hidden" name="slug" value={page.slug} />
          <AdminField name="name" label="Name" placeholder="API" required />
          <div className="flex w-44 flex-col gap-1.5">
            <label htmlFor="new-component-section" className="text-xs font-medium text-slate-600 dark:text-slate-400">
              Section
            </label>
            <select
              id="new-component-section"
              name="sectionPublicId"
              data-field="sectionPublicId"
              className="h-9 rounded-md border border-slate-300 bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="">(page root)</option>
              {sections.map((section) => (
                <option key={section.public_id} value={section.public_id}>
                  {section.name}
                </option>
              ))}
            </select>
          </div>
        </AdminForm>
      </section>

      <section className="flex flex-col gap-3" data-testid="probes">
        <SectionHeading>
          Probe targets <Count n={probes.length} /> <Count n={enabledProbes} suffix="enabled" />
        </SectionHeading>
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          One enabled target per component, at most. A component with no enabled target derives as{" "}
          <code className="font-mono">unknown</code> — never as operational.
        </p>

        <ul className="flex flex-col gap-2">
          {probes.map((probe) => (
            <li
              key={probe.public_id}
              className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
              data-probe={probe.public_id}
            >
              <div className="flex flex-wrap items-end gap-3">
                <AdminForm action={updateProbeAction} submitLabel="Save" variant="outline" size="sm" inline>
                  <input type="hidden" name="probePublicId" value={probe.public_id} />
                  <div className="flex w-40 flex-col gap-1.5">
                    <label
                      htmlFor={`probe-component-${probe.public_id}`}
                      className="text-xs font-medium text-slate-600 dark:text-slate-400"
                    >
                      Component
                    </label>
                    <span
                      id={`probe-component-${probe.public_id}`}
                      className="h-9 truncate leading-9 text-sm"
                    >
                      {componentName.get(probe.component_public_id) ?? probe.component_public_id}
                    </span>
                  </div>
                  <AdminField name="url" label="URL" type="url" defaultValue={probe.url} required />
                  <AdminField
                    name="intervalSeconds"
                    label="Interval (s)"
                    type="number"
                    width="sm"
                    defaultValue={probe.interval_seconds}
                    hint="min 60"
                  />
                  <label className="flex h-9 items-center gap-2 pb-0.5 text-xs font-medium text-slate-600 dark:text-slate-400">
                    {/* Hidden companion so an unticked box still submits a value;
                        see updateProbeAction for why both are read together. */}
                    <input type="hidden" name="enabled" value="false" />
                    <input
                      type="checkbox"
                      name="enabled"
                      value="on"
                      defaultChecked={probe.enabled === 1}
                      data-field="enabled"
                      className="h-4 w-4 rounded border-slate-300 dark:border-slate-600"
                    />
                    Enabled
                  </label>
                </AdminForm>
                <AdminForm
                  action={deleteProbeAction}
                  submitLabel="Delete"
                  variant="destructive"
                  size="sm"
                  confirm="Delete this probe target? Its state machine row goes with it."
                  inline
                >
                  <input type="hidden" name="probePublicId" value={probe.public_id} />
                </AdminForm>
              </div>

              <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
                {probe.method} · expect {probe.expected_status} · {probe.severity} · timeout{" "}
                {probe.timeout_ms}ms · {probe.failure_threshold} failures to open,{" "}
                {probe.recovery_threshold} successes to close
                {probe.last_probe_at === null ? (
                  <> · never checked</>
                ) : (
                  <>
                    {" "}
                    · last checked <LocalTime epochSeconds={probe.last_probe_at} mode="relative" />
                  </>
                )}
                {probe.open_impact_id === null ? null : <> · impact open</>}
                {probe.consecutive_failures ? (
                  <> · {probe.consecutive_failures} consecutive failures</>
                ) : null}
              </p>
            </li>
          ))}
          {probes.length === 0 ? <Empty>No probe targets. Every component derives as unknown.</Empty> : null}
        </ul>

        <AdminForm action={createProbeAction} submitLabel="Add probe target" inline testId="create-probe">
          <div className="flex w-44 flex-col gap-1.5">
            <label htmlFor="new-probe-component" className="text-xs font-medium text-slate-600 dark:text-slate-400">
              Component
            </label>
            <select
              id="new-probe-component"
              name="componentPublicId"
              required
              data-field="componentPublicId"
              className="h-9 rounded-md border border-slate-300 bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-slate-700 dark:bg-slate-900"
            >
              {components.map((component) => (
                <option key={component.public_id} value={component.public_id}>
                  {component.name}
                </option>
              ))}
            </select>
          </div>
          <AdminField name="url" label="URL" type="url" placeholder="https://api.example.com/health" required />
          <AdminSelect name="method" label="Method" width="sm" options={[{ value: "GET", label: "GET" }, { value: "HEAD", label: "HEAD" }]} />
          <AdminSelect name="severity" label="Severity" defaultValue="partial_outage" options={FAULT_SEVERITIES} />
          <AdminField name="intervalSeconds" label="Interval (s)" type="number" width="sm" defaultValue={60} />
        </AdminForm>
      </section>

      <section className="flex flex-col gap-3" data-testid="changes">
        <SectionHeading>
          Changes <Count n={changes.length} />
        </SectionHeading>

        <ul className="flex flex-col gap-2">
          {changes.map((change) => (
            <li
              key={change.public_id}
              className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
              data-change={change.public_id}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-medium">{change.title}</span>
                <span className="rounded border border-slate-300 px-1.5 py-0.5 text-xs dark:border-slate-700">
                  {change.kind}
                </span>
                <span className="rounded border border-slate-300 px-1.5 py-0.5 text-xs dark:border-slate-700">
                  {change.status}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">{change.severity}</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  <LocalTime epochSeconds={change.starts_at} mode="datetime" />
                </span>
              </div>

              <div className="flex flex-wrap items-end gap-4">
                <AdminForm action={setChangeStatusAction} submitLabel="Set status" variant="outline" size="sm" inline>
                  <input type="hidden" name="changePublicId" value={change.public_id} />
                  <AdminSelect name="status" label="Status" defaultValue={change.status} options={CHANGE_STATUSES} />
                </AdminForm>
              </div>

              <AdminForm action={addChangeUpdateAction} submitLabel="Post update" size="sm" testId="add-update">
                <input type="hidden" name="changePublicId" value={change.public_id} />
                <div className="flex flex-wrap items-end gap-3">
                  <AdminSelect name="status" label="Status" defaultValue={change.status} options={CHANGE_STATUSES} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor={`update-body-${change.public_id}`}
                    className="text-xs font-medium text-slate-600 dark:text-slate-400"
                  >
                    Update
                  </label>
                  <textarea
                    id={`update-body-${change.public_id}`}
                    name="body"
                    rows={2}
                    required
                    maxLength={20_000}
                    data-field="body"
                    className="rounded-md border border-slate-300 bg-transparent p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-slate-700"
                  />
                </div>
                <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
                  Posting an update notifies subscribers. Setting the status here does too, and does
                  not add an entry to the public timeline — use an update for anything a reader
                  should see.
                </p>
              </AdminForm>
            </li>
          ))}
          {changes.length === 0 ? <Empty>No changes.</Empty> : null}
        </ul>

        <AdminForm action={createChangeAction} submitLabel="Open a change" testId="create-change">
          <input type="hidden" name="slug" value={page.slug} />
          <div className="flex flex-wrap items-end gap-3">
            <AdminSelect
              name="kind"
              label="Kind"
              width="sm"
              options={[
                { value: "incident", label: "incident" },
                { value: "maintenance", label: "maintenance" },
              ]}
            />
            <AdminSelect name="severity" label="Severity" defaultValue="full_outage" options={FAULT_SEVERITIES} />
            <DateTimeField name="startsAt" label="Starts" hint="Blank means now." />
          </div>
          <AdminField name="title" label="Title" placeholder="Elevated error rate on the API" required />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="change-body" className="text-xs font-medium text-slate-600 dark:text-slate-400">
              First message
            </label>
            <textarea
              id="change-body"
              name="body"
              rows={3}
              maxLength={20_000}
              data-field="body"
              className="rounded-md border border-slate-300 bg-transparent p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-slate-700"
            />
          </div>
          {components.length > 0 ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-xs font-medium text-slate-600 dark:text-slate-400">
                Affected components
              </legend>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                None selected means the change is page-wide and contributes no component status.
              </p>
              <div className="flex flex-wrap gap-3">
                {components.map((component) => (
                  <label key={component.public_id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="componentPublicIds"
                      value={component.public_id}
                      className="h-4 w-4 rounded border-slate-300 dark:border-slate-600"
                    />
                    {component.name}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
            An incident notifies subscribers on creation; a scheduled maintenance does not, because
            announcing a window ahead of time is not news yet.
          </p>
        </AdminForm>
      </section>

      <section className="flex flex-col gap-3" data-testid="impacts">
        <SectionHeading>
          Manual impacts <Count n={impacts.length} />
        </SectionHeading>
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          Hand-recorded downtime, for an outage observed outside the probes. These are treated as
          direct evidence by the uptime maths, so they count whether or not a probe covers the
          component. Probe-generated impacts are not listed here: they are owned by the state
          machine, which would reopen one the moment a probe failed again.
        </p>

        <ul className="flex flex-col gap-2">
          {impacts.map((impact) => (
            <li
              key={impact.public_id}
              className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
              data-impact={impact.public_id}
            >
              <div className="flex min-w-48 flex-1 flex-col gap-1">
                <span className="text-sm font-medium">
                  {componentName.get(impact.component_public_id) ?? impact.component_public_id}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {impact.severity} · <LocalTime epochSeconds={impact.start_at} mode="datetime" />
                  {impact.end_at === null ? (
                    <> · <span className="font-medium text-amber-700 dark:text-amber-400">open</span></>
                  ) : (
                    <>
                      {" "}
                      → <LocalTime epochSeconds={impact.end_at} mode="datetime" />
                    </>
                  )}
                </span>
              </div>
              {impact.end_at === null ? (
                <AdminForm action={closeManualImpactAction} submitLabel="Close now" variant="outline" size="sm" inline>
                  <input type="hidden" name="impactPublicId" value={impact.public_id} />
                </AdminForm>
              ) : null}
            </li>
          ))}
          {impacts.length === 0 ? <Empty>No hand-entered impacts.</Empty> : null}
        </ul>

        <AdminForm action={createManualImpactAction} submitLabel="Record an impact" inline testId="create-impact">
          <input type="hidden" name="slug" value={page.slug} />
          <div className="flex w-44 flex-col gap-1.5">
            <label htmlFor="new-impact-component" className="text-xs font-medium text-slate-600 dark:text-slate-400">
              Component
            </label>
            <select
              id="new-impact-component"
              name="componentPublicId"
              required
              data-field="componentPublicId"
              className="h-9 rounded-md border border-slate-300 bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-slate-700 dark:bg-slate-900"
            >
              {components.map((component) => (
                <option key={component.public_id} value={component.public_id}>
                  {component.name}
                </option>
              ))}
            </select>
          </div>
          <AdminSelect name="severity" label="Severity" defaultValue="full_outage" options={FAULT_SEVERITIES} />
          <DateTimeField name="startAt" label="Started" required />
          <DateTimeField name="endAt" label="Ended" hint="Blank leaves it open." />
        </AdminForm>
      </section>
    </>
  );
}

/**
 * What a visitor sees right now.
 *
 * Reads the public endpoint rather than deriving from `detail`, because the two
 * can legitimately disagree: the snapshot is a cache, and this panel is the point
 * at which an operator finds out it is stale.
 */
function SnapshotPanel({
  slug,
  overall,
  components,
  derived,
  error,
}: {
  slug: string;
  overall: Status | null;
  components: Array<{ public_id: string; name: string }>;
  derived: Map<string, { status: Status; reason: string }>;
  error: string | null;
}) {
  if (error !== null) {
    return (
      <section
        className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950"
        data-testid="snapshot-panel"
        data-state="error"
      >
        <SectionHeading>What visitors see</SectionHeading>
        <p className="text-sm leading-6 text-amber-900 dark:text-amber-200">
          The public read for <span className="font-mono">{slug}</span> failed: {error}
        </p>
      </section>
    );
  }

  const tone = overall === null ? null : statusTone(overall);

  return (
    <section className="flex flex-col gap-3" data-testid="snapshot-panel" data-state="ok">
      <SectionHeading>What visitors see</SectionHeading>
      {tone !== null && overall !== null ? (
        <div className={cn("flex w-fit items-center gap-2 rounded-md border px-3 py-1.5", tone.badge)}>
          <span className={cn("h-2 w-2 rounded-full", tone.dot)} aria-hidden />
          <span className="text-sm font-medium">{overall}</span>
        </div>
      ) : null}
      <ul className="flex flex-wrap gap-2">
        {components.map((component) => {
          const entry = derived.get(component.public_id);
          return (
            <li key={component.public_id} className="flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1 dark:border-slate-800">
              <span className="text-xs">{component.name}</span>
              {entry ? (
                <span data-derived={entry.status}>
                  <StatusBadge status={entry.status} label={entry.status} />
                </span>
              ) : (
                <span className="text-xs text-slate-500 dark:text-slate-400">not in snapshot</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
        Derived at read time from active impacts and probe evidence, not stored. A component absent
        from this summary may reflect cached or fallback data, not a component that is fine.
        {[...derived.values()].some((entry) => isFaultSeverity(entry.status))
          ? " At least one component is in a fault state."
          : ""}
      </p>
    </section>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
      {children}
    </h2>
  );
}

function Count({ n, suffix }: { n: number; suffix?: string }) {
  return (
    <span className="rounded bg-slate-200 px-1.5 py-0.5 text-xs font-medium normal-case tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-300">
      {n}
      {suffix ? ` ${suffix}` : ""}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <li className="text-sm text-slate-500 dark:text-slate-400">{children}</li>;
}
