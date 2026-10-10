"use client";
import React from "react";
import { PasskeyEnrollment } from "./passkey-enrollment";

// Only real, enforced capabilities are shown here. The former MFA / session timeout / password
// rotation / geo-blocking switches were removed: nothing enforced them and saving was refused by
// the server while the page reported success.
export default function AuthenticationSettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Authentification</h1>
        <p className="mt-1 text-base text-slate-600">Gérez vos moyens de connexion.</p>
      </div>
      <PasskeyEnrollment />
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-slate-900">Politiques d’authentification</h2>
        <p className="mt-1 text-sm text-slate-600">
          L’authentification multifacteur obligatoire, l’expiration des sessions par inactivité et la restriction
          géographique ne sont pas encore disponibles.
        </p>
      </div>
    </div>
  );
}
