"use client";

import { useActionState } from "react";
import { echoAction, rebuildAction, type ActionResult } from "../../actions";

function Result({ state }: { state: ActionResult | null }) {
  if (state === null) return null;
  return (
    <pre className="mt-3 overflow-x-auto rounded bg-slate-900 px-3 py-2 text-xs leading-5 text-slate-100">
      {JSON.stringify(state, null, 2)}
    </pre>
  );
}

export function ActionPanel({ slug }: { slug: string }) {
  const [echoState, echoDispatch, echoPending] = useActionState<ActionResult | null, FormData>(
    echoAction,
    null,
  );
  const [rebuildState, rebuildDispatch, rebuildPending] = useActionState<
    ActionResult | null,
    FormData
  >(rebuildAction, null);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <form action={echoDispatch} className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="font-semibold">Service Binding round trip</h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Calls <code>GET /internal/echo</code> on the API Worker with{" "}
          <code>X-Internal-Key</code>. A 200 here means the Service Binding works{" "}
          <em>and</em> the shared key the web Worker holds matches the API Worker&apos;s.
        </p>
        <button
          className="mt-4 rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
          disabled={echoPending}
          type="submit"
        >
          {echoPending ? "Calling…" : "Call API Worker"}
        </button>
        <Result state={echoState} />
      </form>

      <form action={rebuildDispatch} className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="font-semibold">Rebuild snapshot</h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Calls <code>POST /internal/snapshot/{slug}/rebuild</code>. This is the write
          path that maintains both <code>snapshot:{slug}</code> and{" "}
          <code>snapshot:{slug}:last</code>, which the fallback below depends on.
        </p>
        <input name="slug" type="hidden" value={slug} />
        <button
          className="mt-4 rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
          disabled={rebuildPending}
          type="submit"
        >
          {rebuildPending ? "Rebuilding…" : "Rebuild"}
        </button>
        <Result state={rebuildState} />
      </form>
    </div>
  );
}
