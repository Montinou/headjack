"use client";
import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson, ApiError, PRIVATE_SESSION_EXPIRED_EVENT } from "@/lib/ui/api";
type Snapshot<T> = {
  key: string | null;
  state: "idle" | "loading" | "success" | "error";
  data: T | null;
  error: ApiError | null;
};
export function usePrivateResource<T>(path: string | null) {
  const { isLoaded, isSignedIn, userId, sessionId } = useAuth();
  const key =
    isLoaded && isSignedIn && path ? `${userId}:${sessionId}:${path}` : null;
  const currentKey = useRef(key);
  currentKey.current = key;
  const generation = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot<T>>({
    key: null,
    state: "idle",
    data: null,
    error: null,
  });
  const retry = useCallback(() => {
    setSnapshot({ key: null, state: "idle", data: null, error: null });
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    if (!key || !path) {
      setSnapshot({ key, state: "idle", data: null, error: null });
      return () => controller.abort();
    }
    setSnapshot({ key, state: "loading", data: null, error: null });
    const active = () =>
      !controller.signal.aborted &&
      generation.current === requestGeneration &&
      currentKey.current === key;
    void apiJson<T>(path, controller.signal).then(
      (data) => {
        if (active()) setSnapshot({ key, state: "success", data, error: null });
      },
      (error) => {
        // Expiry belongs to the current path/session generation; superseded 401s are inert.
        if (active() && error instanceof ApiError && error.status === 401)
          window.dispatchEvent(new Event(PRIVATE_SESSION_EXPIRED_EVENT));
        if (active())
          setSnapshot({
            key,
            state: "error",
            data: null,
            error:
              error instanceof ApiError
                ? error
                : new ApiError(0, "Unable to load this content. Try again."),
          });
      },
    );
    return () => {
      controller.abort();
      ++generation.current;
    };
  }, [key, path, attempt]);
  // Render guard makes previous state inaccessible before effect cleanup/new fetch runs.
  if (snapshot.key !== key)
    return {
      state: key ? ("loading" as const) : ("idle" as const),
      data: null,
      error: null,
      retry,
    };
  return {
    state: snapshot.state,
    data: snapshot.data,
    error: snapshot.error,
    retry,
  };
}
