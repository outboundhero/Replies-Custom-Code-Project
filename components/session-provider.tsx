"use client";

/**
 * Makes the server-resolved session available to client components without a
 * round trip. The dashboard layout reads `getSession()` on the server and feeds
 * it here, so pages like the inbox can read role / allowedClientTags
 * synchronously instead of each doing their own `POST /api/auth {session}`.
 */
import { createContext, useContext } from "react";
import type { UserRole } from "@/lib/auth";

export interface ClientSession {
  email: string;
  role: UserRole;
  allowedClientTags: string[] | null;
}

const SessionCtx = createContext<ClientSession | null>(null);

export function SessionProvider({
  value,
  children,
}: {
  value: ClientSession | null;
  children: React.ReactNode;
}) {
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession(): ClientSession | null {
  return useContext(SessionCtx);
}
