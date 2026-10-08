import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import ResourceCatalog from "./resource-catalog";

export default async function ResourcesPage() {
  if (!await getAuthContext()) redirect("/login");
  return <ResourceCatalog />;
}
