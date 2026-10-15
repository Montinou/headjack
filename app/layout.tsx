import type { ReactNode } from "react";
import type { Metadata } from "next";
import {
  ClerkProvider,
  SignInButton,
  SignUpButton,
  Show,
  UserButton,
} from "@clerk/nextjs";
import { Manrope, IBM_Plex_Mono } from "next/font/google";
import { clerkAuth, premiumUi } from "../flags";
import { clerkConfigured } from "../lib/clerk-config.mjs";
import { siteUrl } from "../lib/site-url.mjs";
import { Root } from "@/components/app/root";
import "./globals.css";
const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  display: "swap",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
});
export const metadata: Metadata = {
  metadataBase: siteUrl(process.env),
  title: "Headjack",
  description: "A private home for your skills. Browse, review and use your agent knowledge in one place.",
  openGraph: {
    title: "Headjack",
    description: "A private home for your skills.",
    siteName: "Headjack",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Headjack",
    description: "A private home for your skills.",
  },
};
export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const [uiEnabled, authFlag] = await Promise.all([premiumUi(), clerkAuth()]);
  const authEnabled = authFlag && clerkConfigured(process.env);
  const content = uiEnabled ? (
    <Root authEnabled={authEnabled}>{children}</Root>
  ) : (
    <>
      {authEnabled && (
        <header>
          <nav aria-label="Account">
            <a href="/">Headjack</a>{" "}
            <Show when="signed-out">
              <SignInButton mode="modal" />{" "}
              <SignUpButton mode="modal">
                <button>Accept invitation</button>
              </SignUpButton>
            </Show>
            <Show when="signed-in">
              <UserButton />
            </Show>
          </nav>
        </header>
      )}
      {children}
    </>
  );
  return (
    <html lang="en">
      <body
        className={
          uiEnabled
            ? `premium-ui ${manrope.variable} ${mono.variable}`
            : undefined
        }
      >
        {authEnabled ? <ClerkProvider>{content}</ClerkProvider> : content}
      </body>
    </html>
  );
}
