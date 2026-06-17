"use client";
import React, { useState } from 'react';

export default function UserForm({ onSubmit, onCancel, initialData }: any) {
  const [formData, setFormData] = useState({
    name: initialData?.name || '',
    email: initialData?.email || '',
    roleId: initialData?.roles?.[0]?.role?.id || ''
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 bg-white p-8 rounded-xl shadow-lg border border-gray-100">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Nom complet</label>
        <input 
          type="text" 
          value={formData.name}
          onChange={e => setFormData({...formData, name: e.target.value})}
          className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-2.5 border transition-all"
          placeholder="Jean Dupont"
          required 
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Adresse Email</label>
        <input 
          type="email" 
          value={formData.email}
          onChange={e => setFormData({...formData, email: e.target.value})}
          className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-2.5 border transition-all"
          placeholder="jean.dupont@entreprise.com"
          required 
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Rôle</label>
        <select 
          value={formData.roleId}
          onChange={e => setFormData({...formData, roleId: e.target.value})}
          className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-2.5 border transition-all"
        >
          <option value="">-- Sélectionnez un rôle --</option>
          <option value="admin-id">Administrateur</option>
          <option value="user-id">Utilisateur Standard</option>
          <option value="hr-id">Ressources Humaines</option>
        </select>
      </div>
      <div className="flex justify-end space-x-3 pt-6 border-t border-gray-100">
        <button type="button" onClick={onCancel} className="bg-white py-2.5 px-5 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
          Annuler
        </button>
        <button type="submit" className="bg-indigo-600 py-2.5 px-5 border border-transparent rounded-md shadow-sm text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors">
          Sauvegarder
        </button>
      </div>
    </form>
  );
}