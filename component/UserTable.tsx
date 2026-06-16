"use client";
import React from 'react';

export type User = {
  id: string;
  name: string;
  email: string;
  status: string;
  roles: { role: { name: string } }[];
};

export default function UserTable({ users, onEdit, onDelete }: { 
  users: User[], 
  onEdit: (u: User) => void, 
  onDelete: (u: User) => void 
}) {
  return (
    <div className="overflow-x-auto shadow-sm ring-1 ring-black ring-opacity-5 rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-300">
        <thead className="bg-slate-50">
          <tr>
            <th className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-slate-900">Nom</th>
            <th className="px-3 py-3.5 text-left text-sm font-semibold text-slate-900">Email</th>
            <th className="px-3 py-3.5 text-left text-sm font-semibold text-slate-900">Rôle</th>
            <th className="px-3 py-3.5 text-left text-sm font-semibold text-slate-900">Statut</th>
            <th className="relative py-3.5 pl-3 pr-4 sm:pr-6"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 bg-white">
          {users.map((user) => (
            <tr key={user.id} className="hover:bg-slate-50 transition-colors">
              <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-slate-900">{user.name}</td>
              <td className="whitespace-nowrap px-3 py-4 text-sm text-slate-500">{user.email}</td>
              <td className="whitespace-nowrap px-3 py-4 text-sm text-slate-500">
                {user.roles.length > 0 ? user.roles.map(r => r.role.name).join(", ") : "Aucun"}
              </td>
              <td className="whitespace-nowrap px-3 py-4 text-sm">
                <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold leading-5 ${user.status === 'ACTIVE' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                  {user.status === 'ACTIVE' ? 'Actif' : 'Inactif'}
                </span>
              </td>
              <td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium sm:pr-6">
                <button onClick={() => onEdit(user)} className="text-indigo-600 hover:text-indigo-900 mr-4 font-semibold transition-colors">Modifier</button>
                <button onClick={() => onDelete(user)} className="text-red-600 hover:text-red-900 font-semibold transition-colors">Désactiver</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}