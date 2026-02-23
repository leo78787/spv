import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Calendar, Users, AlertCircle, Sparkles, Download, Settings, ChevronDown, ChevronUp, AlertTriangle, Loader2, Zap, Scale } from 'lucide-react';
import { useStore, getAuthToken } from '../store';
import { DEFAULT_SCHEDULER_CONFIG, SchedulerConfig } from '../utils/scheduler';
import { SHIFT_LABELS } from '../types';
import { getMonthName, generateId, reviveImportedPlan } from '../utils/helpers';
import ViolationPipeline from './ViolationPipeline';
import { ImpactFactors, ImpactDelta, CountImpact, FairnessScores } from '../utils/fairnessImpact';
import {
  getOptimiserState,
  subscribeOptimiser,
  startOptimisation,
  cancelOptimisation,
  checkAndResumeOptimisation,
  setMaxIterations,
  setTargets,
  calibrate,
  type OptimiserManagerState,
} from '../services/optimiserManager';

// Module-level cache so preview survives component unmounts (tab switches)
let moduleCachedImpactSnapshot: string | null = null;
let moduleCachedImpactFactors: ImpactFactors | null = null;
// Persist schedulerConfig edits while the user navigates away so the component
// can restore the in-progress settings and continue computing when remounted.
let moduleCachedSchedulerConfig: SchedulerConfig | null = null;

// Module-level fairness computation via server API
let moduleFairnessAbort: AbortController | null = null;
let moduleFairnessRequestId = 0;
const moduleFairnessListeners = new Set<(msg: { id: number; result?: ImpactFactors; error?: string; snapshot?: string }) => void>();

function postModuleFairnessRequest(payload: { employees: any; schedulerConfig: any; year: number; startMonth: number }, snapshot: string): number {
  const id = ++moduleFairnessRequestId;
  const token = getAuthToken();

  // Cancel any previous in-flight request
  if (moduleFairnessAbort) moduleFairnessAbort.abort();
  moduleFairnessAbort = new AbortController();

  fetch('/api/fairness', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      employees: payload.employees,
      config: payload.schedulerConfig,
      year: payload.year,
      startMonth: payload.startMonth,
    }),
    signal: moduleFairnessAbort.signal,
  })
    .then(async (resp) => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = await resp.json();
      // Update module cache
      moduleCachedImpactFactors = result;
      moduleCachedImpactSnapshot = snapshot;
      for (const l of moduleFairnessListeners) l({ id, result, snapshot });
    })
    .catch((err) => {
      if (err.name === 'AbortError') return;
      for (const l of moduleFairnessListeners) l({ id, error: String(err), snapshot });
    });

  return id;
}

const fmt = (v: number) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
const badgeCls = (v: number) =>
  v > 0.4  ? 'text-green-700 bg-green-50 border-green-200' :
  v < -0.4 ? 'text-red-700 bg-red-50 border-red-200' :
  'text-gray-500 bg-gray-50 border-gray-200';

/** One row of 4 fairness delta badges, each showing “delta → result%” */
function ImpactBadges({
  d, baseline, loading,
}: {
  d: ImpactDelta | undefined;
  baseline?: FairnessScores;
  loading: boolean;
}) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-400">
        <Loader2 size={10} className="animate-spin" /> Berechne…
      </span>
    );
  }
  if (!d) return null;
  const metrics: { label: string; key: keyof ImpactDelta & keyof FairnessScores }[] = [
    { label: 'Gesamt',   key: 'overall' },
    { label: 'Versetzt', key: 'verschieben' },
    { label: 'Nacht',    key: 'nacht' },
    { label: 'Früh/WE', key: 'frueh' },
  ];
  return (
    <div className="flex gap-1 flex-wrap">
      {metrics.map(({ label, key }) => {
        const dv     = d[key];
        const result = baseline != null ? baseline[key] + dv : null;
        return (
          <span key={key} className={`text-xs px-1.5 py-0.5 rounded border ${badgeCls(dv)}`}>
            {label}: {fmt(dv)} %{result != null && (
              <span className="opacity-60"> → {result.toFixed(1)} %</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** +1 / -1 rows for count inputs */
function CountImpactBadges({
  ci, baseline, loading, unit = 'Person',
}: {
  ci: CountImpact | undefined;
  baseline?: FairnessScores;
  loading: boolean;
  unit?: string;
}) {
  if (loading) {
    return <span className="inline-flex items-center gap-1 text-xs text-gray-400"><Loader2 size={10} className="animate-spin" /> Berechne…</span>;
  }
  if (!ci) return null;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs font-medium text-gray-500 whitespace-nowrap">+1 {unit}</span>
        <ImpactBadges d={ci.plus}  baseline={baseline} loading={false} />
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs font-medium text-gray-500 whitespace-nowrap">−1 {unit}</span>
        <ImpactBadges d={ci.minus} baseline={baseline} loading={false} />
      </div>
    </div>
  );
}

export function ShiftPlanning() {
  const { employees, departments, shiftPlan, addEmployee, addDepartment, setShiftPlan, addLabel, addCalendarLabel, acknowledgeViolation } = useStore();
  const [selectedYear, setSelectedYear] = useState(() => shiftPlan?.year ?? new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number>(() => shiftPlan?.startMonth ?? 0);
  const [isGenerating, setIsGenerating] = useState(false);
  // Open the planning rules / shift‑counts panel by default
  const [showConfig, setShowConfig] = useState(true);
  const [showPipeline, setShowPipeline] = useState(false);
  const [schedulerConfig, setSchedulerConfig] = useState<SchedulerConfig>(
    () => moduleCachedSchedulerConfig ?? shiftPlan?.schedulerConfig ?? DEFAULT_SCHEDULER_CONFIG
  );
  // ── Optimizer state (persisted in module-level manager) ─────────────────
  const [optimiserState, setOptimiserState] = useState<OptimiserManagerState>(getOptimiserState);
  useEffect(() => subscribeOptimiser(setOptimiserState), []);

  // On page load, check if the server has a running/finished job and restore it
  useEffect(() => {
    checkAndResumeOptimisation();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { isOptimising, progress: optimiserProgress, result: optimiserResult,
          maxIterations: optimiserMaxIter, targets: optimiserTargets,
          msPerIteration } = optimiserState;

  // When the manager finishes & produces a generationMessage, sync it into
  // the local generationResult so the existing UI picks it up.
  useEffect(() => {
    if (optimiserState.generationMessage && !optimiserState.isOptimising) {
      setGenerationResult(optimiserState.generationMessage);
    }
  }, [optimiserState.generationMessage, optimiserState.isOptimising]);

  // Auto-calibrate ms/iteration when employees or config change so the
  // time estimate is available before the user starts.
  useEffect(() => {
    if (employees.length > 0 && !isOptimising) {
      calibrate(employees, schedulerConfig, selectedYear, selectedMonth);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees.length, schedulerConfig, selectedYear, selectedMonth]);

  const [generationResult, setGenerationResult] = useState<{
    success: boolean;
    message: string;
    assignmentCount: number;
  } | null>(null);

  // Modal dialog states
  const [releaseWarningOpen, setReleaseWarningOpen] = useState(false);
  const [deletePlanOpen, setDeletePlanOpen] = useState(false);

  // ── Equality optimizer state ───────────────────────────────────────────────
  const [isEqualizing, setIsEqualizing] = useState(false);
  const [equalityResult, setEqualityResult] = useState<{
    improvements: number;
    ranges: Record<string, number>;
  } | null>(null);

  // ── Total-balance optimizer state (Step 2b) ────────────────────────────────
  const [isTotalBalancing, setIsTotalBalancing] = useState(false);
  const [totalBalanceResult, setTotalBalanceResult] = useState<{
    improvements: number;
    ranges: Record<string, number>;
    totalRange: Record<string, number>;
  } | null>(null);

  // ── Impact factor state ───────────────────────────────────────────────────
  const [impactFactors, setImpactFactors] = useState<ImpactFactors | null>(null);
  const [isComputingImpact, setIsComputingImpact] = useState(false);

  // Monotonically-increasing request counter; stale responses are ignored
  const pendingIdRef = useRef<number>(0);
  // Snapshot of last-computed inputs — used to avoid redundant recomputation
  const lastSnapshotRef = useRef<string | null>(null);
  // Which snapshot the currently-displayed `impactFactors` corresponds to
  const computedSnapshotRef = useRef<string | null>(null);

  // Subscribe to module-level fairness computation notifications.
  useEffect(() => {
    const handler = (msg: { id: number; result?: ImpactFactors; error?: string; snapshot?: string }) => {
      const { id, result, error, snapshot } = msg;
      // Component only cares about the latest request it issued
      if (id !== pendingIdRef.current) return;
      if (error) {
        console.error('[fairness server]', error);
        setIsComputingImpact(false);
        return;
      }
      if (result) {
        setImpactFactors(result);
        computedSnapshotRef.current = snapshot ?? lastSnapshotRef.current ?? null;
        moduleCachedImpactFactors = result;
        moduleCachedImpactSnapshot = snapshot ?? lastSnapshotRef.current ?? moduleCachedImpactSnapshot;
      }
      setIsComputingImpact(false);
    };
    moduleFairnessListeners.add(handler);
    return () => void moduleFairnessListeners.delete(handler);
  }, []);

  // Trigger a new background computation whenever relevant inputs change
  // (cache the last computed inputs — opening/closing the panel does NOT force
  // a recompute unless the inputs actually changed)
  useEffect(() => {
    // If panel closed: keep cached preview as-is
    if (!showConfig) return;

    // No employees → nothing to compute
    if (employees.length === 0) {
      lastSnapshotRef.current = null;
      computedSnapshotRef.current = null;
      moduleCachedImpactSnapshot = null;
      moduleCachedImpactFactors = null;
      setImpactFactors(null);
      setIsComputingImpact(false);
      return;
    }

    // Build a compact, stable snapshot of the inputs we care about
    const empSummary = employees
      .map(e => ({ id: e.id, allowedShiftTypes: e.allowedShiftTypes, department: e.department, prefs: e.preferences?.length ?? 0 }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const snapshot = JSON.stringify({ employees: empSummary, schedulerConfig, selectedYear, selectedMonth });

    // If a module-level cache exists for this exact snapshot, reuse it and
    // avoid any recomputation (this preserves the preview across unmounts)
    if (moduleCachedImpactSnapshot === snapshot && moduleCachedImpactFactors) {
      setImpactFactors(moduleCachedImpactFactors);
      computedSnapshotRef.current = snapshot;
      setIsComputingImpact(false);
      return;
    }

    // If nothing changed since the last computation within this mounted
    // component and we already have results for that same snapshot, skip
    // recompute as well.
    if (lastSnapshotRef.current === snapshot && computedSnapshotRef.current === snapshot && impactFactors) {
      return;
    }

    // Debounce then post to the server — keep current preview visible while
    // the new computation runs.
    const timer = setTimeout(() => {
      const id = postModuleFairnessRequest({ employees, schedulerConfig, year: selectedYear, startMonth: selectedMonth }, snapshot);
      pendingIdRef.current = id;
      lastSnapshotRef.current = snapshot; // mark which inputs we're computing for
      setIsComputingImpact(true);
    }, 200);

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showConfig, employees, schedulerConfig, selectedYear, selectedMonth, impactFactors]);

  // Helpers for updating config
  const setShiftCount = (type: keyof SchedulerConfig['shiftCounts'], val: number) =>
    setSchedulerConfig(c => ({ ...c, shiftCounts: { ...c.shiftCounts, [type]: val } }));

  const setRule = (rule: keyof SchedulerConfig['rules'], val: boolean) =>
    setSchedulerConfig(c => ({ ...c, rules: { ...c.rules, [rule]: val } }));

  // Persist current schedulerConfig to module cache so edits survive unmounts
  useEffect(() => {
    moduleCachedSchedulerConfig = schedulerConfig;
  }, [schedulerConfig]);

  const handleGenerateFullPlan = async () => {
    if (employees.length === 0) {
      setGenerationResult({
        success: false,
        message: 'Keine Mitarbeiter vorhanden. Bitte fügen Sie zuerst Mitarbeiter hinzu.',
        assignmentCount: 0
      });
      return;
    }

    // Warn if plan is currently released
    try {
      const token = getAuthToken();
      const relResp = await fetch('/api/plan/release', { headers: { Authorization: `Bearer ${token}` } });
      if (relResp.ok) {
        const { released } = await relResp.json();
        if (released) {
          setReleaseWarningOpen(true);
          return;
        }
      }
    } catch { /* ignore release-check errors */ }

    doGenerate();
  };

  const doGenerate = async () => {
    setReleaseWarningOpen(false);

    // Revoke release if currently released
    try {
      const token = getAuthToken();
      await fetch('/api/plan/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ released: false }),
      });
    } catch { /* ignore */ }

    setIsGenerating(true);
    setGenerationResult(null);

    // Call server-side generation endpoint
    const token = getAuthToken();
    try {
      const resp = await fetch('/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          employees,
          year: selectedYear,
          startMonth: selectedMonth,
          months: 12,
          schedulerConfig,
        }),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();

      // Revive dates from JSON
      const assignments = (data.assignments || []).map((a: any) => ({
        ...a,
        startDate: new Date(a.startDate),
        endDate: new Date(a.endDate),
      }));
      const violations = (data.violations || []).map((v: any) => ({
        ...v,
        startDate: new Date(v.startDate),
        endDate: new Date(v.endDate),
      }));

      // Store the complete plan at once (avoids race condition with concurrent saveToServer calls)
      const completePlan = {
        year: selectedYear,
        startMonth: selectedMonth,
        months: 12,
        schedulerConfig,
        violations,
        assignments,
        algorithm: 'automatisch generiert',
      };
      setShiftPlan(completePlan as any);
      // Clear calendar labels for the new plan
      // (createShiftPlan used to do this, but we bypass it now)

      // Open the pipeline automatically if there are unresolvable violations
      if (violations.length > 0) {
        setShowPipeline(true);
      }

      const end = new Date(selectedYear, selectedMonth + 12, 0);

      setGenerationResult({
        success: true,
        message: `Schichtplan erfolgreich generiert für ${getMonthName(selectedMonth)} ${selectedYear} — ${getMonthName(end.getMonth())} ${end.getFullYear()}`,
        assignmentCount: assignments.length,
      });
    } catch (error) {
      setGenerationResult({
        success: false,
        message: 'Fehler beim Generieren des Schichtplans.',
        assignmentCount: 0,
      });
    } finally {
      setIsGenerating(false);
    }
  };

  // ── Optimizer handlers (delegate to persistent manager) ────────────────
  const handleOptimise = useCallback(() => {
    if (employees.length === 0) return;
    // Use current plan assignments as baseline (from equality step)
    const baseline = shiftPlan?.assignments;
    const baseViolations = shiftPlan?.violations;
    startOptimisation(employees, schedulerConfig, selectedYear, selectedMonth, baseline, baseViolations);
  }, [employees, schedulerConfig, selectedYear, selectedMonth, shiftPlan?.assignments, shiftPlan?.violations]);

  const handleCancelOptimiser = useCallback(() => {
    cancelOptimisation();
  }, []);

  // ── Equality optimizer handler ──────────────────────────────────────────
  const handleEquality = useCallback(async () => {
    if (employees.length === 0 || !shiftPlan?.assignments?.length) return;
    setIsEqualizing(true);
    setEqualityResult(null);
    const token = getAuthToken();
    try {
      const resp = await fetch('/api/optimize-equality', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          employees,
          schedulerConfig,
          baselineAssignments: shiftPlan.assignments,
          maxIterations: 500,
          year: selectedYear,
          startMonth: selectedMonth,
          months: 12,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const revivedAssignments = (data.assignments || []).map((a: any) => ({
        ...a,
        startDate: new Date(a.startDate),
        endDate: new Date(a.endDate),
      }));
      // Revive violation dates from JSON
      const revivedViolations = (data.violations || []).map((v: any) => ({
        ...v,
        startDate: new Date(v.startDate),
        endDate: new Date(v.endDate),
      }));
      setShiftPlan({
        year: selectedYear,
        startMonth: selectedMonth,
        months: 12,
        schedulerConfig,
        violations: revivedViolations,
        assignments: revivedAssignments,
        algorithm: 'gleichheits-optimiert',
      } as any);
      setEqualityResult({ improvements: data.improvements, ranges: data.ranges });
      setGenerationResult({
        success: true,
        message: `Gleichheitsoptimierung: ${data.improvements} Verbesserungen in ${data.iterations} Iterationen`,
        assignmentCount: revivedAssignments.length,
      });
    } catch (err) {
      setGenerationResult({
        success: false,
        message: `Gleichheitsoptimierung fehlgeschlagen: ${err}`,
        assignmentCount: 0,
      });
    } finally {
      setIsEqualizing(false);
    }
  }, [employees, schedulerConfig, shiftPlan?.assignments, selectedYear, selectedMonth, setShiftPlan]);

  // ── Total-balance optimizer handler (Step 2b) ───────────────────────────
  const handleTotalBalance = useCallback(async () => {
    if (employees.length === 0 || !shiftPlan?.assignments?.length) return;
    setIsTotalBalancing(true);
    setTotalBalanceResult(null);
    const token = getAuthToken();
    try {
      const resp = await fetch('/api/optimize-total-balance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          employees,
          schedulerConfig,
          baselineAssignments: shiftPlan.assignments,
          maxIterations: 500,
          year: selectedYear,
          startMonth: selectedMonth,
          months: 12,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const revivedAssignments = (data.assignments || []).map((a: any) => ({
        ...a,
        startDate: new Date(a.startDate),
        endDate: new Date(a.endDate),
      }));
      const revivedViolations = (data.violations || []).map((v: any) => ({
        ...v,
        startDate: new Date(v.startDate),
        endDate: new Date(v.endDate),
      }));
      setShiftPlan({
        year: selectedYear,
        startMonth: selectedMonth,
        months: 12,
        schedulerConfig,
        violations: revivedViolations,
        assignments: revivedAssignments,
        algorithm: 'gesamt-balanciert',
      } as any);
      setTotalBalanceResult({ improvements: data.improvements, ranges: data.ranges, totalRange: data.totalRange });
      setGenerationResult({
        success: true,
        message: `Gesamt-Balancierung: ${data.improvements} Verbesserungen in ${data.iterations} Iterationen`,
        assignmentCount: revivedAssignments.length,
      });
    } catch (err) {
      setGenerationResult({
        success: false,
        message: `Gesamt-Balancierung fehlgeschlagen: ${err}`,
        assignmentCount: 0,
      });
    } finally {
      setIsTotalBalancing(false);
    }
  }, [employees, schedulerConfig, shiftPlan?.assignments, selectedYear, selectedMonth, setShiftPlan]);

  const planStart = new Date(selectedYear, selectedMonth, 1);
  const planEnd = new Date(selectedYear, selectedMonth + (shiftPlan?.months ?? 12), 0); // last day of the n-month range
  const filteredViolations = (shiftPlan?.violations ?? []).filter(v => {
    const vDate = new Date(v.startDate);
    return vDate >= planStart && vDate <= planEnd;
  });

  const currentYearAssignments = shiftPlan?.assignments.filter((assignment) => {
    const aStart = new Date(assignment.startDate);
    return aStart >= planStart && aStart <= planEnd;
  }) || [];

  const assignmentsByType = {
    nachtbereitschaft: currentYearAssignments.filter((a) => a.shiftType === 'nachtbereitschaft').length,
    verschieben: currentYearAssignments.filter((a) => a.shiftType === 'verschieben').length,
    fruehschicht: currentYearAssignments.filter((a) => a.shiftType === 'fruehschicht').length,
  };

  const planFileRef = React.useRef<HTMLInputElement | null>(null);

  const onPlanFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;

    try {
      const text = await f.text();
      const parsed = JSON.parse(text);
      const revived = reviveImportedPlan(parsed) as any;
      if (!revived) {
        alert('Ungültige Plan‑Datei. Bitte eine zuvor exportierte Schichtplan‑JSON verwenden.');
        return;
      }

      // departments: create if missing (match by name, case-insensitive)
      const deptMap: Record<string, string> = {};
      revived.departments.forEach((d: any) => {
        const existing = departments.find(x => x.name.toLowerCase().trim() === d.name.toLowerCase().trim());
        if (existing) deptMap[d.id] = existing.id;
        else {
          const newDept = { id: `dept-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, name: d.name };
          addDepartment(newDept);
          deptMap[d.id] = newDept.id;
        }
      });

      // employees: add missing, map imported id -> actual id (match by name)
      const empMap: Record<string, string> = {};
      revived.employees.forEach((ie: any) => {
        const existingEmp = employees.find(e => e.name.toLowerCase().trim() === ie.name.toLowerCase().trim());
        if (existingEmp) {
          empMap[ie.id] = existingEmp.id;
        } else {
          const newEmp = {
            id: generateId(),
            name: ie.name,
            department: deptMap[ie.department] || departments[0]?.id || '',
            isOver55: false,
            hasL2: false,
            allowedShiftTypes: ie.allowedShiftTypes || ['fruehschicht', 'verschieben', 'nachtbereitschaft'],
            vacationDays: (ie.vacationDays || []).map((d: any) => new Date(d)),
            vacationRanges: (ie.vacationRanges || []).map((r: any) => ({ startDate: new Date(r.startDate), endDate: new Date(r.endDate) })),
            preferences: (ie.preferences || []).map((p: any) => ({ ...p, startDate: new Date(p.startDate), endDate: new Date(p.endDate) }))
          } as any;
          addEmployee(newEmp);
          empMap[ie.id] = newEmp.id;
        }
      });

      // assignments: remap employee ids and ensure dates are Date objects
      const importedPlan = revived.shiftPlan;
      const mappedAssignments = (importedPlan.assignments || []).map((a: any) => ({
        ...a,
        startDate: new Date(a.startDate),
        endDate: new Date(a.endDate),
        employees: (a.employees || []).map((id: string) => empMap[id] || id)
      }));

      const finalPlan = { ...importedPlan, assignments: mappedAssignments };
      if (!finalPlan.algorithm) {
        finalPlan.algorithm = 'importiert';
      }
      setShiftPlan(finalPlan as any);
      
      // Import labels if present
      if (revived.labels && Array.isArray(revived.labels)) {
        revived.labels.forEach((label: any) => {
          addLabel({
            id: label.id || `label-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            name: label.name || '',
            letter: label.letter || '',
            color: label.color || '#3b82f6',
            text: label.text || ''
          });
        });
      }
      
      // Import calendar labels if present (remap employee IDs)
      if (revived.calendarLabels && Array.isArray(revived.calendarLabels)) {
        revived.calendarLabels.forEach((cl: any) => {
          addCalendarLabel({
            id: cl.id || `clabel-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            employeeId: empMap[cl.employeeId] || cl.employeeId,
            date: cl.date,
            labelId: cl.labelId
          });
        });
      }
      
      alert(`Schichtplan importiert: ${mappedAssignments.length} Zuweisungen, ${revived.employees.length} Mitarbeiter, ${revived.departments.length} Abteilungen (neu hinzugefügt falls nötig).`);
    } catch (err) {
      console.error(err);
      alert('Fehler beim Einlesen der Datei. Bitte prüfen Sie das Format.');
    } finally {
      if (planFileRef.current) planFileRef.current.value = '';
    }
  };

  return (
    <>
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Automatische Schichtplanung</h2>
            <p className="text-gray-600">
              Generieren Sie den kompletten Schichtplan für das Jahr mit einem Klick
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Calendar className="h-12 w-12 text-primary-600" />
            <div>
              <button onClick={() => planFileRef.current?.click()} className="text-sm px-3 py-1 border border-gray-200 rounded-md hover:bg-gray-50 flex items-center gap-2">
                <Download size={14} /> Plan importieren (.json)
              </button>
              <input ref={planFileRef} type="file" accept="application/json,.json" onChange={onPlanFileChange} className="hidden" />
            </div>
          </div>
        </div>
      </div>

      {/* Scheduler Configuration Panel */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <button
          onClick={() => setShowConfig(v => !v)}
          className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-gray-600" />
            <span className="font-semibold text-gray-900">Planungsregeln &amp; Schichtbesetzung</span>
          </div>
          {showConfig ? <ChevronUp size={18} className="text-gray-500" /> : <ChevronDown size={18} className="text-gray-500" />}
        </button>

        {showConfig && (
          <div className="px-6 pb-6 border-t border-gray-100 space-y-6">

            {/* Shift Counts */}
            <div>
              <h4 className="font-semibold text-gray-800 mt-4 mb-3">Gleichzeitige Schichtbesetzung
                {isComputingImpact && <span className="ml-2 text-xs font-normal text-gray-400 inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" />Fairness-Vorschau…</span>}
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">

                {/* Versetzte Schicht */}
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200 space-y-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-gray-700">Versetzte Schicht (Mo–Fr)</span>
                    <input
                      type="number" min={1} max={20}
                      value={schedulerConfig.shiftCounts.verschieben}
                      onChange={e => setShiftCount('verschieben', Math.max(1, Number(e.target.value)))}
                      className="w-24 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  </label>
                  <p className="text-xs text-gray-400">Fairness-Auswirkung:</p>
                  <CountImpactBadges ci={impactFactors?.counts.verschieben} baseline={impactFactors?.baseline} loading={isComputingImpact} />
                </div>

                {/* Nachtbereitschaft */}
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200 space-y-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-gray-700">Nachtbereitschaft (Sa–Sa)</span>
                    <input
                      type="number" min={1} max={20}
                      value={schedulerConfig.shiftCounts.nachtbereitschaft}
                      onChange={e => setShiftCount('nachtbereitschaft', Math.max(1, Number(e.target.value)))}
                      className="w-24 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  </label>
                  <p className="text-xs text-gray-400">Fairness-Auswirkung:</p>
                  <CountImpactBadges ci={impactFactors?.counts.nachtbereitschaft} baseline={impactFactors?.baseline} loading={isComputingImpact} />
                </div>

                {/* Frühschicht */}
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200 space-y-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-gray-700">Frühschicht WE (Sa–So)</span>
                    <input
                      type="number" min={1} max={20}
                      value={schedulerConfig.shiftCounts.fruehschicht}
                      onChange={e => setShiftCount('fruehschicht', Math.max(1, Number(e.target.value)))}
                      className="w-24 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  </label>
                  <p className="text-xs text-gray-400">Fairness-Auswirkung:</p>
                  <CountImpactBadges ci={impactFactors?.counts.fruehschicht} baseline={impactFactors?.baseline} loading={isComputingImpact} />
                </div>

                {/* Shift count inputs end here */}

                {/* Ü55 Verschieben-Slots */}
                <div className="bg-amber-50 rounded-lg p-3 border border-amber-200 space-y-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-amber-800">Ü55 Verschieben-Plätze</span>
                    <input
                      type="number" min={0} max={schedulerConfig.shiftCounts.verschieben}
                      value={schedulerConfig.over55VerschiebenSlots}
                      onChange={e => setSchedulerConfig(c => ({ ...c, over55VerschiebenSlots: Math.max(0, Math.min(c.shiftCounts.verschieben, Number(e.target.value))) }))}
                      className="w-24 px-3 py-2 border border-amber-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                  </label>
                  <p className="text-xs text-amber-600">Mindestanzahl Ü55-Mitarbeiter pro Versetzt-Woche</p>
                  <CountImpactBadges ci={impactFactors?.counts.over55VerschiebenSlots} baseline={impactFactors?.baseline} loading={isComputingImpact} unit="Platz" />
                </div>
              </div>
            </div>

            {/* Rule Toggles */}
            <div>
              <h4 className="font-semibold text-gray-800 mb-3">Aktive Regeln</h4>
              <div className="space-y-2">
                {([
                  { key: 'noWeekendAroundVacation',             label: 'Kein Wochenenddienst direkt vor/nach Urlaub' },
                  { key: 'noFruehschichtAdjacentToVerschieben', label: 'Keine Frühschicht am Wochenende angrenzend an Versetzt-Woche' },
                  { key: 'noNachtAfterVerschieben',             label: 'Keine Nacht in der Folgewoche nach Versetzt-Woche (7-Tage-Sperre)' },
                  { key: 'noVerschiebenAfterNacht',             label: 'Kein Versetzt-Dienst in der Woche nach Nachtbereitschaft (7-Tage-Sperre)' },
                  { key: 'noConsecutiveVerschieben',            label: 'Keine zwei Versetzt-Wochen hintereinander (für dieselbe Person)' },
                  { key: 'noConsecutiveNacht',                  label: 'Keine zwei Nachtschichten hintereinander (für dieselbe Person)' },
                  { key: 'noConsecutiveFruehschicht',            label: 'Keine zwei Frühschichten (Wochenende) hintereinander (für dieselbe Person)' },
                  { key: 'noNachtBeforeVacation',                label: 'Keine Nachtbereitschaft in der Woche vor Urlaub' },
                  { key: 'respectEmployeeShiftTypes',          label: 'Erlaubte Schichttypen pro Mitarbeiter berücksichtigen' },
                  { key: 'respectAvoidancePreferences',         label: 'Vermeidungspräferenzen der Mitarbeiter berücksichtigen', soft: true },
                  { key: 'departmentDiversity',                 label: 'Abteilungsvielfalt bei der Auswahl bevorzugen', soft: true },
                ] as { key: keyof SchedulerConfig['rules']; label: string; soft?: boolean }[]).map(({ key, label, soft }) => (
                  <div key={key} className={`rounded-lg px-3 py-2 border ${
                    soft ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'
                  }`}>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={schedulerConfig.rules[key]}
                        onClick={() => setRule(key, !schedulerConfig.rules[key])}
                        className={`relative flex-shrink-0 w-11 h-6 rounded-full overflow-hidden transition-colors ${
                          schedulerConfig.rules[key] ? 'bg-primary-600' : 'bg-gray-300'
                        }`}
                      >
                        <span
                          className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                            schedulerConfig.rules[key] ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                      <span className="text-sm text-gray-700 leading-tight">{label}</span>
                    </div>
                    <div className="ml-13 pl-[52px] space-y-1">
                      <p className="text-xs text-gray-400">Fairness bei {schedulerConfig.rules[key] ? 'Deaktivierung' : 'Aktivierung'}:</p>
                      <ImpactBadges d={impactFactors?.rules[key]} baseline={impactFactors?.baseline} loading={isComputingImpact} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <button
              onClick={() => setSchedulerConfig(DEFAULT_SCHEDULER_CONFIG)}
              className="text-sm text-gray-500 underline hover:text-gray-700"
            >
              Auf Standardwerte zurücksetzen
            </button>
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
           4-Step Pipeline: Grundplan → Gleichheit → Gesamt-Balance → Fairness
           ═══════════════════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="space-y-4">
          {/* Year / month selection */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Startjahr</label>
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(Number(e.target.value))}
                className="w-full md:w-64 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {[2024, 2025, 2026, 2027, 2028].map((year) => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Startmonat</label>
              <select
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(Number(e.target.value))}
                className="w-full md:w-48 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {Array.from({ length: 12 }).map((_, i) => (
                  <option key={i} value={i}>{getMonthName(i)}</option>
                ))}
              </select>
            </div>
          </div>

          {employees.length === 0 && (
            <div className="flex items-start gap-2 text-amber-600 bg-amber-50 p-3 rounded-md">
              <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
              <p className="text-sm">
                Bitte fügen Sie zuerst Mitarbeiter hinzu, bevor Sie einen Schichtplan generieren.
              </p>
            </div>
          )}

          {filteredViolations.length > 0 && (
            <button
              onClick={() => setShowPipeline(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500 text-white rounded-md hover:bg-amber-600 font-medium text-sm transition-colors"
              title="Regelprobleme anzeigen"
            >
              <AlertTriangle className="h-4 w-4" />
              {filteredViolations.length} Regelverstoß{filteredViolations.length !== 1 ? 'e' : ''}
            </button>
          )}

          {/* ─── Stepper ─────────────────────────────────────────────── */}
          {(() => {
            const hasEmployees = employees.length > 0;
            const hasPlan = (shiftPlan?.assignments?.length ?? 0) > 0;
            const algoTag = shiftPlan?.algorithm ?? '';
            const step1Done = hasPlan; // any plan exists from step 1
            const step2Done = algoTag === 'gleichheits-optimiert' || algoTag === 'gesamt-balanciert' || algoTag === 'fairness-optimiert';
            const step3Done = algoTag === 'gesamt-balanciert' || algoTag === 'fairness-optimiert';
            const step4Done = algoTag === 'fairness-optimiert';

            return (
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mt-2">
                {/* ── Step 1: Normal ─────────────────────── */}
                <div className={`rounded-lg border-2 p-4 ${step1Done ? 'border-green-300 bg-green-50/50' : 'border-gray-200'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`flex items-center justify-center w-7 h-7 rounded-full text-sm font-bold ${step1Done ? 'bg-green-500 text-white' : 'bg-primary-100 text-primary-700'}`}>1</div>
                    <h4 className="font-semibold text-gray-900">Grundplan</h4>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">
                    Greedy-Algorithmus: weist Schichten chronologisch zu, berücksichtigt alle aktiven Regeln.
                  </p>
                  <button
                    onClick={handleGenerateFullPlan}
                    disabled={isGenerating || isOptimising || isEqualizing || isTotalBalancing || !hasEmployees}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-600 text-white rounded-md hover:bg-primary-700 disabled:bg-gray-300 disabled:cursor-not-allowed font-medium"
                  >
                    <Sparkles className="h-4 w-4" />
                    {isGenerating ? 'Generiere...' : step1Done ? 'Neu generieren' : 'Schichtplan generieren'}
                  </button>
                </div>

                {/* ── Step 2: Gleichheit ─────────────────── */}
                <div className={`rounded-lg border-2 p-4 ${!step1Done ? 'opacity-50 border-gray-200' : step2Done ? 'border-green-300 bg-green-50/50' : 'border-blue-200'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`flex items-center justify-center w-7 h-7 rounded-full text-sm font-bold ${step2Done ? 'bg-green-500 text-white' : step1Done ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 text-gray-400'}`}>2</div>
                    <h4 className="font-semibold text-gray-900">Gleichheitsoptimierung</h4>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">
                    Minimiert die Spannweite (Max − Min) der Schichtzahlen je Typ durch regelkonforme Tausche.
                  </p>
                  <button
                    onClick={handleEquality}
                    disabled={!step1Done || isGenerating || isOptimising || isEqualizing || isTotalBalancing || !hasEmployees}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed font-medium"
                  >
                    <Scale className="h-4 w-4" />
                    {isEqualizing ? 'Optimiere...' : step2Done ? 'Erneut optimieren' : 'Gleichheit optimieren'}
                  </button>
                  {equalityResult && !isEqualizing && (
                    <div className="mt-2 text-xs text-blue-800 bg-blue-50 rounded p-2 space-y-0.5">
                      <div className="font-medium">{equalityResult.improvements} Verbesserungen</div>
                      <div>Spannweite: V={equalityResult.ranges.verschieben} · N={equalityResult.ranges.nachtbereitschaft} · F={equalityResult.ranges.fruehschicht}</div>
                    </div>
                  )}
                </div>

                {/* ── Step 3: Gesamt-Balancierung ────────── */}
                <div className={`rounded-lg border-2 p-4 ${!step2Done ? 'opacity-50 border-gray-200' : step3Done ? 'border-green-300 bg-green-50/50' : 'border-violet-200'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`flex items-center justify-center w-7 h-7 rounded-full text-sm font-bold ${step3Done ? 'bg-green-500 text-white' : step2Done ? 'bg-violet-100 text-violet-700' : 'bg-gray-200 text-gray-400'}`}>3</div>
                    <h4 className="font-semibold text-gray-900">Gesamt-Balancierung</h4>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">
                    Reduziert die Gesamtspannweite (alle Schichttypen zusammen) pro Mitarbeitertyp, ohne die Einzelspannweiten zu verschlechtern.
                  </p>
                  <button
                    onClick={handleTotalBalance}
                    disabled={!step2Done || isGenerating || isOptimising || isEqualizing || isTotalBalancing || !hasEmployees}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-violet-600 text-white rounded-md hover:bg-violet-700 disabled:bg-gray-300 disabled:cursor-not-allowed font-medium"
                  >
                    <Scale className="h-4 w-4" />
                    {isTotalBalancing ? 'Optimiere...' : step3Done ? 'Erneut optimieren' : 'Gesamt balancieren'}
                  </button>
                  {totalBalanceResult && !isTotalBalancing && (
                    <div className="mt-2 text-xs text-violet-800 bg-violet-50 rounded p-2 space-y-0.5 overflow-x-auto max-w-full">
                      <div className="font-medium">{totalBalanceResult.improvements} Verbesserungen</div>
                      <div>Typ-Spannweiten je Gruppe:</div>
                      {Object.entries(totalBalanceResult.ranges).reduce((acc, [key, val]) => {
                        const [group] = key.split(':');
                        if (!acc.find(g => g.group === group)) acc.push({ group, items: [] });
                        acc.find(g => g.group === group)!.items.push({ key, val: val as number });
                        return acc;
                      }, [] as { group: string; items: { key: string; val: number }[] }[]).map(g => {
                        // Shorten group label: translate shift types, keep Ü55 marker
                        const [stPart, agePart] = g.group.split('|');
                        const stShort = stPart.split(',').map(t =>
                          t === 'verschieben' ? 'V' : t === 'nachtbereitschaft' ? 'N' : t === 'fruehschicht' ? 'F' : t
                        ).join(',');
                        const shortLabel = `${stShort}|${agePart}`;
                        return (
                        <div key={g.group} className="ml-1 truncate" title={g.group}>{shortLabel}: {g.items.map(i => {
                          const t = i.key.split(':')[1];
                          const label = t === 'verschieben' ? 'V' : t === 'nachtbereitschaft' ? 'N' : 'F';
                          return `${label}=${i.val}`;
                        }).join(' · ')}</div>
                      )})}
                      <div className="truncate" title={Object.entries(totalBalanceResult.totalRange).map(([k, v]) => `${k}=${v}`).join(' · ')}>Gesamt: {Object.entries(totalBalanceResult.totalRange).map(([k, v]) => {
                        const [stPart, agePart] = k.split('|');
                        const stShort = stPart.split(',').map(t =>
                          t === 'verschieben' ? 'V' : t === 'nachtbereitschaft' ? 'N' : t === 'fruehschicht' ? 'F' : t
                        ).join(',');
                        return `${stShort}|${agePart}=${v}`;
                      }).join(' · ')}</div>
                    </div>
                  )}
                </div>

                {/* ── Step 4: Fairness ───────────────────── */}
                <div className={`rounded-lg border-2 p-4 ${!step1Done ? 'opacity-50 border-gray-200' : step4Done ? 'border-green-300 bg-green-50/50' : 'border-amber-200'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`flex items-center justify-center w-7 h-7 rounded-full text-sm font-bold ${step4Done ? 'bg-green-500 text-white' : step1Done ? 'bg-amber-100 text-amber-700' : 'bg-gray-200 text-gray-400'}`}>4</div>
                    <h4 className="font-semibold text-gray-900">Fairness-Optimierung</h4>
                  </div>
                  <p className="text-xs text-gray-500 mb-2">
                    Monte-Carlo-Simulation: erzeugt viele zufällige gültige Pläne und behält den fairsten.
                  </p>

                  <div className="space-y-2 mb-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-0.5">Max. Iterationen</label>
                      <input
                        type="number"
                        min={100} max={100000} step={500}
                        value={optimiserMaxIter}
                        onChange={e => setMaxIterations(Number(e.target.value))}
                        disabled={isOptimising}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400"
                      />
                      {(() => {
                        const est = msPerIteration != null ? msPerIteration * optimiserMaxIter : null;
                        if (est != null && !isOptimising) {
                          const secs = Math.round(est / 1000);
                          const display = secs >= 60 ? `ca. ${Math.floor(secs / 60)} Min ${secs % 60} Sek` : `ca. ${secs} Sek`;
                          return <p className="text-xs text-amber-600 mt-0.5">{display}</p>;
                        }
                        return null;
                      })()}
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-0.5">Zieldimensionen</label>
                      <div className="flex flex-wrap gap-2">
                        {([
                          { key: 'overall' as const, label: 'Gesamt' },
                          { key: 'verschieben' as const, label: 'Versetzt' },
                          { key: 'nacht' as const, label: 'Nacht' },
                          { key: 'frueh' as const, label: 'Früh/WE' },
                        ]).map(({ key, label }) => (
                          <label key={key} className="inline-flex items-center gap-1 text-xs text-gray-700 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={optimiserTargets[key]}
                              disabled={isOptimising}
                              onChange={() => setTargets({ ...optimiserTargets, [key]: !optimiserTargets[key] })}
                              className="rounded border-gray-300 text-amber-500 focus:ring-amber-400 h-3.5 w-3.5"
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>

                  {!isOptimising ? (
                    <button
                      onClick={handleOptimise}
                      disabled={!step3Done || isGenerating || isEqualizing || isTotalBalancing || !hasEmployees || !Object.values(optimiserTargets).some(Boolean)}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-500 text-white rounded-md hover:bg-amber-600 disabled:bg-gray-300 disabled:cursor-not-allowed font-medium"
                    >
                      <Zap className="h-4 w-4" />
                      {step4Done ? 'Erneut optimieren' : 'Fairness optimieren'}
                    </button>
                  ) : (
                    <button
                      onClick={handleCancelOptimiser}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-red-500 text-white rounded-md hover:bg-red-600 font-medium"
                    >
                      Abbrechen
                    </button>
                  )}

                  {/* Progress bar */}
                  {isOptimising && optimiserProgress && (
                    <div className="mt-3 space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-gray-600">
                        <span>{optimiserProgress.iteration.toLocaleString()} / {optimiserProgress.maxIterations.toLocaleString()}</span>
                        {(() => {
                          const remaining = optimiserProgress.estimatedTotalMs - optimiserProgress.elapsedMs;
                          if (remaining > 0) {
                            const secs = Math.round(remaining / 1000);
                            const display = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
                            return <span>{display}</span>;
                          }
                          return null;
                        })()}
                        <span>{optimiserProgress.bestScore.toFixed(1)}%</span>
                      </div>
                      <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-amber-500 transition-all duration-200 rounded-full"
                          style={{ width: `${Math.min(100, (optimiserProgress.iteration / optimiserProgress.maxIterations) * 100)}%` }}
                        />
                      </div>
                      <div className="flex gap-2 text-xs text-gray-500">
                        <span>G: {optimiserProgress.currentScores.overall.toFixed(1)}%</span>
                        <span>V: {optimiserProgress.currentScores.verschieben.toFixed(1)}%</span>
                        <span>N: {optimiserProgress.currentScores.nacht.toFixed(1)}%</span>
                        <span>F: {optimiserProgress.currentScores.frueh.toFixed(1)}%</span>
                      </div>
                    </div>
                  )}

                  {/* Result */}
                  {optimiserResult && !isOptimising && (
                    <div className="mt-2 text-xs text-amber-800 bg-amber-50 rounded p-2 space-y-0.5">
                      <div className="font-medium">{optimiserResult.iterations.toLocaleString()} Iterationen</div>
                      <div className="flex gap-2">
                        <span>G: <strong>{optimiserResult.scores.overall.toFixed(1)}%</strong></span>
                        <span>V: <strong>{optimiserResult.scores.verschieben.toFixed(1)}%</strong></span>
                        <span>N: <strong>{optimiserResult.scores.nacht.toFixed(1)}%</strong></span>
                        <span>F: <strong>{optimiserResult.scores.frueh.toFixed(1)}%</strong></span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Algorithm tag + delete button */}
          {shiftPlan?.algorithm && (
            <div className="mt-2 flex items-center gap-4">
              <span className="text-sm text-gray-600">
                Aktueller Plan-Algorithmus: <strong>{shiftPlan.algorithm}</strong>
              </span>
              <button
                onClick={() => setDeletePlanOpen(true)}
                className="text-sm text-red-600 hover:text-red-800 underline"
              >
                Plan löschen
              </button>
            </div>
          )}
        </div>
      </div>
      {/* Generation Result */}
      {generationResult && (
        <div className={`rounded-lg p-6 ${
          generationResult.success 
            ? 'bg-green-50 border border-green-200' 
            : 'bg-red-50 border border-red-200'
        }`}>
          <div className="flex items-start gap-3">
            <div className={`flex-shrink-0 ${
              generationResult.success ? 'text-green-600' : 'text-red-600'
            }`}>
              {generationResult.success ? (
                <Sparkles className="h-6 w-6" />
              ) : (
                <AlertCircle className="h-6 w-6" />
              )}
            </div>
            <div>
              <h3 className={`font-medium mb-1 ${
                generationResult.success ? 'text-green-900' : 'text-red-900'
              }`}>
                {generationResult.message}
              </h3>
              {generationResult.success && (
                <p className="text-green-700 text-sm">
                  {generationResult.assignmentCount} Schichtzuweisungen wurden erstellt.
                  Sie können diese jetzt im Kalender ansehen und bearbeiten.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Current Plan Overview */}
      {currentYearAssignments.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Users className="h-5 w-5" />
            Aktueller Schichtplan für {getMonthName(selectedMonth)} {selectedYear} — {getMonthName(planEnd.getMonth())} {planEnd.getFullYear()}
          </h3>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-indigo-50 rounded-lg p-4">
              <div className="text-indigo-900 font-medium mb-1">
                {SHIFT_LABELS.nachtbereitschaft}
              </div>
              <div className="text-2xl font-bold text-indigo-700">
                {assignmentsByType.nachtbereitschaft}
              </div>
              <div className="text-sm text-indigo-600">Schichten</div>
            </div>

            <div className="bg-purple-50 rounded-lg p-4">
              <div className="text-purple-900 font-medium mb-1">
                {SHIFT_LABELS.verschieben}
              </div>
              <div className="text-2xl font-bold text-purple-700">
                {assignmentsByType.verschieben}
              </div>
              <div className="text-sm text-purple-600">Schichten</div>
            </div>

            <div className="bg-blue-50 rounded-lg p-4">
              <div className="text-blue-900 font-medium mb-1">
                {SHIFT_LABELS.fruehschicht}
              </div>
              <div className="text-2xl font-bold text-blue-700">
                {assignmentsByType.fruehschicht}
              </div>
              <div className="text-sm text-blue-600">Schichten</div>
            </div>
          </div>

          <div className="mt-4 p-3 bg-blue-50 rounded-md">
            <p className="text-sm text-blue-800">
              💡 <strong>Tipp:</strong> Wechseln Sie zum Kalender-Reiter, um die Schichtzuweisungen anzusehen und bei Bedarf anzupassen.
            </p>
          </div>
        </div>
      )}

      {/* Information Box */}
      <div className="bg-gray-50 rounded-lg p-6 border border-gray-200">
        <h3 className="font-semibold text-gray-900 mb-3">ℹ️ So funktioniert die automatische Planung</h3>
        <ul className="space-y-2 text-sm text-gray-700">
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">1.</span>
            <span><strong>Verschobene Schichten</strong> werden zuerst verteilt – die konfigurierte Anzahl Personen pro Woche (Mo-Fr); dadurch wird verhindert, dass danach direkt eine Nachtwoche folgt.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">2.</span>
            <span><strong>Nachtschichten</strong> werden danach verteilt - <strong>exakt 2 Personen</strong> pro Woche (Sa-Sa)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">3.</span>
            <span><strong>Wochenendschichten</strong> werden zuletzt verteilt - <strong>exakt 3 Personen</strong> pro Wochenende (Sa-So)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span><strong>Jeder Mitarbeiter bekommt maximal eine Schicht pro Tag</strong></span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Mitarbeiter im Urlaub werden automatisch übersprungen</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Nachtschichtwoche → keine `Frühschicht` direkt am folgenden Wochenende</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Nach einer <strong>Verschobenen Schicht</strong>-Woche darf in der <strong>gesamten Folgewoche keine Nachtbereitschaft</strong> folgen (7-Tage-Sperrfenster)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Pro Mitarbeiter können erlaubte Schichttypen eingestellt werden – der Algorithmus berücksichtigt diese Einschränkungen automatisch</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Vermeidungspräferenzen werden berücksichtigt</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span><strong>Wichtig:</strong> Kein Wochenenddienst vor oder nach Urlaub</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Mitarbeiter mit einer <strong>verschobenen Schicht</strong> dürfen keine Wochenend-<strong>Frühschicht</strong> am davor/danachliegenden Wochenende erhalten</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Abteilungen werden möglichst gleichmäßig verteilt</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-600 font-bold">•</span>
            <span>Mitarbeiter ohne Schicht bleiben für diese Zeit frei</span>
          </li>
        </ul>
      </div>
    </div>

    {/* Violation Pipeline slide-over */}
    {showPipeline && filteredViolations.length > 0 && (
      <ViolationPipeline
        violations={filteredViolations}
        employees={employees}
        onAcknowledge={(id) => acknowledgeViolation(id)}
        onClose={() => setShowPipeline(false)}
      />
    )}

    {/* Release warning modal (shown when generating while plan is released) */}
    {releaseWarningOpen && (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
          <div className="flex items-center gap-3 mb-3">
            <AlertTriangle className="text-amber-500 flex-shrink-0" size={24} />
            <h3 className="text-lg font-semibold text-gray-800">Plan ist freigegeben</h3>
          </div>
          <p className="text-gray-600 mb-6">
            Der aktuelle Plan ist für die Mitarbeitenden freigegeben. Beim Neugenerieren wird die Freigabe automatisch aufgehoben. Möchten Sie fortfahren?
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setReleaseWarningOpen(false)}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
            >
              Abbrechen
            </button>
            <button
              onClick={doGenerate}
              className="px-4 py-2 bg-amber-600 text-white rounded-md hover:bg-amber-700 font-medium"
            >
              Trotzdem generieren
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Delete plan confirmation modal */}
    {deletePlanOpen && (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
          <div className="flex items-center gap-3 mb-3">
            <AlertTriangle className="text-red-500 flex-shrink-0" size={24} />
            <h3 className="text-lg font-semibold text-gray-800">Schichtplan löschen</h3>
          </div>
          <p className="text-gray-600 mb-6">
            Möchten Sie den Schichtplan wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDeletePlanOpen(false)}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
            >
              Abbrechen
            </button>
            <button
              onClick={() => { setShiftPlan(null as any); setDeletePlanOpen(false); }}
              className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 font-medium"
            >
              Endgültig löschen
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
