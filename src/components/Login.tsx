import React, { useState } from 'react';
import { setAuthToken, getAuthToken } from '../store';

type Props = {
  onSuccess: () => void;
};

export function Login({ onSuccess }: Props) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Forced password change for newly invited admin accounts (mustChangePassword)
  const [needsPasswordChange, setNeedsPasswordChange] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  const isEmail = identifier.includes('@');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      // Personal accounts (Leitung/Manager) log in by email; the legacy
      // shared fallback login ("spm2026") uses the plain username field.
      const url = isEmail ? '/api/admin/login' : '/api/login';
      const body = isEmail ? { email: identifier, password } : { username: identifier, password };
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      setLoading(false);

      if ((data.success || resp.ok) && data.token) {
        setAuthToken(data.token);
        if (data.mustChangePassword) {
          setNeedsPasswordChange(true);
        } else {
          onSuccess();
        }
      } else {
        setError(data.message || data.error || 'Ungültige Anmeldedaten.');
      }
    } catch {
      setLoading(false);
      setError('Verbindungsfehler — Server nicht erreichbar.');
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 6) { setError('Passwort muss mindestens 6 Zeichen haben.'); return; }
    if (newPassword !== newPasswordConfirm) { setError('Passwörter stimmen nicht überein.'); return; }

    setChangingPassword(true);
    try {
      const token = getAuthToken();
      const resp = await fetch('/api/admin/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ newPassword }),
      });
      setChangingPassword(false);
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setError(data.error || 'Fehler beim Ändern des Passworts.');
        return;
      }
      onSuccess();
    } catch {
      setChangingPassword(false);
      setError('Verbindungsfehler — Server nicht erreichbar.');
    }
  };

  if (needsPasswordChange) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 p-4">
        <form onSubmit={handleChangePassword} className="w-full max-w-md bg-white shadow-md rounded-lg p-6">
          <h2 className="text-2xl font-bold mb-2 text-gray-900">Neues Passwort vergeben</h2>
          <p className="text-sm text-gray-600 mb-4">Bitte vergeben Sie ein neues Passwort, um fortzufahren.</p>

          {error && <div className="mb-3 text-sm text-rose-700 bg-rose-50 border border-rose-100 p-2 rounded">{error}</div>}

          <div className="mb-3">
            <label className="text-xs text-gray-600">Neues Passwort (min. 6 Zeichen)</label>
            <input
              type="password"
              autoFocus
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div className="mb-4">
            <label className="text-xs text-gray-600">Passwort bestätigen</label>
            <input
              type="password"
              value={newPasswordConfirm}
              onChange={e => setNewPasswordConfirm(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          <button
            type="submit"
            disabled={changingPassword}
            className="w-full px-4 py-2 bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-60"
          >
            {changingPassword ? 'Wird gespeichert…' : 'Passwort setzen'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-md bg-white shadow-md rounded-lg p-6">
        <h2 className="text-2xl font-bold mb-2 text-gray-900">Schichtplan Manager — Login</h2>
        <p className="text-sm text-gray-600 mb-4">Bitte melden Sie sich an, um auf den Schichtplan Manager zuzugreifen.</p>

        {error && <div className="mb-3 text-sm text-rose-700 bg-rose-50 border border-rose-100 p-2 rounded">{error}</div>}

        <div className="mb-3">
          <label className="text-xs text-gray-600">Benutzername oder E-Mail</label>
          <input
            autoFocus
            value={identifier}
            onChange={e => setIdentifier(e.target.value)}
            className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
            placeholder="Benutzername oder E-Mail"
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
      </form>
      <div className="absolute bottom-6 left-0 right-0 text-center text-xs text-gray-400">
        <p>Schichtplan Manager &copy; 2026</p>
        <p className="mt-1"><a href="https://schichtapp.de/impressum.html?from=admin" className="text-gray-500 underline hover:text-gray-700">Impressum</a></p>
      </div>
    </div>
  );
}
