import { redirect } from "next/navigation";
import { getAuthContext } from "../../../../lib/auth/auth-context";
import Onboarding from "./resource-onboarding";
export default async function OnboardingPage() {
  if (!await getAuthContext()) redirect("/login");
  return <Onboarding />;
}
