// Managed identity for the backup job on Azure Container Apps (docs/operations/BACKUP-ON-AZURE.md).
// Inside the job, the platform exposes a local token endpoint and a per-replica header: the job gets a short-lived
// token for Blob Storage without any stored secret. Outside Azure (CI, the operator's workstation) this returns
// null and the container URL must carry its own SAS.
export async function storageAuthorization(env = process.env, fetchImpl = fetch) {
  const endpoint = env.IDENTITY_ENDPOINT;
  const header = env.IDENTITY_HEADER;
  if (!endpoint || !header) return null;
  const url = new URL(endpoint);
  url.searchParams.set("resource", "https://storage.azure.com/");
  url.searchParams.set("api-version", "2019-08-01");
  // A user-assigned identity is named explicitly, so the job never falls back to another one.
  if (!env.LUXIA_BACKUP_IDENTITY_CLIENT_ID) throw new Error("LUXIA_BACKUP_IDENTITY_CLIENT_ID is not set");
  url.searchParams.set("client_id", env.LUXIA_BACKUP_IDENTITY_CLIENT_ID);
  const response = await fetchImpl(url, { headers: { "X-IDENTITY-HEADER": header } });
  if (!response.ok) throw new Error(`managed identity token refused: HTTP ${response.status}`);
  const body = await response.json();
  if (typeof body?.access_token !== "string" || !body.access_token) throw new Error("managed identity token missing");
  return `Bearer ${body.access_token}`;
}
