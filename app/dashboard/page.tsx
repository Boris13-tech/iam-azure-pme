"use client";
import React, { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

export default function DashboardPage() {
  const [isClient, setIsClient] = useState(false);
  const [dashboardData, setDashboardData] = useState({
    activeUsers: 0,
    rolesConfigured: 0,
    graphData: []
  });

  useEffect(() => {
    setIsClient(true);
    fetch("/api/dashboard")
      .then(res => res.json())
      .then(data => {
        if (!data.error) setDashboardData(data);
      })
      .catch(console.error);
  }, []);

  return (
    <div className="space-y-8 animate-in fade-in zoom-in-95 duration-500">
      <div>
        <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight">Vue d'ensemble</h2>
        <p className="mt-2 text-sm text-slate-500 font-medium">Statistiques, alertes et activité globale de l'organisation.</p>
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        <div className="bg-white overflow-hidden shadow-sm hover:shadow-md transition-shadow rounded-2xl border border-slate-200 p-6 flex flex-col relative group">
          <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
            <svg className="w-16 h-16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
          </div>
          <dt className="text-sm font-semibold text-slate-500 uppercase tracking-wider relative z-10">Utilisateurs Actifs</dt>
          <dd className="mt-3 text-4xl font-black text-indigo-600 relative z-10">{dashboardData.activeUsers}</dd>
        </div>
        
        <div className="bg-white overflow-hidden shadow-sm hover:shadow-md transition-shadow rounded-2xl border border-slate-200 p-6 flex flex-col relative group">
          <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
            <svg className="w-16 h-16" fill="currentColor" viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm9 14H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>
          </div>
          <dt className="text-sm font-semibold text-slate-500 uppercase tracking-wider relative z-10">Rôles Configurés</dt>
          <dd className="mt-3 text-4xl font-black text-indigo-600 relative z-10">{dashboardData.rolesConfigured}</dd>
        </div>

        <div className="bg-gradient-to-br from-green-50 to-emerald-50 overflow-hidden shadow-sm hover:shadow-md transition-shadow rounded-2xl border border-green-100 p-6 flex flex-col">
          <dt className="text-sm font-bold text-green-600 uppercase tracking-wider flex items-center">
            <span className="mr-2">✅ État du Système</span>
          </dt>
          <dd className="mt-4 text-base font-semibold text-green-800 leading-relaxed border-l-2 border-green-300 pl-3">
            Système LUXIA sain <br/>
            Connecté à PostgreSQL
          </dd>
        </div>
      </div>

      <div className="bg-white p-6 shadow-sm rounded-2xl border border-slate-200">
        <h3 className="text-lg font-bold text-slate-800 mb-6 flex items-center">
          <div className="w-2 h-6 bg-indigo-500 rounded-sm mr-3"></div>
          Activité Récente (7 derniers jours)
        </h3>
        <div className="h-80 w-full">
          {isClient && dashboardData.graphData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dashboardData.graphData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" stroke="#94a3b8" tick={{ fill: '#94a3b8', fontSize: 12, fontWeight: 500 }} axisLine={false} tickLine={false} dy={10} />
                <YAxis stroke="#94a3b8" tick={{ fill: '#94a3b8', fontSize: 12, fontWeight: 500 }} axisLine={false} tickLine={false} dx={-10} />
                <Tooltip 
                  contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)', fontWeight: 'bold' }}
                  cursor={{ stroke: '#e2e8f0', strokeWidth: 2 }}
                />
                <Line type="monotone" dataKey="logins" stroke="#4f46e5" strokeWidth={4} dot={{ r: 5, fill: '#fff', strokeWidth: 3 }} activeDot={{ r: 8, stroke: '#818cf8', strokeWidth: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400">
              {isClient ? "Aucune donnée d'activité disponible" : "Chargement..."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}