"use client";
import React, { useEffect, useState } from "react";
import AuditLogViewer from "@/components/AuditLogViewer";

export default function AuditPage() {
  const [logs, setLogs] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/audit")
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) setLogs(data);
      })
      .catch(console.error);
  }, []);

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-gray-200">
        <h1 className="text-2xl font-semibold text-slate-900">Journal d’audit</h1>
        <p className="mt-1 text-base text-slate-600">Historique des actions enregistrées.</p>
      </div>

      <div className="flex gap-4 mb-6 bg-white p-4 rounded-xl shadow-sm border border-slate-200">
        <div className="flex-1">
          <label className="mb-1 block text-sm font-medium text-slate-700">Date</label>
          <input type="date" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-accent focus:border-accent" />
        </div>
        <div className="flex-1">
          <label className="mb-1 block text-sm font-medium text-slate-700">Type d’événement</label>
          <select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-accent focus:border-accent bg-white">
            <option>Tous les événements</option>
            <option>Connexion</option>
            <option>Création d’utilisateur</option>
            <option>Modification d’utilisateur</option>
          </select>
        </div>
        <div className="flex items-end">
          <button className="bg-slate-800 text-white px-6 py-2 rounded-lg text-sm font-bold shadow hover:bg-slate-700 transition-colors h-10 w-full sm:w-auto">
            Filtrer
          </button>
        </div>
      </div>

      <AuditLogViewer logs={logs} />
    </div>
  );
}