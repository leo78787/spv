import React, { useState } from 'react';
import { setAuthToken } from '../store';

type Props = {
  onSuccess: () => void;
};

export function Login({ onSuccess }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const resp = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await resp.json();
      setLoading(false);

      if (data.success && data.token) {
        setAuthToken(data.token);
        onSuccess();
      } else {
        setError(data.message || 'Ungültiger Benutzername oder Passwort.');
      }
    } catch {
      setLoading(false);
      setError('Verbindungsfehler — Server nicht erreichbar.');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-md bg-white shadow-md rounded-lg p-6">
        <h2 className="text-2xl font-bold mb-2 text-gray-900">Schichtplan Manager — Login</h2>
        <p className="text-sm text-gray-600 mb-4">Bitte melden Sie sich an, um auf den Schichtplan Manager zuzugreifen.</p>

        {error && <div className="mb-3 text-sm text-rose-700 bg-rose-50 border border-rose-100 p-2 rounded">{error}</div>}

        <div className="mb-3">
          <label className="text-xs text-gray-600">Benutzername</label>
          <input
            autoFocus
            value={username}
            onChange={e => setUsername(e.target.value)}
            className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
            placeholder="Benutzername"
          />
        </div>

        <div className="mb-4">
          <label className="text-xs text-gray-600">Passwort</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
            placeholder="Passwort"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-60"
          >
            {loading ? 'Anmeldung...' : 'Anmelden'}
          </button>
          <div className="text-xs text-gray-500">Kontakt: Admin, falls Probleme auftreten.</div>
        </div>

        <div className="mt-4 text-xs text-gray-400">Hinweis: Demo‑Anmeldung erforderlich, Username & Passwort sind vorab bekannt.</div>
      </form>
    </div>
  );
}
