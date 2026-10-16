"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { INITIAL_ADMIN_STATE, type AdminFormState } from "@/lib/admin-form-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The one form component the console uses for every write.
 *
 * ## Why a shared wrapper rather than a form per write
 *
 * Every write in the console has the same three states — untouched, refused,
 * accepted — and the same two things to do about them: show which input was
 * wrong, and re-enable the button. Writing that out eighteen times would be
 * eighteen chances for one form to forget the `pending` guard and submit twice,
 * or to render a stale error after a successful retry.
 *
 * ## Why `children` rather than a field schema
 *
 * The fields are Server Components' markup passed through as `children`. That
 * keeps the client bundle small (no field renderer, no catalogue of input types)
 * and, more importantly, keeps the field list next to the labels that describe
 * it. The cost is that this component cannot know a field's name, which is why
 * `field` from the API is matched against `data-field` attributes in the
 * children rather than against a list held here.
 *
 * ## Why the form resets itself
 *
 * `state.outcome === "ok"` means the server accepted the input and the page is
 * about to re-render with the new state. Leaving the old values in the inputs
 * would leave "new section: Foo" sitting in a box under a list that now contains
 * Foo, and a second click would create it again.
 */
export function AdminForm({
  action,
  submitLabel,
  children,
  confirm,
  className,
  variant = "default",
  size = "default",
  testId,
  inline = false,
}: {
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  submitLabel: string;
  children?: React.ReactNode;
  /**
   * Shown as a `window.confirm` before the write. Used by deletes, where there is
   * no undo — the API has no soft-delete, so a removed component is gone.
   */
  confirm?: string;
  className?: string;
  variant?: "default" | "outline" | "ghost" | "destructive";
  size?: "default" | "sm" | "icon";
  testId?: string;
  /** Lays the fields and the button out on one row, for the small inline forms. */
  inline?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_ADMIN_STATE);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.outcome === "ok") formRef.current?.reset();
  }, [state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className={cn("flex flex-col gap-3", inline && "flex-row flex-wrap items-end", className)}
      data-testid={testId}
    >
      {children}

      <div className={cn("flex items-center gap-3", inline && "pb-0.5")}>
        <Button
          type="submit"
          variant={variant}
          size={size}
          disabled={pending}
          {...(confirm === undefined
            ? {}
            : {
                onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
                  if (!window.confirm(confirm)) event.preventDefault();
                },
              })}
        >
          {pending ? "…" : submitLabel}
        </Button>
        <AdminFormMessage state={state} />
      </div>
    </form>
  );
}

/**
 * The message under a form.
 *
 * `field` is not rendered here. It is read by the caller's own markup through
 * `data-field`, which is the only place that knows which input a given name
 * belongs to; this component only reports what happened.
 */
export function AdminFormMessage({ state }: { state: AdminFormState }) {
  if (state.outcome === "idle") return null;

  if (state.outcome === "ok") {
    return (
      <p className="text-xs text-emerald-700 dark:text-emerald-400" role="status" data-outcome="ok">
        Saved.
      </p>
    );
  }

  return (
    <p className="text-xs text-red-700 dark:text-red-400" role="alert" data-outcome="error">
      {state.error}
      {state.field ? <span className="opacity-70"> ({state.field})</span> : null}
    </p>
  );
}

/**
 * A labelled text input, so the eighteen forms do not each re-invent the same
 * six class names. Kept in this file rather than its own because it is only ever
 * used inside an `AdminForm`.
 *
 * ## Why the id comes from `useId`
 *
 * A first version derived the id from the field name and label. That looks
 * unique and is not: the console renders a "Name" input once per section, once
 * per component, and again in each create form, so seven elements shared the id
 * `admin-name-name`. `label[for]` resolves to the *first* element with that id,
 * so every one of those labels focused the first input on the page — invisible
 * in a screenshot, and obvious the moment anyone clicks a label. `useId` is the
 * framework's own answer to exactly this, and it survives SSR.
 */
export function AdminField({
  name,
  label,
  defaultValue,
  placeholder,
  type = "text",
  required = false,
  maxLength,
  hint,
  width = "full",
  autoComplete,
}: {
  name: string;
  label: string;
  defaultValue?: string | number;
  placeholder?: string;
  type?: "text" | "url" | "number" | "email" | "password";
  required?: boolean;
  maxLength?: number;
  hint?: string;
  width?: "full" | "sm";
  autoComplete?: string;
}) {
  const id = useId();

  return (
    <div className={cn("flex flex-col gap-1.5", width === "sm" ? "w-28" : "flex-1 min-w-48")}>
      <label htmlFor={id} className="text-xs font-medium text-slate-600 dark:text-slate-400">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete={autoComplete}
        data-field={name}
        className="h-9 rounded-md border border-slate-300 bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-slate-700"
      />
      {hint ? <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function AdminSelect({
  name,
  label,
  options,
  defaultValue,
  width = "full",
}: {
  name: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  defaultValue?: string;
  width?: "full" | "sm";
}) {
  // `useId` for the same reason as `AdminField`: a page renders several selects
  // whose label is "Severity" or "Status", and a derived id would collide.
  const id = useId();

  return (
    <div className={cn("flex flex-col gap-1.5", width === "sm" ? "w-40" : "flex-1 min-w-48")}>
      <label htmlFor={id} className="text-xs font-medium text-slate-600 dark:text-slate-400">
        {label}
      </label>
      <select
        id={id}
        name={name}
        defaultValue={defaultValue}
        data-field={name}
        className="h-9 rounded-md border border-slate-300 bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-slate-700 dark:bg-slate-900"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
