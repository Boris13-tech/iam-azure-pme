"use client";
import React, { useEffect, useState } from "react";
import RoleManager from "@/components/RoleManager";
import RoleForm from "@/components/RoleForm";

export default function RolesPage() {
  const [roles, setRoles] = useState<any[]>([]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<any>(null);

  useEffect(() => {
    fetchRoles();
  }, []);

  const fetchRoles = () => {
    fetch("/api/roles")
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) setRoles(data);
      })
      .catch(console.error);
  };

  const handleCreateOrUpdate = async (roleData: any) => {
    try {
      const url = editingRole ? `/api/roles/${editingRole.id}` : "/api/roles";
      const method = editingRole ? "PATCH" : "POST";
      
      await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(roleData)
      });
      
      setIsFormOpen(false);
      setEditingRole(null);
      fetchRoles();
    } catch (e) {
      console.error(e);
    }
  };

  const handleDelete = async (roleId: string) => {
    if (!confirm("Voulez-vous vraiment supprimer ce rôle personnalisé ?")) return;
    try {
      await fetch(`/api/roles/${roleId}`, { method: "DELETE" });
      fetchRoles();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      <div className="flex justify-between items-center pb-4 border-b border-gray-200">
        <div>
          <h2 className="text-2xl font-bold text-slate-800 tracking-tight">Rôles et Permissions (RBAC)</h2>
          <p className="text-sm text-slate-500 mt-1 font-medium">Créez et assignez des permissions granulaires aux groupes.</p>
        </div>
        <button 
          onClick={() => { setEditingRole(null); setIsFormOpen(true); }}
          className="bg-white border-2 border-indigo-600 text-indigo-700 hover:bg-indigo-50 px-5 py-2.5 rounded-xl text-sm font-bold transition-all shadow-sm"
        >
          + Nouveau Rôle
        </button>
      </div>

      {isFormOpen ? (
        <div className="max-w-2xl">
          <RoleForm 
            initialData={editingRole} 
            onSubmit={handleCreateOrUpdate} 
            onCancel={() => { setIsFormOpen(false); setEditingRole(null); }} 
          />
        </div>
      ) : (
        <RoleManager 
          roles={roles} 
          onEdit={(role) => { setEditingRole(role); setIsFormOpen(true); }}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}