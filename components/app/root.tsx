"use client";
import type { ReactNode } from "react";
import {
  AuthAvailability,
  AuthBoundary,
} from "@/components/premium/auth-boundary";
import { Shell } from "@/components/app/shell";

// Premium root: auth availability for the whole tree, the workspace shell,
// and the session boundary around the page content.
export function Root({
  authEnabled,
  children,
}: {
  authEnabled: boolean;
  children: ReactNode;
}) {
  return (
    <AuthAvailability value={authEnabled}>
      <Shell>
        <AuthBoundary>{children}</AuthBoundary>
      </Shell>
    </AuthAvailability>
  );
}
