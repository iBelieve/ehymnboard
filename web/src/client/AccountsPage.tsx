import { useState } from "react";
import type { Viewer } from "../shared/api";
import {
  addAccount,
  listAccounts,
  removeAccount,
  setAccountPassword,
  type Account,
  type Role,
} from "./auth";
import { ConfirmButton, Section, SettingsPage } from "./Settings";
import { useList } from "./useList";
import { ActionForm, Field } from "./SignIn";

/** Everyone's accounts, for admins: adding, removing, and setting passwords. */
export function AccountsPage({ viewer }: { viewer: Viewer }) {
  const accounts = useList(listAccounts);
  return (
    <SettingsPage title="Accounts">
      <Section title="Everyone's accounts">
        {accounts.error && <div className="text-error text-sm">{accounts.error}</div>}
        <ul className="divide-base-200 divide-y">
          {accounts.items?.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              isYou={account.id === viewer.id}
              onChange={accounts.reload}
            />
          ))}
        </ul>
      </Section>
      <Section title="Add an account">
        <AddAccount onAdded={accounts.reload} />
      </Section>
    </SettingsPage>
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
        {isYou ? (
          <a className="btn btn-sm btn-soft" href="#profile">
            Your profile
          </a>
        ) : (
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
          <p className="text-sm opacity-60">
            Signs them out everywhere and deletes their API keys.
          </p>
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
