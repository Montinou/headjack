import { notFound } from "next/navigation";
import { premiumUi } from "@/flags";
import { GettingStartedScreen } from "@/components/app/getting-started-screen";

export default async function GettingStartedPage() {
  if (!(await premiumUi())) notFound();
  return <GettingStartedScreen />;
}
