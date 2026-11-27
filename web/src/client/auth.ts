// Signing in, and managing accounts and API keys, through Better Auth's
// endpoints on this server (/api/auth/*). Only this module talks to Better
// Auth's client, so the rest of the admin sees plain types.

import { apiKeyClient } from "@better-auth/api-key/client";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { useState } from "react";
import type { Viewer } from "../shared/api";

const client = createAuthClient({ plugins: [adminClient(), apiKeyClient()] });

export type Role = Viewer["role"];

export type Account = Viewer & { createdAt: Date };

export type ApiKey = { id: string; name: string | null; start: string | null; createdAt: Date };

type Result<T> = {
  data: T | null;
  error: { message?: string | undefined; statusText: string } | null;
};

/** The result's data, or its error thrown with Better Auth's message. */
function unwrap<T>(result: Result<T>): T {
  if (result.error || result.data === null) {
    throw new Error(result.error?.message ?? result.error?.statusText ?? "No answer");
  }
  return result.data;
}

function toRole(role: string | null | undefined): Role {
  return role === "admin" ? "admin" : "user";
}

/**
 * Who's signed in: undefined while that's first being checked, null for
 * nobody. Signing in or out updates it.
 */
export function useViewer(): Viewer | null | undefined {
  const { data, isPending } = client.useSession();
  // Better Auth is pending again on every later check while nobody's signed
  // in (on coming back to the tab, say). Only the first check counts, so the
  // sign-in form isn't swapped out, and emptied, meanwhile.
  const [answered, setAnswered] = useState(false);
  if (!isPending && !answered) {
    setAnswered(true);
  }
  if (isPending && !answered) {
    return undefined;
  }
  if (!data) {
    return null;
  }
  const { id, name, email, role } = data.user;
  return { id, name, email, role: toRole(role) };
}

/** Checks who's signed in again, as after the API answered 401. */
export function refreshViewer() {
  client.$store.notify("$sessionSignal");
}

export async function signIn(email: string, password: string): Promise<void> {
  unwrap(await client.signIn.email({ email, password }));
}

export async function signOut(): Promise<void> {
  unwrap(await client.signOut());
}

/** Changes your own name; who's signed in updates with it. */
export async function updateName(name: string): Promise<void> {
  unwrap(await client.updateUser({ name }));
}

export async function changePassword(currentPassword: string, newPassword: string) {
  unwrap(await client.changePassword({ currentPassword, newPassword, revokeOtherSessions: true }));
}

export async function listAccounts(): Promise<Account[]> {
  const { users } = unwrap(await client.admin.listUsers({ query: { sortBy: "name" } }));
  return users.map(({ id, name, email, role, createdAt }) => ({
    id,
    name,
    email,
    role: toRole(role),
    createdAt: new Date(createdAt),
  }));
}

export async function addAccount(account: {
  name: string;
  email: string;
  password: string;
  role: Role;
}): Promise<void> {
  unwrap(await client.admin.createUser(account));
}

export async function removeAccount(userId: string): Promise<void> {
  unwrap(await client.admin.removeUser({ userId }));
}

/** Sets someone's password, and signs them out everywhere, as changing your own does elsewhere. */
export async function setAccountPassword(userId: string, newPassword: string): Promise<void> {
  unwrap(await client.admin.setUserPassword({ userId, newPassword }));
  unwrap(await client.admin.revokeUserSessions({ userId }));
}

export async function listApiKeys(): Promise<ApiKey[]> {
  const { apiKeys } = unwrap(await client.apiKey.list());
  return apiKeys.map(({ id, name, start, createdAt }) => ({
    id,
    name,
    start,
    createdAt: new Date(createdAt),
  }));
}

/** Creates an API key and returns it: the only time it can be seen. */
export async function createApiKey(name: string): Promise<string> {
  return unwrap(await client.apiKey.create({ name })).key;
}

export async function deleteApiKey(keyId: string): Promise<void> {
  unwrap(await client.apiKey.delete({ keyId }));
}
