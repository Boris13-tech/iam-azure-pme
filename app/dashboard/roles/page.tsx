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
    <div className="space-y-8">
      <div className="flex justify-between items-center pb-4 border-b border-gray-200">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Rôles (ancien modèle)</h1>
          <p className="mt-1 text-base text-slate-600">Rôles hérités de la première version de LUXIA.</p>
        </div>
        <button 
          onClick={() => { setEditingRole(null); setIsFormOpen(true); }}
          className="bg-white border-2 border-accent text-accent-strong hover:bg-accent-soft px-5 py-2.5 rounded-xl text-sm font-bold transition-all shadow-sm"
        >
          Nouveau rôle
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