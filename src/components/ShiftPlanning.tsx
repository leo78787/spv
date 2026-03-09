import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Calendar, Users, AlertCircle, Sparkles, Download, Settings, ChevronDown, ChevronUp, AlertTriangle, Loader2, Zap } from 'lucide-react';
import { useStore } from '../store';
import { generateAutomaticShiftPlan, DEFAULT_SCHEDULER_CONFIG, SchedulerConfig } from '../utils/scheduler';
import { SHIFT_LABELS } from '../types';
import { getMonthName, generateId, reviveImportedPlan } from '../utils/helpers';
import ViolationPipeline from './ViolationPipeline';
import { ImpactFactors, ImpactDelta, CountImpact, FairnessScores } from '../utils/fairnessImpact';
import InlineFairnessWorker from '../workers/fairnessWorker.ts?worker&inline';
import {
  getOptimiserState,
  subscribeOptimiser,
  startOptimisation,
  cancelOptimisation,
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

// Module-level worker + helpers so background computations survive component
// unmounts (tab switches). The worker is created lazily and kept for the page life.
let moduleWorker: Worker | null = null;
let moduleWorkerNextId = 0;
const moduleWorkerPendingSnapshots: Record<number, string> = {};
const moduleListeners = new Set<(msg: { id: number; result?: ImpactFactors; error?: string; snapshot?: string }) => void>();

function ensureModuleWorker() {
  if (moduleWorker) return moduleWorker;
  moduleWorker = new InlineFairnessWorker();
  moduleWorker.onmessage = (e: MessageEvent<{ id: number; result?: ImpactFactors; error?: string }>) => {
    const { id, result, error } = e.data;
    const snapshot = moduleWorkerPendingSnapshots[id];
    // update module cache if we have a result
    if (result) {
      moduleCachedImpactFactors = result;
      if (snapshot) moduleCachedImpactSnapshot = snapshot;
    }
    // notify listeners (component instances)
    for (const l of moduleListeners) l({ id, result, error, snapshot });
    delete moduleWorkerPendingSnapshots[id];
  };
  return moduleWorker;
}

function postModuleWorkerRequest(payload: { employees: any; schedulerConfig: any; year: number; startMonth: number }, snapshot: string) {
  const worker = ensureModuleWorker();
  const id = ++moduleWorkerNextId;
  moduleWorkerPendingSnapshots[id] = snapshot;
  worker.postMessage({ id, employees: payload.employees, config: payload.schedulerConfig, year: payload.year, startMonth: payload.startMonth });
  return id;
}

function findModulePendingIdForSnapshot(snapshot: string): number | null {
  for (const idStr of Object.keys(moduleWorkerPendingSnapshots)) {
    const id = Number(idStr);
    if (moduleWorkerPendingSnapshots[id] === snapshot) return id;
  }
  return null;
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
  const { employees, departments, shiftPlan, createShiftPlan, addEmployee, addDepartment, setShiftPlan, updateShiftAssignment, addLabel, addCalendarLabel, acknowledgeViolation } = useStore();
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

  // ── Impact factor state ───────────────────────────────────────────────────
  const [impactFactors, setImpactFactors] = useState<ImpactFactors | null>(null);
  const [isComputingImpact, setIsComputingImpact] = useState(false);

  // Monotonically-increasing request counter; stale responses are ignored
  const pendingIdRef = useRef<number>(0);
  // Snapshot of last-computed inputs — used to avoid redundant recomputation
  const lastSnapshotRef = useRef<string | null>(null);
  // Which snapshot the currently-displayed `impactFactors` corresponds to
  const computedSnapshotRef = useRef<string | null>(null);

  // Subscribe to module-level worker notifications (worker itself is
  // module-scoped and kept alive across mounts). We only register a
  // listener here; the worker is NOT terminated on unmount so a running
  // computation continues when the component is unmounted.
  useEffect(() => {
    const handler = (msg: { id: number; result?: ImpactFactors; error?: string; snapshot?: string }) => {
      const { id, result, error, snapshot } = msg;
      // Component only cares about the latest request it issued
      if (id !== pendingIdRef.current) return;
      if (error) {
        console.error('[fairnessWorker]', error);
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
    moduleListeners.add(handler);
    // ensure worker exists so in-flight background computations keep running
    ensureModuleWorker();
    return () => void moduleListeners.delete(handler);
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
      .map(e => ({ id: e.id, isOver55: e.isOver55, hasL2: e.hasL2, department: e.department, prefs: e.preferences?.length ?? 0 }))
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

    // If another (module-level) request for the same snapshot is in flight,
    // attach to it instead of re-posting — show spinner while waiting.
    const existingId = findModulePendingIdForSnapshot(snapshot);
    if (existingId !== null) {
      pendingIdRef.current = existingId;
      lastSnapshotRef.current = snapshot;
      setIsComputingImpact(true);
      return;
    }

    // If nothing changed since the last computation within this mounted
    // component and we already have results for that same snapshot, skip
    // recompute as well.
    if (lastSnapshotRef.current === snapshot && computedSnapshotRef.current === snapshot && impactFactors) {
      return;
    }

    // Debounce then post to the worker — keep current preview visible while
    // the new computation runs.
    const timer = setTimeout(() => {
      const id = postModuleWorkerRequest({ employees, schedulerConfig, year: selectedYear, startMonth: selectedMonth }, snapshot);
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

  const setOver55Slots = (val: number) =>
    setSchedulerConfig(c => ({ ...c, over55VerschiebenSlots: val }));

  // Persist current schedulerConfig to module cache so edits survive unmounts
  useEffect(() => {
    moduleCachedSchedulerConfig = schedulerConfig;
  }, [schedulerConfig]);

  const handleGenerateFullPlan = () => {
    if (employees.length === 0) {
      setGenerationResult({
        success: false,
        message: 'Keine Mitarbeiter vorhanden. Bitte fügen Sie zuerst Mitarbeiter hinzu.',
        assignmentCount: 0
      });
      return;
    }

    setIsGenerating(true);
    setGenerationResult(null);

    // Simulate async operation for better UX
    setTimeout(() => {
      try {
        const { assignments, violations } = generateAutomaticShiftPlan(employees, selectedYear, selectedMonth, 12, schedulerConfig);
        
        // Remove any existing plan for the selected start year/month, then store new assignments
        createShiftPlan(selectedYear, selectedMonth, 12, schedulerConfig, violations, 'automatisch generiert');
        assignments.forEach(assignment => updateShiftAssignment(assignment));

        // Open the pipeline automatically if there are unresolvable violations
        if (violations.length > 0) {
          setShowPipeline(true);
        }

        const end = new Date(selectedYear, selectedMonth + 12, 0); // last day of 12-month period

        setGenerationResult({
          success: true,
          message: `Schichtplan erfolgreich generiert für ${getMonthName(selectedMonth)} ${selectedYear} — ${getMonthName(end.getMonth())} ${end.getFullYear()}`,
          assignmentCount: assignments.length
        });
      } catch (error) {
        setGenerationResult({
          success: false,
          message: 'Fehler beim Generieren des Schichtplans.',
          assignmentCount: 0
        });
      } finally {
        setIsGenerating(false);
      }
    }, 500);
  };

  // ── Optimizer handlers (delegate to persistent manager) ────────────────
  const handleOptimise = useCallback(() => {
    if (employees.length === 0) return;
    startOptimisation(employees, schedulerConfig, selectedYear, selectedMonth);
  }, [employees, schedulerConfig, selectedYear, selectedMonth]);

  const handleCancelOptimiser = useCallback(() => {
    cancelOptimisation();
  }, []);

  const planStart = new Date(selectedYear, selectedMonth, 1);
  const planEnd = new Date(selectedYear, selectedMonth + 12, 0); // last day of the 12-month range

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
      const revived = reviveImportedPlan(parsed);
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
            isOver55: !!ie.isOver55,
            hasL2: !!ie.hasL2,
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

                {/* Ü55-Slots */}
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200 space-y-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-gray-700">Ü55-Slots (Versetzt reserviert)</span>
                    <input
                      type="number" min={0} max={schedulerConfig.shiftCounts.verschieben}
                      value={schedulerConfig.over55VerschiebenSlots}
                      onChange={e => setOver55Slots(Math.min(schedulerConfig.shiftCounts.verschieben, Math.max(0, Number(e.target.value))))}
                      className="w-24 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
                      disabled={!schedulerConfig.rules.reserveOver55SlotsForVerschieben}
                    />
                  </label>
                  <p className="text-xs text-gray-400">Fairness-Auswirkung:</p>
                  <CountImpactBadges ci={impactFactors?.counts.over55Slots} baseline={impactFactors?.baseline} loading={isComputingImpact} unit="Slot" />
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
                  { key: 'over55AndNoL2OnlyVerschieben',        label: 'Ü55-Mitarbeiter und ohne L2 nur versetzte Schichten' },
                  { key: 'reserveOver55SlotsForVerschieben',    label: 'Ü55-Slot-Reservierung in versetzter Schicht' },
                  { key: 'respectAvoidancePreferences',         label: 'Vermeidungspräferenzen der Mitarbeiter berücksichtigen' },
                  { key: 'departmentDiversity',                 label: 'Abteilungsvielfalt bei der Auswahl bevorzugen' },
                ] as { key: keyof SchedulerConfig['rules']; label: string }[]).map(({ key, label }) => (
                  <div key={key} className="bg-gray-50 rounded-lg px-3 py-2 border border-gray-200">
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

      {/* Year Selection & Generate */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Startjahr</label>
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(Number(e.target.value))}
                className="w-full md:w-64 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {[2024, 2025, 2026, 2027, 2028].map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
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

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleGenerateFullPlan}
              disabled={isGenerating || isOptimising || employees.length === 0}
              className="inline-flex items-center gap-2 px-6 py-3 bg-primary-600 text-white rounded-md hover:bg-primary-700 disabled:bg-gray-300 disabled:cursor-not-allowed font-medium text-lg"
            >
              <Sparkles className="h-5 w-5" />
              {isGenerating ? 'Generiere Schichtplan...' : 'Schichtplan generieren'}
            </button>

            {(shiftPlan?.violations?.length ?? 0) > 0 && (
              <button
                onClick={() => setShowPipeline(true)}
                className="inline-flex items-center gap-2 px-4 py-3 bg-amber-500 text-white rounded-md hover:bg-amber-600 font-medium text-base transition-colors"
                title="Regelprobleme anzeigen"
              >
                <AlertTriangle className="h-5 w-5" />
                {shiftPlan!.violations!.length} Regelverstoß{shiftPlan!.violations!.length !== 1 ? 'e' : ''}
              </button>
            )}
          </div>

          {employees.length === 0 && (
            <div className="flex items-start gap-2 text-amber-600 bg-amber-50 p-3 rounded-md">
              <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
              <p className="text-sm">
                Bitte fügen Sie zuerst Mitarbeiter hinzu, bevor Sie einen Schichtplan generieren.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ─── Fairness Optimiser Panel ─────────────────────────────────── */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Zap className="h-5 w-5 text-amber-500" />
          Fairness-Optimierung (iterativ)
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          Erzeugt zunächst einen Plan mit dem normalen Algorithmus und verbessert ihn dann iterativ
          durch zufällige generierte Schichtpläne (Monte Carlo Simulation). Alle harten Regeln (Planungsregeln & Schichtbesetzung) und
          Urlaubszeiten werden eingehalten.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          {/* Max iterations */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Maximale Iterationen</label>
            <input
              type="number"
              min={100}
              max={100000}
              step={500}
              value={optimiserMaxIter}
              onChange={e => setMaxIterations(Number(e.target.value))}
              disabled={isOptimising}
              className="w-40 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
            {(() => {
              // Show estimated time before starting, based on previous run data
              const est = msPerIteration != null ? msPerIteration * optimiserMaxIter : null;
              if (est != null && !isOptimising) {
                const secs = Math.round(est / 1000);
                const display = secs >= 60 ? `ca. ${Math.floor(secs / 60)} Min ${secs % 60} Sek` : `ca. ${secs} Sek`;
                return <p className="text-xs text-amber-600 mt-1">Geschätzte Dauer: {display}</p>;
              }
              return <p className="text-xs text-gray-400 mt-1">Der Algorithmus durchläuft immer alle Iterationen.</p>;
            })()}
          </div>

          {/* Target dimensions */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Optimierungsziel</label>
            <div className="flex flex-wrap gap-3">
              {([
                { key: 'overall' as const, label: 'Gesamt' },
                { key: 'verschieben' as const, label: 'Versetzt' },
                { key: 'nacht' as const, label: 'Nacht' },
                { key: 'frueh' as const, label: 'Früh/WE' },
              ]).map(({ key, label }) => (
                <label key={key} className="inline-flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={optimiserTargets[key]}
                    disabled={isOptimising}
                    onChange={() => setTargets({ ...optimiserTargets, [key]: !optimiserTargets[key] })}
                    className="rounded border-gray-300 text-amber-500 focus:ring-amber-400"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Start / Cancel button */}
        <div className="flex items-center gap-3 mb-3">
          {!isOptimising ? (
            <button
              onClick={handleOptimise}
              disabled={isGenerating || employees.length === 0 || !Object.values(optimiserTargets).some(Boolean)}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-amber-500 text-white rounded-md hover:bg-amber-600 disabled:bg-gray-300 disabled:cursor-not-allowed font-medium"
            >
              <Zap className="h-4 w-4" />
              Optimierung starten
            </button>
          ) : (
            <button
              onClick={handleCancelOptimiser}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-red-500 text-white rounded-md hover:bg-red-600 font-medium"
            >
              Abbrechen
            </button>
          )}
        </div>

        {/* Progress bar */}
        {isOptimising && optimiserProgress && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-gray-600">
              <span>Iteration {optimiserProgress.iteration.toLocaleString()} / {optimiserProgress.maxIterations.toLocaleString()}</span>
              {(() => {
                const remaining = optimiserProgress.estimatedTotalMs - optimiserProgress.elapsedMs;
                if (remaining > 0) {
                  const secs = Math.round(remaining / 1000);
                  const display = secs >= 60 ? `${Math.floor(secs / 60)} Min ${secs % 60} Sek` : `${secs} Sek`;
                  return <span>Verbleibend: {display}</span>;
                }
                return null;
              })()}
              <span>Bester Score: {optimiserProgress.bestScore.toFixed(1)} %</span>
            </div>
            <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-amber-500 transition-all duration-200 rounded-full"
                style={{ width: `${Math.min(100, (optimiserProgress.iteration / optimiserProgress.maxIterations) * 100)}%` }}
              />
            </div>
            <div className="flex gap-3 text-xs text-gray-500">
              <span>Gesamt: {optimiserProgress.currentScores.overall.toFixed(1)}%</span>
              <span>Versetzt: {optimiserProgress.currentScores.verschieben.toFixed(1)}%</span>
              <span>Nacht: {optimiserProgress.currentScores.nacht.toFixed(1)}%</span>
              <span>Früh: {optimiserProgress.currentScores.frueh.toFixed(1)}%</span>
            </div>
          </div>
        )}

        {/* Result display */}
        {optimiserResult && !isOptimising && (
          <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-1">
            <p className="text-sm font-medium text-amber-900">
              Optimierung abgeschlossen nach {optimiserResult.iterations.toLocaleString()} Iterationen
            </p>
            <div className="flex gap-4 text-sm text-amber-800">
              <span>Gesamt: <strong>{optimiserResult.scores.overall.toFixed(1)}%</strong></span>
              <span>Versetzt: <strong>{optimiserResult.scores.verschieben.toFixed(1)}%</strong></span>
              <span>Nacht: <strong>{optimiserResult.scores.nacht.toFixed(1)}%</strong></span>
              <span>Früh/WE: <strong>{optimiserResult.scores.frueh.toFixed(1)}%</strong></span>
            </div>
          </div>
        )}
      </div>
        {/* Algorithm info box */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mt-4">
        <p className="text-sm text-gray-700">
          Algorithmus des aktuellen Plans: <strong>{shiftPlan?.algorithm ?? 'unbekannt'}</strong>
        </p>
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
            <span><strong>Verschobene Schichten</strong> werden zuerst verteilt - <strong>exakt 5 Personen</strong> pro Woche (Mo-Fr, davon 2 Mitarbeiter Ü55); dadurch wird verhindert, dass danach direkt eine Nachtwoche folgt.</span>
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
            <span>Mitarbeiter Ü55 und Mitarbeiter ohne L2-Zertifikat dürfen nur <strong>verschobene Schichten</strong> (Mo–Fr) erhalten; davon werden <strong>2 der 5 Plätze</strong> für Ü55-Mitarbeiter reserviert</span>
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
    {showPipeline && (shiftPlan?.violations?.length ?? 0) > 0 && (
      <ViolationPipeline
        violations={shiftPlan!.violations!}
        employees={employees}
        onAcknowledge={(id) => acknowledgeViolation(id)}
        onClose={() => setShowPipeline(false)}
      />
    )}
    </>
  );
}
