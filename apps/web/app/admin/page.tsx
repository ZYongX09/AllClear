import { MAX_ENABLED_TARGETS } from "@allclear/shared";

import { AdminField, AdminForm } from "@/components/admin/admin-form";
import { LocalTime } from "@/components/local-time";
import { listPages, readEmailQuota } from "@/lib/admin-api";
import { createPageAction, rebuildSnapshotAction } from "./actions";

/**
 * The console index: every page, its size, and the two budgets that stop working
 * silently.
 *
 * ## What this page is for
 *
 * Choosing a page to edit, and noticing the two things that fail without
 * announcing themselves: the enabled-probe cap and the daily send budget. Both
 * are hard stops — a 21st enabled target is simply never scheduled, and a send
 * past the quota is simply not sent — and in both cases the public page carries
 * on looking healthy. A number on a screen an operator already visits is the
 * cheapest place to catch that.
 *
 * ## Why the counts come from the API rather than from this page
 *
 * The page list arrives as one query with subqueries; see the route's own note.
 * Counting here would mean fetching every component and probe of every page to
 * render a table of integers.
 */

export const dynamic = "force-dynamic";

export default async function AdminIndex() {
  const [pagesResult, quotaResult] = await Promise.all([listPages(), readEmailQuota()]);

  if (!pagesResult.ok || pagesResult.data === null) {
    return (
      <Unavailable
        what="the page list"
        error={pagesResult.transportError ?? `api returned ${pagesResult.status}`}
      />
    );
  }

  const pages = pagesResult.data.pages;
  const enabledProbes = pages.reduce((total, page) => total + page.enabled_probe_count, 0);
  const quota = quotaResult.ok ? quotaResult.data : null;

  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Status pages</h1>
        <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">
          Edits here publish immediately: a write rebuilds the page's snapshot and writes it to KV.
        </p>
      </div>

      <section className="flex flex-col gap-3" data-testid="budgets">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          Budgets
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Budget
            label="Enabled probe targets"
            used={enabledProbes}
            limit={MAX_ENABLED_TARGETS}
            note={
              enabledProbes >= MAX_ENABLED_TARGETS
                ? "At the cap. A further enabled target will never be scheduled."
                : "Targets beyond the cap are not scheduled, and are not reported as unhealthy."
            }
            testId="probe-budget"
          />
          {quota === null ? (
            <Budget label="Notification sends today" used={null} limit={null} note="Could not read the send budget." testId="quota-budget" />
          ) : (
            <Budget
              label={`Notification sends (${quota.day}, UTC)`}
              used={quota.sent}
              limit={quota.limit}
              note={
                quota.remaining === 0
                  ? "Exhausted. Notifications are being skipped for the rest of the UTC day."
                  : `${quota.remaining} left before notifications are skipped for the rest of the UTC day.`
              }
              testId="quota-budget"
            />
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          Pages
        </h2>

        {pages.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="pages-empty">
            No pages yet. Create one below.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full text-left text-sm" data-testid="pages-table">
              <thead className="border-b border-slate-200 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Slug</th>
                  <th className="px-4 py-2 text-right font-medium">Sections</th>
                  <th className="px-4 py-2 text-right font-medium">Components</th>
                  <th className="px-4 py-2 text-right font-medium">Probes</th>
                  <th className="px-4 py-2 text-right font-medium">Open</th>
                  <th className="px-4 py-2 text-right font-medium">Version</th>
                  <th className="px-4 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {pages.map((page) => (
                  <tr
                    key={page.public_id}
                    className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                    data-page={page.slug}
                  >
                    <td className="px-4 py-2">
                      <a
                        href={`/admin/pages/${encodeURIComponent(page.slug)}`}
                        className="font-medium underline underline-offset-4"
                      >
                        {page.name}
                      </a>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                      {page.slug}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{page.section_count}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{page.component_count}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{page.enabled_probe_count}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{page.open_change_count}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{page.snapshot_version}</td>
                    <td className="px-4 py-2 text-xs text-slate-500 dark:text-slate-400">
                      <LocalTime epochSeconds={page.updated_at} mode="relative" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3" data-testid="create-page">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          New page
        </h2>
        <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">
          The slug becomes the public URL and the KV key, and it cannot be changed afterwards.
        </p>
        <AdminForm action={createPageAction} submitLabel="Create page" inline testId="create-page-form">
          <AdminField name="slug" label="Slug" placeholder="acme-status" required width="sm" />
          <AdminField name="name" label="Name" placeholder="Acme" required />
        </AdminForm>
      </section>

      {pages.length > 0 ? (
        <section className="flex flex-col gap-3" data-testid="rebuild">
          <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            Rebuild a snapshot
          </h2>
          <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">
            Writes are meant to rebuild on their own. This is for the case where they did not — a
            write that failed after committing, or a KV entry edited outside the console. It bumps
            the version, so it is visible to readers.
          </p>
          <AdminForm action={rebuildSnapshotAction} submitLabel="Rebuild" variant="outline" inline testId="rebuild-form">
            <div className="flex min-w-48 flex-1 flex-col gap-1.5">
              <label
                htmlFor="rebuild-slug"
                className="text-xs font-medium text-slate-600 dark:text-slate-400"
              >
                Page
              </label>
              <select
                id="rebuild-slug"
                name="slug"
                data-field="slug"
                className="h-9 rounded-md border border-slate-300 bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-slate-700 dark:bg-slate-900"
              >
                {pages.map((page) => (
                  <option key={page.public_id} value={page.slug}>
                    {page.name} ({page.slug})
                  </option>
                ))}
              </select>
            </div>
          </AdminForm>
        </section>
      ) : null}
    </>
  );
}

/**
 * One budget, as a number over a limit.
 *
 * `used: null` means the number could not be read, which is deliberately not
 * rendered as zero: "no notifications have been sent" and "we cannot tell how
 * many have been sent" call for different reactions, and the second one is the
 * one an operator should act on.
 */
function Budget({
  label,
  used,
  limit,
  note,
  testId,
}: {
  label: string;
  used: number | null;
  limit: number | null;
  note: string;
  testId: string;
}) {
  const exhausted = used !== null && limit !== null && used >= limit;

  return (
    <div
      className={
        exhausted
          ? "flex flex-col gap-1 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950"
          : "flex flex-col gap-1 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
      }
      data-testid={testId}
      data-exhausted={exhausted ? "true" : "false"}
    >
      <span className="text-xs font-medium text-slate-600 dark:text-slate-400">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">
        {used === null ? "—" : used}
        {limit === null ? null : (
          <span className="text-sm font-normal text-slate-500 dark:text-slate-400"> / {limit}</span>
        )}
      </span>
      <span className="text-xs leading-5 text-slate-600 dark:text-slate-400">{note}</span>
    </div>
  );
}

function Unavailable({ what, error }: { what: string; error: string }) {
  return (
    <div className="flex flex-col gap-3" data-testid="admin-unavailable">
      <h1 className="text-xl font-semibold tracking-tight">Could not read {what}</h1>
      <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">
        The console talks to the API over a Service Binding. This request did not complete, so
        nothing here is known — including whether the deployment is healthy.
      </p>
      <pre className="overflow-x-auto rounded-md border border-slate-200 bg-white p-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        {error}
      </pre>
    </div>
  );
}
