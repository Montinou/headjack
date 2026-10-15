import { Suspense } from "react";
import { LibraryScreen } from "@/components/app/library-screen";
import { StatusCard } from "@/components/app/status-card";
import { premiumUi } from "../flags";
export default async function Home() {
  if (!(await premiumUi()))
    return (
      <main>
        <h1>headjack</h1>
        <p>API only for now.</p>
      </main>
    );
  return (
    <Suspense
      fallback={
        <StatusCard
          state="loading"
          message="Preparing your library…"
          headingLevel={1}
        />
      }
    >
      <LibraryScreen />
    </Suspense>
  );
}
