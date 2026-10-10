import React, { useState, useEffect } from "react";

const AVAILABLE_PERMISSIONS = [
  { id: "read:users", label: "Voir les utilisateurs" },
  { id: "create:users", label: "Créer des utilisateurs" },
  { id: "delete:users", label: "Supprimer des utilisateurs" },
  { id: "read:roles", label: "Voir les rôles" },
  { id: "manage:roles", label: "Gérer les rôles" },
];

interface RoleFormProps {
  initialData?: any;
  onSubmit: (data: any) => void;
  onCancel: () => void;
}

export default function RoleForm({ initialData, onSubmit, onCancel }: RoleFormProps) {
  const [name, setName] = useState(initialData?.name || "");
  const [description, setDescription] = useState(initialData?.description || "");
  
  // Convert DB permissions to string array ["read:users", ...]
  const initialPerms = initialData?.permissions?.map((p: any) => 
    `${p.permission.action}:${p.permission.resource}`
  ) || [];
  
  const [selectedPerms, setSelectedPerms] = useState<string[]>(initialPerms);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ name, description, permissions: selectedPerms });
  };

  const togglePermission = (permId: string) => {
    setSelectedPerms(prev => 
      prev.includes(permId) ? prev.filter(p => p !== permId) : [...prev, permId]
    );
  };

  return (
    <div className="bg-white shadow-lg rounded-2xl p-8 border border-slate-100 relative">
      <h3 className="text-xl font-bold text-slate-800 mb-6">
        {initialData ? "Modifier le rôle" : "Nouveau rôle"}
      </h3>
      
      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">Nom du rôle</label>
          <input 
            type="text" 
            required
            className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-accent focus:border-accent transition-all outline-none"
            placeholder="Par exemple : Superviseur"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">Description</label>
          <textarea 
            className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-accent focus:border-accent transition-all outline-none"
            placeholder="Description"
            value={description}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-3">Permissions</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {AVAILABLE_PERMISSIONS.map(perm => (
              <label key={perm.id} className={`flex items-center p-3 border rounded-xl cursor-pointer transition-colors ${selectedPerms.includes(perm.id) ? 'bg-accent-soft border-accent-line' : 'bg-white border-slate-200 hover:bg-slate-50'}`}>
                <input 
                  type="checkbox" 
                  className="w-4 h-4 text-accent rounded border-gray-300 focus:ring-accent"
                  checked={selectedPerms.includes(perm.id)}
                  onChange={() => togglePermission(perm.id)}
                />
                <span className={`ml-3 text-sm font-medium ${selectedPerms.includes(perm.id) ? 'text-accent-strong' : 'text-slate-700'}`}>
                  {perm.label}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex justify-end space-x-4 pt-4 border-t border-slate-100">
          <button 
            type="button" 
            onClick={onCancel}
            className="px-5 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
          >
            Annuler
          </button>
          <button 
            type="submit" 
            className="px-5 py-2.5 text-sm font-bold text-white bg-accent hover:bg-accent-strong rounded-xl shadow-md shadow-accent-line transition-all"
          >
            {initialData ? "Sauvegarder" : "Créer le rôle"}
          </button>
        </div>
      </form>
    </div>
  );
}