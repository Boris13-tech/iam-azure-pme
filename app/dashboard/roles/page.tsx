import { redirect } from "next/navigation";

// The legacy role model (User/Role/UserRole) is no longer part of any user journey.
// Its tables and the legacy roles API stay in place for backend compatibility only.
export default function LegacyRolesPage() {
  redirect("/dashboard");
}
