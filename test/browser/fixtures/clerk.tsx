"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
type Session = {
  isLoaded: boolean;
  userId: string | null;
  sessionId: string | null;
};
const Context = createContext<Session | null>(null);
const ClerkContext = createContext<any>(null);
export function ClerkProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({
    isLoaded: true,
    userId: null,
    sessionId: null,
  });
  const current = useRef(session);
  current.current = session;
  const clerk = useRef<any>(null);
  if (!clerk.current)
    clerk.current = {
      get user() {
        return current.current.userId ? { id: current.current.userId } : null;
      },
      get session() {
        return current.current.sessionId
          ? {
              id: current.current.sessionId,
              reload: async () => {
                const response = await fetch("/fixture-clerk-reload", {
                  cache: "no-store",
                });
                if (!response.ok)
                  throw new Error("Fixture session reload failed");
                const result = await response.json();
                current.current = result;
                setSession(result);
                return {
                  id: result.sessionId,
                  status: result.status ?? "active",
                };
              },
            }
          : null;
      },
    };
  useEffect(() => {
    const update = (event: Event) =>
      setSession((event as CustomEvent<Session>).detail);
    window.addEventListener("fixture-clerk-session", update);
    document.body.dataset.fixtureClerkReady = "true";
    return () => window.removeEventListener("fixture-clerk-session", update);
  }, []);
  return (
    <ClerkContext.Provider value={clerk.current}>
      <Context.Provider value={session}>{children}</Context.Provider>
    </ClerkContext.Provider>
  );
}
export function useAuth() {
  const s = useContext(Context);
  if (!s) throw new Error("Clerk hook outside provider");
  return { ...s, isSignedIn: Boolean(s.userId) };
}
export function Show({
  when,
  children,
}: {
  when: string;
  children: ReactNode;
}) {
  const s = useAuth();
  return (when === "signed-in" ? s.isSignedIn : !s.isSignedIn)
    ? children
    : null;
}
export function SignInButton({
  children,
}: {
  children?: ReactNode;
  mode?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span onClick={() => setOpen(true)}>
        {children ?? <button>Sign in</button>}
      </span>
      {open && (
        <div role="dialog" aria-label="Sign in">
          <button onClick={() => setOpen(false)}>Close sign in</button>
        </div>
      )}
    </>
  );
}
export function SignUpButton({
  children,
}: {
  children: ReactNode;
  mode?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span onClick={() => setOpen(true)}>{children}</span>
      {open && (
        <div role="dialog" aria-label="Accept invitation">
          <button onClick={() => setOpen(false)}>Close invitation</button>
        </div>
      )}
    </>
  );
}
export function UserButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button aria-label="Account" onClick={() => setOpen(!open)}>
        Account
      </button>
      {open && (
        <div role="menu">
          <button
            role="menuitem"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("fixture-clerk-session", {
                  detail: { isLoaded: true, userId: null, sessionId: null },
                }),
              )
            }
          >
            Sign out
          </button>
        </div>
      )}
    </>
  );
}

export function useClerk() {
  return useContext(ClerkContext);
}
