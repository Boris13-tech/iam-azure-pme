"use client";
import React from 'react';

export default function AuditLogViewer({ logs }: { logs: any[] }) {
  return (
    <div className="bg-white shadow-sm overflow-hidden rounded-xl border border-gray-200">
      <ul role="list" className="divide-y divide-gray-100">
        {logs.map((log) => (
          <li key={log.id}>
            <div className="px-5 py-5 hover:bg-slate-50 transition-colors duration-150">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-indigo-700 truncate">
                  {log.action}
                </p>
                <div className="ml-2 flex-shrink-0 flex">
                  <p className={`px-2.5 py-0.5 inline-flex text-xs leading-5 font-bold rounded-full ${log.result === 'SUCCESS' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                    {log.result || "UNKNOWN"}
                  </p>
                </div>
              </div>
              <div className="mt-3 sm:flex sm:justify-between items-center">
                <div className="sm:flex sm:space-x-6 text-sm text-slate-500 font-medium">
                  <p className="flex items-center">
                    <span className="bg-slate-100 px-2 py-1 rounded text-slate-700 mr-2">Acteur:</span> {log.actor?.name || log.actorId || "Système"}
                  </p>
                  <p className="mt-2 flex items-center sm:mt-0">
                    <span className="bg-slate-100 px-2 py-1 rounded text-slate-700 mr-2">Cible:</span> {log.target || "N/A"}
                  </p>
                  <p className="mt-2 flex items-center sm:mt-0">
                    <span className="bg-slate-100 px-2 py-1 rounded text-slate-700 mr-2">IP:</span> {log.ip || "0.0.0.0"}
                  </p>
                </div>
                <div className="mt-3 flex items-center text-xs text-slate-400 font-semibold sm:mt-0">
                  <p>{new Date(log.timestamp).toLocaleString("fr-FR")}</p>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}