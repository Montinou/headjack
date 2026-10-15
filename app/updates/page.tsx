import { notFound } from "next/navigation";
import { premiumUi } from "@/flags";
import { UpdatesScreen } from "@/components/app/updates-screen";

export default async function UpdatesPage() {
  if (!(await premiumUi())) notFound();
  return <UpdatesScreen />;
}
