import type { Metadata } from "next";

import { AdminForm, AdminField } from "@/components/admin/admin-form";
import { adminToken, readAdminSession, SESSION_TTL_SECONDS } from "@/lib/admin-session";
import { loginAction, logoutAction } from "./actions";

/**
 * The console's shell, and the one place the sign-in gate is applied.
 *
 * ## Why the gate is in the layout
 *
 * Every route under `/admin` has to be behind the same check, and a layout is
 * the only place that is structurally true: a new page added under this
 * directory is gated by existing, rather than by remembering. The actions
 * re-check independently — see `actions.ts` — because a layout decides what is
 * rendered, and rendering is not authorisation.
 *
 * ## Why the console is not localised
 *
 * The status page ships zh-CN and en-US because it has visitors. This console has
 * operators, who are the same one or two people who read the API's error codes,
 * and doubling every string here would buy nothing. `docs/spec/admin-ui.md`
 * records that as a boundary rather than leaving it to look like an oversight.
 *
 * The console also has no locale switch and no theme toggle of its own: it
 * inherits both from the root layout, so an operator who has set dark mode for
 * the status page gets dark mode here too.
 */

export const metadata: Metadata = {
  title: "allclear console",
  // A console has no business in an index. `noindex` rather than a robots.txt
  // rule because it travels with the page, including on a preview deployment
  // whose hostname nobody remembered to exclude.
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await readAdminSession();

  if (session === null) return <SignIn />;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-50">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
          <a href="/admin" className="text-sm font-semibold tracking-tight">
            allclear console
          </a>
          <a
            href="/"
            className="text-xs text-slate-600 underline underline-offset-4 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            Public site
          </a>
          <div className="ml-auto flex items-center gap-4">
            {/* The expiry is shown because the session is a fixed 12 hours with
                no renewal: an operator who is about to start a maintenance
                window should be able to see whether they will still be signed
                in when it ends. */}
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Session ends {new Date(session.expiresAt * 1000).toLocaleString()}
            </span>
            <form action={logoutAction}>
              <button
                type="submit"
                className="text-xs text-slate-600 underline underline-offset-4 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                data-testid="admin-logout"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-8">{children}</main>
    </div>
  );
}

/**
 * The sign-in screen, which is also the "not configured" screen.
 *
 * These are deliberately different: an unconfigured deployment must not present
 * a token box, because a box implies there is a value that would work. The
 * message says what to set instead, and it says it in terms of the binding
 * rather than the environment, because that is where the value actually lives.
 */
async function SignIn() {
  if (adminToken() === null) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-3 px-6 py-24" data-testid="admin-unconfigured">
        <h1 className="text-lg font-semibold tracking-tight">Console not configured</h1>
        <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">
          This deployment has no <code className="font-mono text-xs">ADMIN_TOKEN</code> set, so the
          console refuses every request rather than opening. Set the secret and reload.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-6 py-24">
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold tracking-tight">allclear console</h1>
        <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">
          The console writes through this Worker's own API credential. Enter the operator token to
          start a {SESSION_TTL_SECONDS / 3600}-hour session.
        </p>
      </div>

      <AdminForm action={loginAction} submitLabel="Sign in" testId="admin-login">
        <AdminField
          name="token"
          label="Operator token"
          type="password"
          autoComplete="current-password"
          required
        />
      </AdminForm>
    </div>
  );
}
