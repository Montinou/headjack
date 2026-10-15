import { notFound } from "next/navigation";
import { premiumUi } from "@/flags";
import { SkillDetailScreen } from "@/components/app/skill-detail-screen";
export default async function SkillPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  if (!(await premiumUi())) notFound();
  const { slug } = await params;
  // Installed Next 16.3 supplies the encoded segment; the API encodes the raw slug once.
  let decoded: string;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    notFound();
  }
  return <SkillDetailScreen slug={decoded} />;
}
