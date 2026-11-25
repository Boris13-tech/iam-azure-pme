import { redirect } from "next/navigation";

// The legacy role model (User/Role/UserRole) is no longer part of any user journey,
// and the legacy role endpoints are retired (410 Gone, G2-R01).
export default function LegacyRolesPage() {
  redirect("/dashboard");
}
