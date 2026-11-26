import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Viewer } from "../shared/api";
import {
  addAccount,
  changePassword,
  createApiKey,
  deleteApiKey,
  listAccounts,
  listApiKeys,
  removeAccount,
  setAccountPassword,
  type Account,
  type ApiKey,
  type Role,
} from "./auth";
import { prettyDate } from "./prettyDate";
import { ActionForm, Background, Field } from "./SignIn";

/** Your password; for admins, everyone's accounts and the API keys too. */
export function AccountsPage({ viewer }: { viewer: Viewer }) {
  return (
    <div className="flex min-h-dvh justify-center p-8">
      <Background />
      <div className="z-10 flex w-full max-w-2xl flex-col gap-8">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-5xl tracking-wide text-white">Accounts</h1>
          <a className="btn btn-ghost text-white" href="#">
            Back to the hymn board
          </a>
        </div>
        <Section title="Your password">
          <ChangePassword />
        </Section>
        {viewer.role === "admin" && <AdminSections viewer={viewer} />}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl bg-white p-6 shadow-lg">
      <h2 className="mb-4 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [done, setDone] = useState(false);
  return (
    <ActionForm
      submit="Change password"
      onSubmit={async () => {
        setDone(false);
        await changePassword(current, next);
        setCurrent("");
        setNext("");
        setDone(true);
      }}
    >
      <Field
        label="Current password"
        type="password"
        value={current}
        onChange={setCurrent}
        autoComplete="current-password"
      />
      <Field
        label="New password"
        type="password"
        value={next}
        onChange={setNext}
        autoComplete="new-password"
      />
      {done && (
        <div className="text-success text-sm">Password changed. Other devices are signed out.</div>
      )}
    </ActionForm>
  );
}

/** Loads a list, and reloads it after each change. */
function useList<T>(load: () => Promise<T[]>) {
  const [items, setItems] = useState<T[]>();
  const [error, setError] = useState<string>();
  const reload = useCallback(
    () =>
      load().then(
        (next) => {
          setItems(next);
          setError(undefined);
        },
        (e: unknown) => setError(String(e)),
      ),
    [load],
  );
  useEffect(() => void reload(), [reload]);
  return { items, error, reload };
}

function AdminSections({ viewer }: { viewer: Viewer }) {
  const accounts = useList(listAccounts);
  const keys = useList(listApiKeys);
  return (
    <>
      <Section title="Everyone's accounts">
        {accounts.error && <div className="text-error text-sm">{accounts.error}</div>}
        <ul className="divide-base-200 mb-6 divide-y">
          {accounts.items?.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              isYou={account.id === viewer.id}
              onChange={accounts.reload}
            />
          ))}
        </ul>
        <h3 className="mb-2 font-semibold">Add an account</h3>
        <AddAccount onAdded={accounts.reload} />
      </Section>
      <Section title="API keys">
        <p className="mb-4 text-sm">
          For uploading firmware with curl: send the key in an <code>X-Api-Key</code> header. A key
          acts as you, and only uploads firmware.
        </p>
        {keys.error && <div className="text-error text-sm">{keys.error}</div>}
        <ul className="divide-base-200 mb-6 divide-y">
          {keys.items?.map((key) => (
            <ApiKeyRow key={key.id} apiKey={key} onDeleted={keys.reload} />
          ))}
        </ul>
        <CreateApiKey onCreated={keys.reload} />
      </Section>
    </>
  );
}

/** A button that asks once more before it does anything. */
function ConfirmButton({ label, onConfirm }: { label: string; onConfirm: () => Promise<void> }) {
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

function AccountRow({
  account,
  isYou,
  onChange,
}: {
  account: Account;
  isYou: boolean;
  onChange: () => Promise<void>;
}) {
  const [settingPassword, setSettingPassword] = useState(false);
  const [password, setPassword] = useState("");
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-grow">
          <div>
            {account.name} {isYou && <span className="text-sm opacity-60">(you)</span>}
          </div>
          <div className="text-sm opacity-60">
            {account.email} · {account.role === "admin" ? "admin" : "can change the lines"}
          </div>
        </div>
        {!isYou && (
          <>
            <button
              className="btn btn-sm btn-soft"
              type="button"
              onClick={() => setSettingPassword((open) => !open)}
            >
              Set password
            </button>
            <ConfirmButton
              label="Remove"
              onConfirm={async () => {
                await removeAccount(account.id);
                await onChange();
              }}
            />
          </>
        )}
      </div>
      {settingPassword && (
        <ActionForm
          className="mt-3"
          submit="Set password"
          onSubmit={async () => {
            await setAccountPassword(account.id, password);
            setPassword("");
            setSettingPassword(false);
          }}
        >
          <Field
            label={`New password for ${account.name}`}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
          />
        </ActionForm>
      )}
    </li>
  );
}

function AddAccount({ onAdded }: { onAdded: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("user");
  return (
    <ActionForm
      submit="Add account"
      onSubmit={async () => {
        await addAccount({ name, email, password, role });
        setName("");
        setEmail("");
        setPassword("");
        setRole("user");
        await onAdded();
      }}
    >
      <Field label="Name" value={name} onChange={setName} autoComplete="off" />
      <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="off" />
      <Field
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
      />
      <select
        className="select w-full"
        aria-label="Role"
        value={role}
        onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "user")}
      >
        <option value="user">Can change the lines</option>
        <option value="admin">Admin: also manages accounts and uploads firmware</option>
      </select>
    </ActionForm>
  );
}

function ApiKeyRow({ apiKey, onDeleted }: { apiKey: ApiKey; onDeleted: () => Promise<void> }) {
  return (
    <li className="flex items-center gap-2 py-3">
      <div className="flex-grow">
        <div>{apiKey.name ?? "Unnamed key"}</div>
        <div className="text-sm opacity-60">
          {apiKey.start && <code>{apiKey.start}…</code>} created{" "}
          {prettyDate(apiKey.createdAt.toISOString())}
        </div>
      </div>
      <ConfirmButton
        label="Delete"
        onConfirm={async () => {
          await deleteApiKey(apiKey.id);
          await onDeleted();
        }}
      />
    </li>
  );
}

function CreateApiKey({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string>();
  return (
    <>
      <ActionForm
        submit="Create API key"
        onSubmit={async () => {
          setCreated(await createApiKey(name));
          setName("");
          await onCreated();
        }}
      >
        <Field label="What it's for (say, curl on my Mac)" value={name} onChange={setName} />
      </ActionForm>
      {created && (
        <div className="bg-success/10 mt-4 flex flex-col gap-2 rounded-lg p-4">
          <div className="text-sm">Copy the key now: it isn&apos;t shown again.</div>
          <code className="break-all select-all">{created}</code>
        </div>
      )}
    </>
  );
}
