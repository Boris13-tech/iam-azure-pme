"use client";
import React from 'react';

interface RoleManagerProps {
  roles: any[];
  onEdit: (role: any) => void;
  onDelete?: (roleId: string) => void;
}

export default function RoleManager({ roles, onEdit, onDelete }: RoleManagerProps) {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {roles.map(role => (
        <div key={role.id} className="bg-white overflow-hidden shadow-sm rounded-xl border border-gray-200 hover:shadow-lg hover:border-indigo-200 transition-all duration-300">
          <div className="px-5 py-6">
            <div className="flex justify-between items-start">
              <h3 className="text-xl leading-6 font-bold text-slate-800">{role.name}</h3>
              {role.isCustom && onDelete && (
                <button 
                  onClick={() => onDelete(role.id)}
                  className="text-red-400 hover:text-red-600 transition-colors"
                  title="Supprimer ce rôle"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
              )}
            </div>
            <p className="mt-2 max-w-2xl text-sm text-slate-500">{role.description || "Aucune description fournie"}</p>
            <div className="mt-5">
              <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700">
                {role._count?.users || 0} utilisateurs
              </span>
            </div>
            <div className="mt-6 border-t border-gray-100 pt-4">
              <h4 className="text-sm font-semibold text-slate-700">Permissions Associées</h4>
              <ul className="mt-3 space-y-2">
                {role.permissions?.slice(0, 3).map((p: any) => (
                  <li key={p.permission.id} className="text-xs text-slate-500 bg-slate-50 rounded px-2 py-1">
                    <span className="font-medium text-slate-700">{p.permission.action}</span> sur {p.permission.resource}
                  </li>
                ))}
                {role.permissions?.length > 3 && (
                  <li className="text-xs text-indigo-500 font-medium pl-2">+ {role.permissions.length - 3} autres permissions</li>
                )}
                {(!role.permissions || role.permissions.length === 0) && (
                  <li className="text-xs text-slate-400 italic">Aucune permission</li>
                )}
              </ul>
            </div>
          </div>
          <div className="px-5 py-4 bg-slate-50 border-t border-gray-100 flex justify-between items-center">
            <button 
              onClick={() => onEdit(role)}
              className="text-sm font-semibold text-indigo-600 hover:text-indigo-800 transition-colors"
            >
              Modifier les accès
            </button>
            {role.isCustom && <span className="text-xs text-slate-400">Personnalisé</span>}
          </div>
        </div>
      ))}
    </div>
  );
}