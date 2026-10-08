import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import ReviewConsole from "./review-console";
export default async function AccessReviewsPage() {
  if (!await getAuthContext()) redirect("/login");
  return <ReviewConsole />;
}
