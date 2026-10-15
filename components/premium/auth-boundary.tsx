"use client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useAuth,
  useClerk,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import { PRIVATE_SESSION_EXPIRED_EVENT } from "@/lib/ui/api";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { Introduction } from "@/components/app/introduction";
import { StatusCard } from "@/components/app/status-card";
export const AuthAvailability = createContext(false);
export function AuthControls() {
  return useContext(AuthAvailability) ? <ConfiguredControls /> : null;
}
function ConfiguredControls() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return null;
  return (
    <div className="account-controls flex flex-wrap items-center gap-2">
      {isSignedIn ? (
        <UserButton />
      ) : (
        <>
          <SignInButton mode="modal">
            <Button>Sign in</Button>
          </SignInButton>
          <span className="invitation-control">
            <SignUpButton mode="modal">
              <Button variant="outline" className="shadow-none">
                Accept invitation
              </Button>
            </SignUpButton>
          </span>
        </>
      )}
    </div>
  );
}
export function AuthBoundary({ children }: { children: ReactNode }) {
  const enabled = useContext(AuthAvailability);
  if (!enabled)
    return (
      <section className="paper-card mx-auto my-10 flex w-[min(calc(100%-2rem),28rem)] flex-col items-center gap-3 px-6 py-8 text-center">
        <h1 className="text-[22px] leading-7 font-bold tracking-[-0.01em] text-(--ink-title)">
          Sign-in unavailable
        </h1>
        <p className="text-[15px] leading-6 text-(--ink-muted)">
          Sign-in is currently unavailable. Please try again later or contact
          the person who invited you.
        </p>
      </section>
    );
  return <ConfiguredBoundary>{children}</ConfiguredBoundary>;
}
function ConfiguredBoundary({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, sessionId } = useAuth();
  if (!isLoaded)
    return (
      <StatusCard
        state="loading"
        message="Checking your account…"
        headingLevel={1}
      />
    );
  if (!isSignedIn) return <Introduction />;
  return (
    <PrivateSessionBoundary
      key={`${userId}:${sessionId}`}
      identity={`${userId}:${sessionId}`}
    >
      {children}
    </PrivateSessionBoundary>
  );
}
// Presentation lifecycle only: Clerk and the API remain the authorization authorities.
function PrivateSessionBoundary({
  identity,
  children,
}: {
  identity: string;
  children: ReactNode;
}) {
  const clerk = useClerk();
  const [gate, setGate] = useState<"ready" | "checking" | "expired" | "failed">(
    "ready",
  );
  const [generation, setGeneration] = useState(0);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const frozen = useRef(false);
  const revalidate = async () => {
    const current = ++sequence.current;
    setGate("checking");
    try {
      const session = clerk.session;
      if (!session) throw new Error("Session unavailable");
      const refreshed = await session.reload();
      if (!mounted.current || current !== sequence.current) return;
      if (
        refreshed.status !== "active" ||
        !clerk.session ||
        `${clerk.user?.id}:${clerk.session.id}` !== identity
      ) {
        setGate("expired");
        return;
      }
      setGeneration((value) => value + 1);
      setGate("ready");
    } catch {
      if (mounted.current && current === sequence.current) setGate("failed");
    }
  };
  // Bind current Clerk instance, clean every listener and cancel unresolved validation on unmount.
  useEffect(() => {
    mounted.current = true;
    const block = (state: "checking" | "expired") => {
      ++sequence.current;
      flushSync(() => setGate(state));
    };
    const expire = () => block("expired");
    const hide = () => {
      frozen.current = true;
      block("checking");
    };
    const show = (event: PageTransitionEvent) => {
      if (event.persisted || frozen.current) {
        frozen.current = false;
        block("checking");
        void revalidate();
      }
    };
    const restore = () => {
      block("checking");
      void revalidate();
    };
    window.addEventListener(PRIVATE_SESSION_EXPIRED_EVENT, expire);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    window.addEventListener("popstate", restore);
    return () => {
      mounted.current = false;
      ++sequence.current;
      window.removeEventListener(PRIVATE_SESSION_EXPIRED_EVENT, expire);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      window.removeEventListener("popstate", restore);
    };
  }, [clerk, identity]);
  if (gate !== "ready")
    return (
      <div className="flex flex-col items-center">
        <StatusCard
          state={gate === "checking" ? "loading" : "unauthorized"}
          headingLevel={1}
          message={
            gate === "checking"
              ? "Rechecking your session…"
              : gate === "failed"
                ? "Your session could not be verified. Try again or sign in."
                : "Your session expired. Sign in or recheck your session to continue."
          }
          onRetry={gate === "checking" ? undefined : revalidate}
        />
        {gate !== "checking" && (
          <SignInButton mode="modal">
            <Button>Sign in</Button>
          </SignInButton>
        )}
      </div>
    );
  return (
    <div key={generation} className="private-content">
      {children}
    </div>
  );
}
