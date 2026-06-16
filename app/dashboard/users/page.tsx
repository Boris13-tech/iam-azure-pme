"use client";
import React, { useEffect, useState } from "react";
import UserTable, { User } from "@/components/UserTable";
import UserForm from "@/components/UserForm";

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      const res = await fetch("/api/users");
      const data = await res.json();
      if (data.users) setUsers(data.users);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateOrUpdate = async (userData: any) => {
    try {
      const url = editingUser ? `/api/users/${editingUser.id}` : "/api/users";
      const method = editingUser ? "PATCH" : "POST";
      
      await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(userData)
      });
      
      setIsFormOpen(false);
      setEditingUser(null);
      fetchUsers();
    } catch (e) {
      console.error(e);
    }
  };

  const handleDelete = async (user: User) => {
    if (!confirm(`Désactiver l'utilisateur ${user.name} ?`)) return;
    try {
      await fetch(`/api/users/${user.id}`, { method: "DELETE" });
      fetchUsers();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex justify-between items-center pb-4 border-b border-gray-200">
        <div>
          <h2 className="text-2xl font-bold text-slate-800 tracking-tight">Gestion des Utilisateurs</h2>
          <p className="text-sm text-slate-500 mt-1 font-medium">Gérez les accès, rôles et les statuts des employés.</p>
        </div>
        <button 
          onClick={() => { setEditingUser(null); setIsFormOpen(true); }}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-xl text-sm font-bold transition-all shadow-md shadow-indigo-200"
        >
          + Nouvel Utilisateur
        </button>
      </div>

      {isFormOpen ? (
        <div className="max-w-3xl">
          <UserForm 
            initialData={editingUser} 
            onSubmit={handleCreateOrUpdate} 
            onCancel={() => { setIsFormOpen(false); setEditingUser(null); }} 
          />
        </div>
      ) : (
        <UserTable users={users} onEdit={(u) => { setEditingUser(u); setIsFormOpen(true); }} onDelete={handleDelete} />
      )}
    </div>
  );
}