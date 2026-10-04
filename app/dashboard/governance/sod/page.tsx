import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import SoDConsole from "./sod-console";
export default async function SoDPage() {
  if (!await getAuthContext()) redirect("/login");
  return <SoDConsole />;
}
