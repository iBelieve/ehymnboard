import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createFirstAccount, fetchSetupNeeded } from "./api";
import { signIn } from "./auth";

/** The church picture behind every page. */
export function Background() {
  return (
    <div
      className="fixed inset-0 bg-cover opacity-20 brightness-75 grayscale-[0.7]"
      style={{ backgroundImage: "url('/church-lent.jpg')" }}
    />
  );
}

/** A form that shows its submit's error, and disables itself while it runs. */
export function ActionForm({
  onSubmit,
  submit,
  children,
  className = "",
}: {
  onSubmit: () => Promise<void>;
  submit: string;
  children: ReactNode;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function handle(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`flex flex-col gap-3 ${className}`} onSubmit={(e) => void handle(e)}>
      {children}
      {error && <div className="text-error text-sm">{error}</div>}
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {submit}
      </button>
    </form>
  );
}

/** A labelled input; `value` and `onChange` as for any controlled input. */
export function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "password";
  autoComplete?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm">{label}</span>
      <input
        className="input w-full"
        type={type}
        value={value}
        required
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/**
 * Signing in with an email and password, or, until the first account
 * exists, creating it.
 */
export function SignIn() {
  const [setupNeeded, setSetupNeeded] = useState<boolean>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    fetchSetupNeeded().then(setSetupNeeded, (e: unknown) => setLoadError(String(e)));
  }, []);

  return (
    <div className="flex min-h-dvh items-center justify-center p-8">
      <Background />
      <div className="z-10 w-full max-w-sm">
        <h1 className="font-display mb-8 text-center text-5xl tracking-wide text-white">
          Hymn Board
        </h1>
        <div className="rounded-2xl bg-white p-6 shadow-lg">
          {loadError && <div className="text-error text-sm">{loadError}</div>}
          {setupNeeded === false && <SignInForm />}
          {setupNeeded === true && <SetupForm />}
        </div>
      </div>
    </div>
  );
}

function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <ActionForm submit="Sign in" onSubmit={() => signIn(email, password)}>
      <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
      <Field
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />
    </ActionForm>
  );
}

function SetupForm() {
  const [setupPassword, setSetupPassword] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <ActionForm
      submit="Create account"
      onSubmit={async () => {
        await createFirstAccount({ setupPassword, name, email, password });
        await signIn(email, password);
      }}
    >
      <p className="text-sm">
        There are no accounts yet. Create the first one, an admin, with the server&apos;s setup
        password (its <code>SETUP_PASSWORD</code>).
      </p>
      <Field
        label="Setup password"
        type="password"
        value={setupPassword}
        onChange={setSetupPassword}
        autoComplete="off"
      />
      <Field label="Your name" value={name} onChange={setName} autoComplete="name" />
      <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
      <Field
        label="New password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
      />
    </ActionForm>
  );
}
