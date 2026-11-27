import { useState, type ReactNode } from "react";
import { Background } from "./SignIn";

/** A page of settings: its title, a link back to the board, and sections. */
export function SettingsPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh justify-center p-8">
      <Background />
      <div className="z-10 flex w-full max-w-2xl flex-col gap-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="font-display text-5xl tracking-wide text-white">{title}</h1>
          <a className="btn btn-ghost text-white" href="#">
            Back to the hymn board
          </a>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl bg-white p-6 shadow-lg">
      <h2 className="mb-4 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** A button that asks once more before it does anything. */
export function ConfirmButton({
  label,
  onConfirm,
}: {
  label: string;
  onConfirm: () => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string>();
  if (!asking) {
    return (
      <button
        className="btn btn-sm btn-soft btn-error"
        type="button"
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      {error && <span className="text-error text-sm">{error}</span>}
      <button
        className="btn btn-sm btn-error"
        type="button"
        onClick={() => void onConfirm().catch((e: unknown) => setError(String(e)))}
      >
        Yes, {label.toLowerCase()}
      </button>
      <button className="btn btn-sm btn-ghost" type="button" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}
