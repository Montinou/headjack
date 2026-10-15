import { cookies } from "next/headers";
export async function premiumUi() {
  return (await cookies()).get("qa-ui")?.value !== "off";
}
export async function clerkAuth() {
  return (await cookies()).get("qa-auth")?.value !== "off";
}
export async function evaluateSearchFlags() {
  return { bilingualFts: false, ranking: "rrf-english" };
}
