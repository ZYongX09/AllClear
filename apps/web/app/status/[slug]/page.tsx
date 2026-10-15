import { env } from "cloudflare:workers";
import { getStatus, type ReadResult } from "@/lib/allclear-api";
import { ActionPanel } from "./action-panel";

/**
 * M0 capability report.
 *
 * This is a technical spike, not the status page — the real one lands in M4.
 * Its job is to make each M0 claim checkable from a browser on a real
 * deployment, so it prints the raw evidence (which step of the read chain
 * answered, what each binding returned, what the internal API replied) instead
 * of dressing it up. It reads bindings directly rather than only through the
 * API Worker, because "the page can read D1 and KV" and "the page can reach the
 * API Worker" are separate capabilities that could fail independently.
 */

export default async function StatusPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const [status, kvFresh, kvLast, d1] = await Promise.all([
    getStatus(env.API, slug),
    readKv(env.SNAPSHOT_KV, `snapshot:${slug}`),
    readKv(env.SNAPSHOT_KV, `snapshot:${slug}:last`),
    readD1(env.DB, slug),
  ]);

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <section className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-3">
          <p className="text-sm font-semibold uppercase tracking-wide text-orange-600">
            allclear · M0 capability report
          </p>
          <h1 className="text-3xl font-semibold leading-tight sm:text-4xl">{slug}</h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-600">
            Rendered by the <code>allclear-web</code> Worker on every request. The snapshot
            below arrives over a Service Binding from <code>allclear-api</code>, which has no
            public route of its own. The KV and D1 rows are read by this Worker directly.
          </p>
        </header>

        <Panel title="Snapshot (via Service Binding → allclear-api)">
          {status.ok ? (
            <ReadResultView status={status.status} result={status.data} />
          ) : (
            <Failure label="Service Binding call did not complete" detail={status.error} />
          )}
        </Panel>

        <Panel title="Direct KV reads (this Worker's SNAPSHOT_KV binding)">
          <table className="w-full text-left text-sm">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 font-medium">key</th>
                <th className="py-1 font-medium">present</th>
                <th className="py-1 font-medium">snapshotVersion</th>
                <th className="py-1 font-medium">generatedAt</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              <KvRow label={`snapshot:${slug}`} value={kvFresh} />
              <KvRow label={`snapshot:${slug}:last`} value={kvLast} />
            </tbody>
          </table>
          <p className="mt-3 text-xs leading-5 text-slate-500">
            The <code>:last</code> key is written by the same call that writes the fresh key.
            It is what the read chain falls back to when D1 is unavailable, so the fallback
            has a write contract behind it rather than an assumption.
          </p>
        </Panel>

        <Panel title="Direct D1 read (this Worker's DB binding)">
          {d1.ok ? (
            d1.found ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm sm:grid-cols-3">
                <Field label="page.snapshot_version" value={d1.snapshotVersion} />
                <Field label="page.updated_at" value={d1.updatedAt} />
                <Field label="components" value={d1.componentCount} />
              </dl>
            ) : (
              <p className="text-sm text-slate-600">
                D1 is reachable but has no page with this slug.
              </p>
            )
          ) : (
            <Failure label="D1 read failed" detail={d1.error} />
          )}
        </Panel>

        <Panel title="Server Actions → internal API">
          <ActionPanel slug={slug} />
        </Panel>

        <footer className="border-t border-slate-200 pt-4 text-xs leading-5 text-slate-500">
          The status page itself, the prober, and the uptime maths are not in M0. A component
          that has never been probed is reported as <code>unknown</code>, never as{" "}
          <code>operational</code> — absence of evidence is not evidence of uptime.
        </footer>
      </section>
    </main>
  );
}

const STATUS_STYLES: Record<string, string> = {
  operational: "bg-emerald-100 text-emerald-800",
  degraded_performance: "bg-amber-100 text-amber-900",
  partial_outage: "bg-orange-100 text-orange-900",
  full_outage: "bg-red-100 text-red-900",
  maintenance: "bg-sky-100 text-sky-900",
  unknown: "bg-slate-200 text-slate-700",
};

function ReadResultView({ status, result }: { status: number; result: ReadResult }) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm sm:grid-cols-4">
        <Field label="HTTP" value={status} />
        <Field label="source" value={result.source} />
        <Field label="stale" value={String(result.stale)} />
        <Field label="snapshotVersion" value={result.snapshot?.snapshotVersion ?? "—"} />
      </dl>

      {result.errors.length > 0 && (
        <Failure label="Non-fatal errors while walking the read chain" detail={result.errors.join(" · ")} />
      )}

      {result.snapshot === null ? (
        <p className="text-sm text-slate-600">
          Nothing to serve. The page reports that plainly rather than rendering an empty
          list that looks like &ldquo;all clear&rdquo;.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {result.snapshot.components.map((component) => (
            <li
              className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-2"
              key={component.publicId}
            >
              <span className="text-sm font-medium">{component.name}</span>
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${
                  STATUS_STYLES[component.status] ?? "bg-slate-200 text-slate-700"
                }`}
              >
                {component.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KvRow({
  label,
  value,
}: {
  label: string;
  value: KvRead;
}) {
  return (
    <tr className="border-t border-slate-100">
      <td className="py-1 pr-3 break-all">{label}</td>
      <td className="py-1 pr-3">{value.present ? "yes" : "no"}</td>
      <td className="py-1 pr-3">{value.snapshotVersion ?? "—"}</td>
      <td className="py-1">{value.error ? `error: ${value.error}` : (value.generatedAt ?? "—")}</td>
    </tr>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-slate-50 p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="break-all">{value}</dd>
    </div>
  );
}

function Failure({ label, detail }: { label: string; detail: string }) {
  return (
    <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
      <strong className="font-medium">{label}:</strong> {detail}
    </p>
  );
}

interface KvRead {
  present: boolean;
  snapshotVersion?: number;
  generatedAt?: number;
  error?: string;
}

async function readKv(kv: KVNamespace, key: string): Promise<KvRead> {
  try {
    const raw = await kv.get(key);
    if (raw === null) return { present: false };
    const parsed = JSON.parse(raw) as { snapshotVersion?: number; generatedAt?: number };
    return { present: true, snapshotVersion: parsed.snapshotVersion, generatedAt: parsed.generatedAt };
  } catch (error) {
    return { present: false, error: message(error) };
  }
}

type D1Read =
  | { ok: true; found: false }
  | { ok: true; found: true; snapshotVersion: number; updatedAt: number; componentCount: number }
  | { ok: false; error: string };

async function readD1(db: D1Database, slug: string): Promise<D1Read> {
  try {
    const page = await db
      .prepare("SELECT id, snapshot_version, updated_at FROM page WHERE slug = ?1")
      .bind(slug)
      .first<{ id: number; snapshot_version: number; updated_at: number }>();
    if (!page) return { ok: true, found: false };

    const { results } = await db
      .prepare("SELECT COUNT(*) AS count FROM component WHERE page_id = ?1")
      .bind(page.id)
      .all<{ count: number }>();

    return {
      ok: true,
      found: true,
      snapshotVersion: page.snapshot_version,
      updatedAt: page.updated_at,
      componentCount: results[0]?.count ?? 0,
    };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
