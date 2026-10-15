import { Suspense } from "react";
import { notFound } from "next/navigation";
import { premiumUi } from "@/flags";
import { LibraryScreen } from "@/components/app/library-screen";
import { StatusCard } from "@/components/app/status-card";
export default async function LibraryPage() {
  if (!(await premiumUi())) notFound();
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
