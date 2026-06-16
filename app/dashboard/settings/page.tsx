"use client";

import React, { useState, useEffect } from "react";
import { ShieldAlert, Key, Globe, Clock, Smartphone, CheckCircle2 } from "lucide-react";

export default function AccessPoliciesPage() {
  const [policies, setPolicies] = useState({
    mfa: true,
    geoBlock: false,
    sessionTimeout: true,
    passwordRotation: true
  });
  const [isSaving, setIsSaving] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings")
      .then(res => res.json())
      .then(data => {
        if (!data.error) {
          setPolicies({
            mfa: data.mfa ?? true,
            geoBlock: data.geoBlock ?? false,
            sessionTimeout: data.sessionTimeout ?? true,
            passwordRotation: data.passwordRotation ?? true
          });
        }
        setIsLoading(false);
      })
      .catch((e) => {
        console.error(e);
        setIsLoading(false);
      });
  }, []);

  const togglePolicy = (key: keyof typeof policies) => {
    setPolicies(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(policies)
      });
      setShowSaved(true);
      setTimeout(() => setShowSaved(false), 3000);
    } catch (e) {
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      <div className="flex justify-between items-center pb-4 border-b border-gray-200">
        <div>
          <h2 className="text-2xl font-bold text-slate-800 tracking-tight">Politiques d'Accès & Sécurité</h2>
          <p className="text-sm text-slate-500 mt-1 font-medium">Gérez les règles d'authentification conditionnelle et de sécurité globale.</p>
        </div>
        <div className="flex items-center gap-4">
          {showSaved && (
            <span className="flex items-center text-sm font-semibold text-green-600 animate-in fade-in slide-in-from-right-4">
              <CheckCircle2 className="w-4 h-4 mr-1.5" />
              Modifications enregistrées
            </span>
          )}
          <button 
            onClick={handleSave}
            disabled={isSaving}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-70 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-xl text-sm font-bold transition-all shadow-sm"
          >
            {isSaving ? "Sauvegarde..." : "Appliquer les politiques"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Card 1 */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm flex items-start gap-4 hover:border-indigo-200 transition-colors">
          <div className={`p-3 rounded-xl ${policies.mfa ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-400'} transition-colors`}>
            <Smartphone className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <div className="flex justify-between items-center mb-1">
              <h3 className="font-bold text-slate-900">Authentification Multifacteur (MFA)</h3>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" checked={policies.mfa} onChange={() => togglePolicy('mfa')} />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>
            <p className="text-sm text-slate-500 leading-relaxed">Exige une vérification secondaire (SMS, Authenticator) pour toutes les connexions depuis de nouveaux appareils.</p>
          </div>
        </div>

        {/* Card 2 */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm flex items-start gap-4 hover:border-indigo-200 transition-colors">
          <div className={`p-3 rounded-xl ${policies.sessionTimeout ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-400'} transition-colors`}>
            <Clock className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <div className="flex justify-between items-center mb-1">
              <h3 className="font-bold text-slate-900">Expiration de Session Stricte</h3>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" checked={policies.sessionTimeout} onChange={() => togglePolicy('sessionTimeout')} />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>
            <p className="text-sm text-slate-500 leading-relaxed">Déconnecte automatiquement les utilisateurs après 15 minutes d'inactivité totale.</p>
          </div>
        </div>

        {/* Card 3 */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm flex items-start gap-4 hover:border-indigo-200 transition-colors">
          <div className={`p-3 rounded-xl ${policies.passwordRotation ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-400'} transition-colors`}>
            <Key className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <div className="flex justify-between items-center mb-1">
              <h3 className="font-bold text-slate-900">Rotation Obligatoire des Mots de Passe</h3>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" checked={policies.passwordRotation} onChange={() => togglePolicy('passwordRotation')} />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>
            <p className="text-sm text-slate-500 leading-relaxed">Force les utilisateurs à changer leur mot de passe tous les 90 jours. (Sauf SSO Azure AD).</p>
          </div>
        </div>

        {/* Card 4 */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm flex items-start gap-4 hover:border-indigo-200 transition-colors">
          <div className={`p-3 rounded-xl ${policies.geoBlock ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-400'} transition-colors`}>
            <Globe className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <div className="flex justify-between items-center mb-1">
              <h3 className="font-bold text-slate-900">Blocage Géographique (Géo-fencing)</h3>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" checked={policies.geoBlock} onChange={() => togglePolicy('geoBlock')} />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>
            <p className="text-sm text-slate-500 leading-relaxed">Restreint les connexions uniquement aux adresses IP provenant du territoire national.</p>
          </div>
        </div>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 flex items-start gap-3 mt-8">
        <ShieldAlert className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
        <div>
          <h4 className="font-semibold text-amber-800">Attention</h4>
          <p className="text-sm text-amber-700 mt-1">
            La modification des politiques d'accès conditionnel peut entraîner la déconnexion immédiate de certains utilisateurs. 
            Assurez-vous d'avoir communiqué ces changements au préalable.
          </p>
        </div>
      </div>
    </div>
  );
}