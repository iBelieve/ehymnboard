import { useState } from "react";
import type { Viewer } from "../shared/api";
import {
  changePassword,
  createApiKey,
  deleteApiKey,
  listApiKeys,
  updateName,
  type ApiKey,
} from "./auth";
import { prettyDate } from "./prettyDate";
import { ConfirmButton, Section, SettingsPage } from "./Settings";
import { useList } from "./useList";
import { ActionForm, Field } from "./SignIn";

/** Your own account: your name, your password and your API keys. */
export function ProfilePage({ viewer }: { viewer: Viewer }) {
  return (
    <SettingsPage title="Profile">
      <Section title="Your name">
        <ChangeName viewer={viewer} />
      </Section>
      <Section title="Your password">
        <ChangePassword />
      </Section>
      <ApiKeys role={viewer.role} />
    </SettingsPage>
  );
}

function ChangeName({ viewer }: { viewer: Viewer }) {
  const [name, setName] = useState(viewer.name);
  const [done, setDone] = useState(false);
  return (
    <ActionForm
      submit="Save name"
      onSubmit={async () => {
        setDone(false);
        // Spaces alone pass the field's `required`, but would leave the
        // menu's link here with no text to click.
        const trimmed = name.trim();
        if (!trimmed) {
          throw new Error("Your name can't be blank");
        }
        await updateName(trimmed);
        setName(trimmed);
        setDone(true);
      }}
    >
      <p className="text-sm opacity-75">
        What others see on the Accounts page. You sign in with {viewer.email}.
      </p>
      <Field label="Name" value={name} onChange={setName} autoComplete="name" />
      {done && <div className="text-success text-sm">Name saved.</div>}
    </ActionForm>
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

function ApiKeys({ role }: { role: Viewer["role"] }) {
  const keys = useList(listApiKeys);
  return (
    <Section title="Your API keys">
      <p className="mb-4 text-sm">
        For scripts and workflows that set the lines
        {role === "admin" && " or upload firmware"}: send the key in an{" "}
        <code>Authorization: Bearer</code> (or <code>X-Api-Key</code>) header. A key acts as you,
        but can&apos;t manage accounts or keys.
      </p>
      {keys.error && <div className="text-error text-sm">{keys.error}</div>}
      <ul className="divide-base-200 mb-6 divide-y">
        {keys.items?.map((key) => (
          <ApiKeyRow key={key.id} apiKey={key} onDeleted={keys.reload} />
        ))}
      </ul>
      <CreateApiKey onCreated={keys.reload} />
    </Section>
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
