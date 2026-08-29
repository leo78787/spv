import { useState, useEffect, useCallback } from 'react';
import { useStore, getAuthToken } from '../store';
import { SwapOffer, SwapMatch, ShiftType } from '../types';
import { ArrowLeftRight, Check, X, RefreshCw, Clock, AlertCircle, UserCheck, AlertTriangle, ChevronDown, ChevronUp, Undo2, RotateCw } from 'lucide-react';

const SHIFT_NAMES: Record<ShiftType, string> = {
  fruehschicht: 'Frühschicht (WE)',
  verschieben: 'Verschobene Schicht',
  nachtbereitschaft: 'Nachtbereitschaft',
};

function formatDate(d: string | Date): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

interface SwapData {
  offers: SwapOffer[];
  matches: SwapMatch[];
}

export function SwapManagement() {
  const { employees, departments, swapSettings, adminRole } = useStore();
  const canEdit = adminRole !== 'betrachter';
  const [data, setData] = useState<SwapData>({ offers: [], matches: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'matches' | 'offers'>('matches');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // Violation checking state per match
  const [matchViolations, setMatchViolations] = useState<Record<string, string[] | null>>({});
  const [violationsLoading, setViolationsLoading] = useState<Record<string, boolean>>({});
  // Confirmation modal for matches with violations
  const [confirmModal, setConfirmModal] = useState<{ matchId: string; violations: string[] } | null>(null);
  // Expanded completed matches
  const [expandedCompleted, setExpandedCompleted] = useState<Set<string>>(new Set());
  // Undo confirmation modal
  const [undoModal, setUndoModal] = useState<{ matchId: string; wasApproved: boolean } | null>(null);
  const [undoLoading, setUndoLoading] = useState(false);

  const fetchSwaps = useCallback(async () => {
    try {
      const token = getAuthToken();
      const resp = await fetch('/api/swaps', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error('Fehler beim Laden');
      const json = await resp.json();
      setData({ offers: json.offers || [], matches: json.matches || [] });
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSwaps();
    const timer = setInterval(fetchSwaps, 5000);
    return () => clearInterval(timer);
  }, [fetchSwaps]);

  // Check violations for all pending matches
  const checkViolationsForMatch = useCallback(async (matchId: string) => {
    try {
      setViolationsLoading(prev => ({ ...prev, [matchId]: true }));
      const token = getAuthToken();
      const resp = await fetch('/api/swaps/check-violations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId }),
      });
      if (resp.ok) {
        const { violations } = await resp.json();
        setMatchViolations(prev => ({ ...prev, [matchId]: violations || [] }));
      }
    } catch {
      // ignore
    } finally {
      setViolationsLoading(prev => ({ ...prev, [matchId]: false }));
    }
  }, []);

  // Auto-check violations for pending matches
  useEffect(() => {
    const pending = data.matches.filter(m => m.status === 'pending');
    for (const match of pending) {
      if (matchViolations[match.id] === undefined && !violationsLoading[match.id]) {
        checkViolationsForMatch(match.id);
      }
    }
  }, [data.matches, matchViolations, violationsLoading, checkViolationsForMatch]);

  const handleScan = async () => {
    const token = getAuthToken();
    await fetch('/api/swaps/scan', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    fetchSwaps();
  };

  const handleResolve = async (matchId: string, action: 'approve' | 'reject') => {
    // When approving with known violations, show confirmation modal
    if (action === 'approve') {
      const violations = matchViolations[matchId];
      if (violations && violations.length > 0) {
        setConfirmModal({ matchId, violations });
        return;
      }
    }

    await executeResolve(matchId, action);
  };

  const executeResolve = async (matchId: string, action: 'approve' | 'reject') => {
    setConfirmModal(null);
    setActionLoading(matchId);
    try {
      const token = getAuthToken();
      const resp = await fetch('/api/swaps/resolve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId, action }),
      });
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        alert(d.error || 'Fehler');
      }
      // Clear cached violations for this match
      setMatchViolations(prev => {
        const next = { ...prev };
        delete next[matchId];
        return next;
      });
      fetchSwaps();
    } finally {
      setActionLoading(null);
    }
  };

  const handleUndo = async (matchId: string) => {
    setUndoModal(null);
    setUndoLoading(true);
    try {
      const token = getAuthToken();
      const resp = await fetch('/api/swaps/undo', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId }),
      });
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        alert(d.error || 'Fehler beim Rückgängig machen');
      }
      fetchSwaps();
    } finally {
      setUndoLoading(false);
    }
  };

  const getEmployee = (id: string) => employees.find(e => e.id === id);
  const getDepartment = (deptId: string) => departments.find(d => d.id === deptId);

  const pendingMatches = data.matches.filter(m => m.status === 'pending');
  const resolvedMatches = data.matches.filter(m => m.status !== 'pending');
  const openOffers = data.offers.filter(o => o.status === 'open');

  if (loading) {
    return (
      <div className="p-6 text-gray-500 text-center">Lade Tauschangebote…</div>
    );
  }

  return (
    <div className="p-3 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-gray-800">Schichttausch</h2>
          <p className="text-sm text-gray-500 mt-1">
            {swapSettings.onlyWithinDepartment && 'Nur innerhalb der Abteilung · '}
            {swapSettings.onlyWithinShiftType && 'Nur gleicher Schichttyp · '}
            {swapSettings.allowRingSwap && 'Ringtausch aktiv · '}
            {!swapSettings.onlyWithinDepartment && !swapSettings.onlyWithinShiftType && !swapSettings.allowRingSwap && 'Alle Tauschoptionen erlaubt · '}
            {openOffers.length} offene Angebote · {pendingMatches.length} ausstehende Matches
          </p>
        </div>
        {canEdit && (
        <button
          onClick={handleScan}
          className="flex items-center gap-2 bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors"
        >
          <RefreshCw size={16} />
          Matches suchen
        </button>
        )}
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 p-3 rounded-lg mb-4 flex items-center gap-2">
          <AlertCircle size={16} />{error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b mb-4">
        <button
          onClick={() => setTab('matches')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'matches' ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Matches ({pendingMatches.length} ausstehend)
        </button>
        <button
          onClick={() => setTab('offers')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'offers' ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Alle Angebote ({openOffers.length} offen)
        </button>
      </div>

      {/* Matches Tab */}
      {tab === 'matches' && (
        <div className="space-y-4">
          {pendingMatches.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <ArrowLeftRight className="mx-auto mb-3" size={48} />
              <p>Noch keine Matches gefunden.</p>
              <p className="text-sm mt-1">Matches werden automatisch erkannt, wenn zwei Angebote kompatibel sind.</p>
            </div>
          )}

          {pendingMatches.map(match => {
            const isRing = match.ringOffers && match.ringOffers.length >= 3;
            const violations = matchViolations[match.id];
            const isCheckingViolations = violationsLoading[match.id];

            if (isRing) {
              // ── Ring swap match ──
              const ringOffers = match.ringOffers!.map(id => data.offers.find(o => o.id === id)).filter(Boolean) as SwapOffer[];
              if (ringOffers.length < 3) return null;

              return (
                <div key={match.id} className="bg-white rounded-lg shadow-md p-5 border-l-4 border-purple-500">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <RotateCw size={20} className="text-purple-600" />
                      <span className="font-semibold text-purple-600">Ringtausch ({ringOffers.length} Mitarbeiter)</span>
                    </div>
                    <span className="text-xs text-gray-400">{formatDate(match.createdAt)}</span>
                  </div>

                  {/* Ring visualization */}
                  <div className="space-y-2 mb-4">
                    {ringOffers.map((offer, idx) => {
                      const emp = getEmployee(offer.employeeId);
                      const dept = emp ? getDepartment(emp.department) : null;
                      const nextOffer = ringOffers[(idx + 1) % ringOffers.length];
                      const nextEmp = getEmployee(nextOffer.employeeId);
                      return (
                        <div key={offer.id} className="bg-gray-50 rounded-lg p-3 flex items-center gap-3">
                          <div className="flex-1">
                            <p className="font-medium text-gray-900">{emp?.name || 'Unbekannt'}</p>
                            <p className="text-xs text-gray-500">{dept?.name || '—'}</p>
                            <div className="mt-1 text-sm">
                              <span className="font-medium text-red-600">Gibt ab: </span>
                              <span>{SHIFT_NAMES[offer.shiftType as ShiftType] || offer.shiftType}</span>
                              <span className="text-gray-400 ml-1 text-xs">({formatDate(offer.startDate)} – {formatDate(offer.endDate)})</span>
                            </div>
                          </div>
                          <div className="text-purple-500 text-sm font-medium whitespace-nowrap">
                            → {nextEmp?.name || '?'}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Violations */}
                  {isCheckingViolations && (
                    <div className="mb-3 text-xs text-gray-400 flex items-center gap-1">
                      <RefreshCw size={12} className="animate-spin" /> Prüfe Regelverstöße…
                    </div>
                  )}
                  {violations && violations.length > 0 && (
                    <div className="mb-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
                      <div className="flex items-center gap-2 text-amber-700 font-medium text-sm mb-1">
                        <AlertTriangle size={16} />
                        Regelverstoß bei Genehmigung
                      </div>
                      <ul className="text-xs text-amber-600 space-y-0.5 ml-6 list-disc">
                        {violations.map((v, i) => <li key={i}>{v}</li>)}
                      </ul>
                    </div>
                  )}
                  {violations && violations.length === 0 && (
                    <div className="mb-3 text-xs text-green-600 flex items-center gap-1">
                      <Check size={12} /> Keine Regelverstöße
                    </div>
                  )}

                  <div className="flex justify-end gap-2">
                    <button
                      disabled={actionLoading === match.id || !canEdit}
                      onClick={() => handleResolve(match.id, 'reject')}
                      className="flex items-center gap-1 px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
                    >
                      <X size={16} /> Ablehnen
                    </button>
                    <button
                      disabled={actionLoading === match.id || !canEdit}
                      onClick={() => handleResolve(match.id, 'approve')}
                      className="flex items-center gap-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
                    >
                      <Check size={16} /> Bestätigen
                    </button>
                  </div>
                </div>
              );
            }

            if (match.takeoverEmployeeId) {
              // ── Direct takeover match (no counter-offer) ──
              const offerA = data.offers.find(o => o.id === match.offerA);
              if (!offerA) return null;

              const giver = getEmployee(offerA.employeeId);
              const taker = getEmployee(match.takeoverEmployeeId);
              const deptGiver = giver ? getDepartment(giver.department) : null;
              const deptTaker = taker ? getDepartment(taker.department) : null;

              return (
                <div key={match.id} className="bg-white rounded-lg shadow-md p-5 border-l-4 border-teal-500">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <UserCheck size={20} className="text-teal-600" />
                      <span className="font-semibold text-teal-600">Direktübernahme (ohne Gegenleistung)</span>
                    </div>
                    <span className="text-xs text-gray-400">{formatDate(match.createdAt)}</span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div className="bg-gray-50 rounded-lg p-3">
                      <p className="font-medium text-gray-900">{giver?.name || 'Unbekannt'}</p>
                      <p className="text-xs text-gray-500">{deptGiver?.name || '—'}</p>
                      <div className="mt-2 text-sm">
                        <span className="font-medium text-red-600">Gibt ab: </span>
                        <span>{SHIFT_NAMES[offerA.shiftType as ShiftType] || offerA.shiftType}</span>
                        <br />
                        <span className="text-gray-500">{formatDate(offerA.startDate)} – {formatDate(offerA.endDate)}</span>
                      </div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3">
                      <p className="font-medium text-gray-900">{taker?.name || 'Unbekannt'}</p>
                      <p className="text-xs text-gray-500">{deptTaker?.name || '—'}</p>
                      <div className="mt-2 text-sm">
                        <span className="font-medium text-teal-600">Möchte übernehmen</span>
                        <br />
                        <span className="text-gray-500">ohne Gegenleistung</span>
                      </div>
                    </div>
                  </div>

                  {/* Inline violation warnings */}
                  {isCheckingViolations && (
                    <div className="mb-3 text-xs text-gray-400 flex items-center gap-1">
                      <RefreshCw size={12} className="animate-spin" /> Prüfe Regelverstöße…
                    </div>
                  )}
                  {violations && violations.length > 0 && (
                    <div className="mb-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
                      <div className="flex items-center gap-2 text-amber-700 font-medium text-sm mb-1">
                        <AlertTriangle size={16} />
                        Regelverstoß bei Genehmigung
                      </div>
                      <ul className="text-xs text-amber-600 space-y-0.5 ml-6 list-disc">
                        {violations.map((v, i) => <li key={i}>{v}</li>)}
                      </ul>
                    </div>
                  )}
                  {violations && violations.length === 0 && (
                    <div className="mb-3 text-xs text-green-600 flex items-center gap-1">
                      <Check size={12} /> Keine Regelverstöße
                    </div>
                  )}

                  <div className="flex justify-end gap-2">
                    <button
                      disabled={actionLoading === match.id || !canEdit}
                      onClick={() => handleResolve(match.id, 'reject')}
                      className="flex items-center gap-1 px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
                    >
                      <X size={16} /> Ablehnen
                    </button>
                    <button
                      disabled={actionLoading === match.id || !canEdit}
                      onClick={() => handleResolve(match.id, 'approve')}
                      className="flex items-center gap-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
                    >
                      <Check size={16} /> Bestätigen
                    </button>
                  </div>
                </div>
              );
            }

            // ── Direct swap match ──
            const offerA = data.offers.find(o => o.id === match.offerA);
            const offerB = data.offers.find(o => o.id === match.offerB);
            if (!offerA || !offerB) return null;

            const empA = getEmployee(offerA.employeeId);
            const empB = getEmployee(offerB.employeeId);
            const deptA = empA ? getDepartment(empA.department) : null;
            const deptB = empB ? getDepartment(empB.department) : null;

            return (
              <div key={match.id} className="bg-white rounded-lg shadow-md p-5 border-l-4 border-primary-500">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <UserCheck size={20} className="text-primary-600" />
                    <span className="font-semibold text-primary-600">Match gefunden</span>
                  </div>
                  <span className="text-xs text-gray-400">{formatDate(match.createdAt)}</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="font-medium text-gray-900">{empA?.name || 'Unbekannt'}</p>
                    <p className="text-xs text-gray-500">{deptA?.name || '—'}</p>
                    <div className="mt-2 text-sm">
                      <span className="font-medium text-red-600">Gibt ab: </span>
                      <span>{SHIFT_NAMES[offerA.shiftType as ShiftType] || offerA.shiftType}</span>
                      <br />
                      <span className="text-gray-500">{formatDate(offerA.startDate)} – {formatDate(offerA.endDate)}</span>
                    </div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="font-medium text-gray-900">{empB?.name || 'Unbekannt'}</p>
                    <p className="text-xs text-gray-500">{deptB?.name || '—'}</p>
                    <div className="mt-2 text-sm">
                      <span className="font-medium text-red-600">Gibt ab: </span>
                      <span>{SHIFT_NAMES[offerB.shiftType as ShiftType] || offerB.shiftType}</span>
                      <br />
                      <span className="text-gray-500">{formatDate(offerB.startDate)} – {formatDate(offerB.endDate)}</span>
                    </div>
                  </div>
                </div>

                {/* Inline violation warnings */}
                {isCheckingViolations && (
                  <div className="mb-3 text-xs text-gray-400 flex items-center gap-1">
                    <RefreshCw size={12} className="animate-spin" /> Prüfe Regelverstöße…
                  </div>
                )}
                {violations && violations.length > 0 && (
                  <div className="mb-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
                    <div className="flex items-center gap-2 text-amber-700 font-medium text-sm mb-1">
                      <AlertTriangle size={16} />
                      Regelverstoß bei Genehmigung
                    </div>
                    <ul className="text-xs text-amber-600 space-y-0.5 ml-6 list-disc">
                      {violations.map((v, i) => <li key={i}>{v}</li>)}
                    </ul>
                  </div>
                )}
                {violations && violations.length === 0 && (
                  <div className="mb-3 text-xs text-green-600 flex items-center gap-1">
                    <Check size={12} /> Keine Regelverstöße
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    disabled={actionLoading === match.id || !canEdit}
                    onClick={() => handleResolve(match.id, 'reject')}
                    className="flex items-center gap-1 px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
                  >
                    <X size={16} /> Ablehnen
                  </button>
                  <button
                    disabled={actionLoading === match.id || !canEdit}
                    onClick={() => handleResolve(match.id, 'approve')}
                    className="flex items-center gap-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
                  >
                    <Check size={16} /> Bestätigen
                  </button>
                </div>
              </div>
            );
          })}

          {resolvedMatches.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-gray-500 mb-2 uppercase tracking-wider">Abgeschlossene Matches</h3>
              <div className="space-y-2">
                {resolvedMatches.map(match => {
                  const isRingMatch = match.ringOffers && match.ringOffers.length >= 3;

                  if (isRingMatch) {
                    const isExpanded = expandedCompleted.has(match.id);
                    const ringOffers = match.ringOffers!.map(id => data.offers.find(o => o.id === id)).filter(Boolean) as SwapOffer[];
                    const ringEmps = ringOffers.map(o => getEmployee(o.employeeId));
                    const names = ringEmps.map(e => e?.name || '?').join(' → ');

                    return (
                      <div key={match.id} className={`bg-white rounded-lg border transition-all ${match.status === 'approved' ? 'border-green-200' : 'border-red-200'}`}>
                        <button
                          onClick={() => setExpandedCompleted(prev => {
                            const next = new Set(prev);
                            if (next.has(match.id)) next.delete(match.id); else next.add(match.id);
                            return next;
                          })}
                          className="w-full p-3 flex items-center justify-between text-left hover:bg-gray-50 rounded-lg transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            <RotateCw size={14} className="text-purple-500" />
                            <span className="text-sm">{names}</span>
                            <span className={`text-xs font-medium px-2 py-0.5 rounded ${match.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                              {match.status === 'approved' ? 'Genehmigt' : 'Abgelehnt'}
                            </span>
                          </div>
                          {isExpanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                        </button>
                        {isExpanded && (
                          <div className="px-3 pb-3 border-t border-gray-100 pt-3">
                            <div className="space-y-2">
                              {ringOffers.map((offer, idx) => {
                                const emp = getEmployee(offer.employeeId);
                                const dept = emp ? getDepartment(emp.department) : null;
                                const nextEmp = getEmployee(ringOffers[(idx + 1) % ringOffers.length].employeeId);
                                return (
                                  <div key={offer.id} className="bg-gray-50 rounded-lg p-3 flex items-center gap-3">
                                    <div className="flex-1">
                                      <p className="font-medium text-gray-900 text-sm">{emp?.name || 'Unbekannt'}</p>
                                      <p className="text-xs text-gray-500">{dept?.name || '—'}</p>
                                      <div className="mt-1 text-xs text-gray-600">
                                        <span className="font-medium">Schicht:</span> {SHIFT_NAMES[offer.shiftType as ShiftType] || offer.shiftType}
                                        <span className="text-gray-400 ml-1">({formatDate(offer.startDate)} – {formatDate(offer.endDate)})</span>
                                      </div>
                                    </div>
                                    <div className="text-purple-500 text-xs font-medium whitespace-nowrap">→ {nextEmp?.name || '?'}</div>
                                  </div>
                                );
                              })}
                            </div>
                            {match.resolvedAt && (
                              <p className="text-xs text-gray-400 mt-2">
                                {match.status === 'approved' ? 'Genehmigt' : 'Abgelehnt'} am {formatDate(match.resolvedAt)}
                              </p>
                            )}
                            <div className="flex justify-end mt-3">
                              <button
                                disabled={undoLoading || !canEdit}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setUndoModal({ matchId: match.id, wasApproved: match.status === 'approved' });
                                }}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-amber-300 text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100 transition-colors disabled:opacity-50"
                              >
                                <Undo2 size={14} />
                                Rückgängig
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  }

                  if (match.takeoverEmployeeId) {
                    // Direct takeover resolved match
                    const offerA = data.offers.find(o => o.id === match.offerA);
                    const giver = offerA ? getEmployee(offerA.employeeId) : null;
                    const taker = getEmployee(match.takeoverEmployeeId);
                    const deptGiver = giver ? getDepartment(giver.department) : null;
                    const deptTaker = taker ? getDepartment(taker.department) : null;
                    const isExpanded = expandedCompleted.has(match.id);

                    return (
                      <div key={match.id} className={`bg-white rounded-lg border transition-all ${match.status === 'approved' ? 'border-green-200' : 'border-red-200'}`}>
                        <button
                          onClick={() => setExpandedCompleted(prev => {
                            const next = new Set(prev);
                            if (next.has(match.id)) next.delete(match.id); else next.add(match.id);
                            return next;
                          })}
                          className="w-full p-3 flex items-center justify-between text-left hover:bg-gray-50 rounded-lg transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-sm">
                              {giver?.name || '?'} → {taker?.name || '?'} (Übernahme)
                            </span>
                            <span className={`text-xs font-medium px-2 py-0.5 rounded ${match.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                              {match.status === 'approved' ? 'Genehmigt' : 'Abgelehnt'}
                            </span>
                          </div>
                          {isExpanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                        </button>
                        {isExpanded && offerA && (
                          <div className="px-3 pb-3 border-t border-gray-100 pt-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div className="bg-gray-50 rounded-lg p-3">
                                <p className="font-medium text-gray-900 text-sm">{giver?.name || 'Unbekannt'}</p>
                                <p className="text-xs text-gray-500">{deptGiver?.name || '—'}</p>
                                <div className="mt-1.5 text-xs text-gray-600">
                                  <span className="font-medium">Gab ab:</span> {SHIFT_NAMES[offerA.shiftType as ShiftType] || offerA.shiftType}
                                  <br />
                                  <span className="text-gray-400">{formatDate(offerA.startDate)} – {formatDate(offerA.endDate)}</span>
                                </div>
                              </div>
                              <div className="bg-gray-50 rounded-lg p-3">
                                <p className="font-medium text-gray-900 text-sm">{taker?.name || 'Unbekannt'}</p>
                                <p className="text-xs text-gray-500">{deptTaker?.name || '—'}</p>
                                <div className="mt-1.5 text-xs text-gray-600">
                                  <span className="font-medium">Übernahme ohne Gegenleistung</span>
                                </div>
                              </div>
                            </div>
                            {match.resolvedAt && (
                              <p className="text-xs text-gray-400 mt-2">
                                {match.status === 'approved' ? 'Genehmigt' : 'Abgelehnt'} am {formatDate(match.resolvedAt)}
                              </p>
                            )}
                            <div className="flex justify-end mt-3">
                              <button
                                disabled={undoLoading || !canEdit}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setUndoModal({ matchId: match.id, wasApproved: match.status === 'approved' });
                                }}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-amber-300 text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100 transition-colors disabled:opacity-50"
                              >
                                <Undo2 size={14} />
                                Rückgängig
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  }

                  // Direct swap resolved match
                  const offerA = data.offers.find(o => o.id === match.offerA);
                  const offerB = data.offers.find(o => o.id === match.offerB);
                  const empA = offerA ? getEmployee(offerA.employeeId) : null;
                  const empB = offerB ? getEmployee(offerB.employeeId) : null;
                  const deptA = empA ? getDepartment(empA.department) : null;
                  const deptB = empB ? getDepartment(empB.department) : null;
                  const isExpanded = expandedCompleted.has(match.id);

                  return (
                    <div key={match.id} className={`bg-white rounded-lg border transition-all ${match.status === 'approved' ? 'border-green-200' : 'border-red-200'}`}>
                      <button
                        onClick={() => setExpandedCompleted(prev => {
                          const next = new Set(prev);
                          if (next.has(match.id)) next.delete(match.id); else next.add(match.id);
                          return next;
                        })}
                        className="w-full p-3 flex items-center justify-between text-left hover:bg-gray-50 rounded-lg transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm">
                            {empA?.name || '?'} ↔ {empB?.name || '?'}
                          </span>
                          <span className={`text-xs font-medium px-2 py-0.5 rounded ${match.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {match.status === 'approved' ? 'Genehmigt' : 'Abgelehnt'}
                          </span>
                        </div>
                        {isExpanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                      </button>
                      {isExpanded && offerA && offerB && (
                        <div className="px-3 pb-3 border-t border-gray-100 pt-3">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="bg-gray-50 rounded-lg p-3">
                              <p className="font-medium text-gray-900 text-sm">{empA?.name || 'Unbekannt'}</p>
                              <p className="text-xs text-gray-500">{deptA?.name || '—'}</p>
                              <div className="mt-1.5 text-xs text-gray-600">
                                <span className="font-medium">Schicht:</span> {SHIFT_NAMES[offerA.shiftType as ShiftType] || offerA.shiftType}
                                <br />
                                <span className="text-gray-400">{formatDate(offerA.startDate)} – {formatDate(offerA.endDate)}</span>
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-lg p-3">
                              <p className="font-medium text-gray-900 text-sm">{empB?.name || 'Unbekannt'}</p>
                              <p className="text-xs text-gray-500">{deptB?.name || '—'}</p>
                              <div className="mt-1.5 text-xs text-gray-600">
                                <span className="font-medium">Schicht:</span> {SHIFT_NAMES[offerB.shiftType as ShiftType] || offerB.shiftType}
                                <br />
                                <span className="text-gray-400">{formatDate(offerB.startDate)} – {formatDate(offerB.endDate)}</span>
                              </div>
                            </div>
                          </div>
                          {match.resolvedAt && (
                            <p className="text-xs text-gray-400 mt-2">
                              {match.status === 'approved' ? 'Genehmigt' : 'Abgelehnt'} am {formatDate(match.resolvedAt)}
                            </p>
                          )}
                          <div className="flex justify-end mt-3">
                            <button
                              disabled={undoLoading || !canEdit}
                              onClick={(e) => {
                                e.stopPropagation();
                                setUndoModal({ matchId: match.id, wasApproved: match.status === 'approved' });
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-amber-300 text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100 transition-colors disabled:opacity-50"
                            >
                              <Undo2 size={14} />
                              Rückgängig
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Offers Tab */}
      {tab === 'offers' && (
        <div className="space-y-3">
          {data.offers.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <Clock className="mx-auto mb-3" size={48} />
              <p>Noch keine Tauschangebote von Mitarbeitern.</p>
              <p className="text-sm mt-1">Mitarbeiter können nach Freigabe des Schichtplans Schichten zum Tausch anbieten.</p>
            </div>
          )}

          {data.offers.map(offer => {
            const emp = getEmployee(offer.employeeId);
            const dept = emp ? getDepartment(emp.department) : null;

            return (
              <div key={offer.id} className={`bg-white rounded-lg p-4 shadow-sm border ${offer.status === 'open' ? 'border-blue-200' : offer.status === 'matched' ? 'border-green-200' : 'border-gray-200'}`}>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <span className="font-medium">{emp?.name || 'Unbekannt'}</span>
                    <span className="text-xs text-gray-500 ml-2">{dept?.name || ''}</span>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                    offer.status === 'open' ? 'bg-blue-100 text-blue-700' :
                    offer.status === 'matched' ? 'bg-green-100 text-green-700' :
                    'bg-gray-100 text-gray-500'
                  }`}>
                    {offer.status === 'open' ? 'Offen' : offer.status === 'matched' ? 'Getauscht' : 'Zurückgezogen'}
                  </span>
                </div>
                <div className="text-sm text-gray-600">
                  <span className="font-medium">Bietet an:</span> {SHIFT_NAMES[offer.shiftType as ShiftType] || offer.shiftType}
                  {' '}({formatDate(offer.startDate)} – {formatDate(offer.endDate)})
                </div>
                {offer.willingRanges && offer.willingRanges.length > 0 && (
                  <div className="text-sm text-gray-500 mt-1">
                    <span className="font-medium">Bereit für Zeitraum:</span>{' '}
                    {offer.willingRanges.map((r, i) => (
                      <span key={i}>
                        {formatDate(r.startDate)} – {formatDate(r.endDate)}
                        {i < offer.willingRanges.length - 1 ? ', ' : ''}
                      </span>
                    ))}
                  </div>
                )}
                {offer.willingShiftTypes && !swapSettings.onlyWithinShiftType && (
                  <div className="text-sm text-gray-500 mt-1">
                    <span className="font-medium">Akzeptiert Typen:</span>{' '}
                    {offer.willingShiftTypes.map(t => SHIFT_NAMES[t] || t).join(', ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Violation confirmation modal */}
      {confirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
            <div className="flex items-center gap-2 text-amber-600 mb-3">
              <AlertTriangle size={24} />
              <h3 className="font-bold text-lg">Regelverstoß</h3>
            </div>
            <p className="text-sm text-gray-700 mb-3">
              Durch diesen Tausch entstehen folgende Regelverstöße:
            </p>
            <ul className="text-sm text-amber-700 bg-amber-50 rounded-lg p-3 space-y-1 mb-4 list-disc ml-4">
              {confirmModal.violations.map((v, i) => <li key={i}>{v}</li>)}
            </ul>
            <p className="text-sm text-gray-600 mb-4">Möchten Sie den Tausch trotzdem genehmigen?</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmModal(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Abbrechen
              </button>
              <button
                onClick={() => executeResolve(confirmModal.matchId, 'approve')}
                className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors"
              >
                Trotzdem genehmigen
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Undo confirmation modal */}
      {undoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
            <div className="flex items-center gap-2 text-amber-600 mb-3">
              <AlertTriangle size={24} />
              <h3 className="font-bold text-lg">Match rückgängig machen?</h3>
            </div>
            {undoModal.wasApproved ? (
              <>
                <p className="text-sm text-gray-700 mb-3">
                  Dieser Tausch wurde bereits <strong>genehmigt und ausgeführt</strong>. Die Schichtzuweisungen im Plan werden zurückgetauscht.
                </p>
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
                  <p className="text-sm text-red-700 font-medium">⚠ Achtung:</p>
                  <ul className="text-xs text-red-600 mt-1 space-y-1 list-disc ml-4">
                    <li>Die Schichtzuweisungen werden im Plan zurückgesetzt</li>
                    <li>Falls der Plan bereits freigegeben ist, sehen die Mitarbeiter sofort den alten Zustand</li>
                    <li>Alle Tauschangebote werden wieder als &quot;offen&quot; markiert</li>
                  </ul>
                </div>
              </>
            ) : (
              <p className="text-sm text-gray-700 mb-4">
                Die Ablehnung wird zurückgenommen und der Match wird wieder als &quot;ausstehend&quot; angezeigt.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setUndoModal(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Abbrechen
              </button>
              <button
                onClick={() => handleUndo(undoModal.matchId)}
                className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors"
              >
                Rückgängig machen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
