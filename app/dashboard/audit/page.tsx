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
    <div className="space-y-6 animate-in fade-in zoom-in-95 duration-300">
      <div className="pb-4 border-b border-gray-200">
        <h2 className="text-2xl font-bold text-slate-800 tracking-tight">Journal d'Audit Général</h2>
        <p className="text-sm text-slate-500 mt-1 font-medium">Traçabilité complète des actions de sécurité et modifications.</p>
      </div>

      <div className="flex gap-4 mb-6 bg-white p-4 rounded-xl shadow-sm border border-slate-200">
        <div className="flex-1">
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Date</label>
          <input type="date" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500" />
        </div>
        <div className="flex-1">
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Type d'Événement</label>
          <select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white">
            <option>Tous les événements</option>
            <option>LOGIN</option>
            <option>CREATE_USER</option>
            <option>UPDATE_USER</option>
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