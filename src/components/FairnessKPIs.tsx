import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import { ShiftType, SHIFT_LABELS, Employee } from '../types';
import { BarChart3, TrendingUp, AlertCircle, Award } from 'lucide-react';


interface EmployeeShiftStats {
  employeeId: string;
  employeeName: string;
  department: string;
  isOver55: boolean;
  hasL2: boolean;
  totalShifts: number;
  shiftsByType: Record<ShiftType, number>;
  canWorkShifts: ShiftType[];
  utilizationRate: number; // Percentage of shifts assigned vs available
}

export function FairnessKPIs() {
  const { employees, departments, shiftPlan } = useStore();
  const [selectedShiftType, setSelectedShiftType] = useState<ShiftType | 'all'>('all');
  
  // Determine if an employee can work a specific shift
  // - Mitarbeiter Ü55 dürfen nur "verschieben"
  // - Mitarbeiter ohne L2 dürfen nur "verschieben"
  const canEmployeeWorkShift = (employee: Employee, shiftType: ShiftType): boolean => {
    if (employee.isOver55 || !employee.hasL2) {
      return shiftType === 'verschieben';
    }
    return true;
  };
  
  // Calculate statistics for each employee
  const employeeStats: EmployeeShiftStats[] = useMemo(() => {
    if (!shiftPlan) return [];
    
    return employees.map(employee => {
      const assignments = shiftPlan.assignments.filter(a => 
        a.employees.includes(employee.id)
      );
      
      const totalShifts = assignments.length;
      
      const shiftsByType: Record<ShiftType, number> = {
        fruehschicht: 0,
        verschieben: 0,
        nachtbereitschaft: 0
      };
      
      assignments.forEach(assignment => {
        shiftsByType[assignment.shiftType]++;
      });
      
      // Determine which shifts this employee can work
      const canWorkShifts: ShiftType[] = [];
      (['fruehschicht', 'verschieben', 'nachtbereitschaft'] as ShiftType[]).forEach(shiftType => {
        if (canEmployeeWorkShift(employee, shiftType)) {
          canWorkShifts.push(shiftType);
        }
      });
      
      // Calculate utilization rate
      // This is a simplified calculation - in reality you'd compare against expected workload
      const utilizationRate = totalShifts > 0 ? (totalShifts / 52) * 100 : 0; // Assuming ~1 shift per week is 100%
      
      const dept = departments.find(d => d.id === employee.department);
      
      return {
        employeeId: employee.id,
        employeeName: employee.name,
        department: dept?.name || 'Unbekannt',
        isOver55: employee.isOver55,
        hasL2: employee.hasL2,
        totalShifts,
        shiftsByType,
        canWorkShifts,
        utilizationRate: Math.min(utilizationRate, 100)
      };
    });
  }, [employees, departments, shiftPlan]);
  
  // Filter stats based on selected shift type
  const filteredStats = useMemo(() => {
    if (selectedShiftType === 'all') return employeeStats;
    
    return employeeStats.filter(stat => 
      stat.canWorkShifts.includes(selectedShiftType)
    );
  }, [employeeStats, selectedShiftType]);
  
  // Calculate overall fairness metrics
  const fairnessMetrics = useMemo(() => {
    if (filteredStats.length === 0) return null;
    
    const shifts = selectedShiftType === 'all'
      ? filteredStats.map(s => s.totalShifts)
      : filteredStats.map(s => s.shiftsByType[selectedShiftType]);
    
    const total = shifts.reduce((sum, count) => sum + count, 0);
    const average = total / shifts.length;
    const max = Math.max(...shifts);
    const min = Math.min(...shifts);
    const range = max - min;
    
    // Calculate standard deviation
    const variance = shifts.reduce((sum, count) => sum + Math.pow(count - average, 2), 0) / shifts.length;
    const stdDev = Math.sqrt(variance);
    
    // Fairness score (0-100, higher is better/more fair)
    // Based on how close the distribution is to perfectly equal
    const fairnessScore = average > 0 
      ? Math.max(0, 100 - (stdDev / average) * 100)
      : 100;
    
    return {
      total,
      average: Number(average.toFixed(2)),
      max,
      min,
      range,
      stdDev: Number(stdDev.toFixed(2)),
      fairnessScore: Number(fairnessScore.toFixed(1))
    };
  }, [filteredStats, selectedShiftType]);
  
  // Get color based on fairness score
  const getFairnessColor = (score: number) => {
    if (score >= 80) return 'text-green-600 bg-green-50 border-green-200';
    if (score >= 60) return 'text-yellow-600 bg-yellow-50 border-yellow-200';
    return 'text-red-600 bg-red-50 border-red-200';
  };
  
  const getFairnessLabel = (score: number) => {
    if (score >= 80) return 'Sehr fair';
    if (score >= 60) return 'Akzeptabel';
    return 'Unausgewogen';
  };
  
  // Sort employees by shift count for the selected type
  const sortedStats = useMemo(() => {
    return [...filteredStats].sort((a, b) => {
      const aCount = selectedShiftType === 'all' ? a.totalShifts : a.shiftsByType[selectedShiftType];
      const bCount = selectedShiftType === 'all' ? b.totalShifts : b.shiftsByType[selectedShiftType];
      return bCount - aCount;
    });
  }, [filteredStats, selectedShiftType]);
  
  if (!shiftPlan) {
    return (
      <div className="p-6">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
          <AlertCircle className="mx-auto mb-3 text-yellow-600" size={48} />
          <h3 className="text-lg font-semibold text-yellow-800 mb-2">Kein Schichtplan vorhanden</h3>
          <p className="text-yellow-700">Bitte erstellen Sie zuerst einen Schichtplan in der Planung.</p>
        </div>
      </div>
    );
  }
  
  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Fairness KPIs</h2>
        <p className="text-gray-600">Echtzeit-Analyse der Schichtverteilung für {shiftPlan?.startMonth !== undefined && shiftPlan?.months ? (
          `${new Date(shiftPlan.year, shiftPlan.startMonth!).toLocaleString('de-DE', { month: 'long' })} ${shiftPlan.year} — ${new Date(shiftPlan.year, (shiftPlan.startMonth! + shiftPlan.months!) - 1).toLocaleString('de-DE', { month: 'long' })} ${new Date(shiftPlan.year, shiftPlan.startMonth!).getFullYear() + Math.floor((shiftPlan.startMonth! + shiftPlan.months! - 1) / 12)}`
        ) : (
          `${shiftPlan?.year}`
        )}</p>
      </div>
      
      {/* Filter */}
      <div className="mb-6 flex items-center gap-4">
        <label className="text-sm font-medium text-gray-700">Schichttyp:</label>
        <select
          value={selectedShiftType}
          onChange={e => setSelectedShiftType(e.target.value as ShiftType | 'all')}
          className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          <option value="all">Alle Schichten</option>
          {Object.entries(SHIFT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>
      
      {/* Overall Fairness Metrics */}
      {fairnessMetrics && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div className={`p-4 rounded-lg border-2 ${getFairnessColor(fairnessMetrics.fairnessScore)}`}>
            <div className="flex items-center gap-2 mb-2">
              <Award size={24} />
              <h3 className="font-semibold">Fairness Score</h3>
            </div>
            <div className="text-3xl font-bold">{fairnessMetrics.fairnessScore}%</div>
            <div className="text-sm mt-1">{getFairnessLabel(fairnessMetrics.fairnessScore)}</div>
          </div>
          
          <div className="bg-white p-4 rounded-lg border-2 border-gray-200">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 size={24} className="text-blue-600" />
              <h3 className="font-semibold text-gray-800">Durchschnitt</h3>
            </div>
            <div className="text-3xl font-bold text-gray-900">{fairnessMetrics.average}</div>
            <div className="text-sm text-gray-600 mt-1">Schichten pro Mitarbeiter</div>
          </div>
          
          <div className="bg-white p-4 rounded-lg border-2 border-gray-200">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp size={24} className="text-purple-600" />
              <h3 className="font-semibold text-gray-800">Spannweite</h3>
            </div>
            <div className="text-3xl font-bold text-gray-900">{fairnessMetrics.range}</div>
            <div className="text-sm text-gray-600 mt-1">Max ({fairnessMetrics.max}) - Min ({fairnessMetrics.min})</div>
          </div>
          
          <div className="bg-white p-4 rounded-lg border-2 border-gray-200">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 size={24} className="text-indigo-600" />
              <h3 className="font-semibold text-gray-800">Standardabweichung</h3>
            </div>
            <div className="text-3xl font-bold text-gray-900">{fairnessMetrics.stdDev}</div>
            <div className="text-sm text-gray-600 mt-1">Vom Durchschnitt</div>
          </div>
        </div>
      )}
      
      {/* Employee Distribution Table */}
      <div className="bg-white rounded-lg shadow-md overflow-hidden">
        <div className="p-4 bg-gray-50 border-b border-gray-200">
          <h3 className="font-semibold text-lg">Schichtverteilung nach Mitarbeiter</h3>
          <p className="text-sm text-gray-600 mt-1">
            {selectedShiftType === 'all' 
              ? `Zeigt alle ${employeeStats.length} Mitarbeiter`
              : `Zeigt ${filteredStats.length} Mitarbeiter, die ${SHIFT_LABELS[selectedShiftType]} machen können (Ü55 / ohne L2 werden für diese Kategorie nicht berücksichtigt)`
            }
          </p>
        </div>
        
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Rang</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Mitarbeiter</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Abteilung</th>
                {selectedShiftType === 'all' ? (
                  <>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700">Frühschicht</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700">Verschoben</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700">Nacht</th>
                  </>
                ) : null}
                <th className="px-4 py-3 text-center font-semibold text-gray-700">
                  {selectedShiftType === 'all' ? 'Gesamt' : 'Anzahl'}
                </th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">Abweichung</th>
              </tr>
            </thead>
            <tbody>
              {sortedStats.map((stat, index) => {
                const shiftCount = selectedShiftType === 'all' 
                  ? stat.totalShifts 
                  : stat.shiftsByType[selectedShiftType];
                const deviation = fairnessMetrics 
                  ? ((shiftCount - fairnessMetrics.average) / fairnessMetrics.average * 100).toFixed(1)
                  : '0';
                const isAboveAverage = Number(deviation) > 0;
                
                return (
                  <tr key={stat.employeeId} className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                    <td className="px-4 py-3 border-b border-gray-200">
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-200 font-semibold text-gray-700">
                        {index + 1}
                      </div>
                    </td>
                    <td className="px-4 py-3 border-b border-gray-200 font-medium text-gray-800">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span>{stat.employeeName}</span>
                        {stat.isOver55 && (
                          <span className="inline-block px-1.5 py-0.5 text-xs font-semibold rounded bg-amber-100 text-amber-800 border border-amber-300">Ü55</span>
                        )}
                        {!stat.hasL2 && (
                          <span className="inline-block px-1.5 py-0.5 text-xs font-semibold rounded bg-red-100 text-red-700 border border-red-300">kein L2</span>
                        )}
                        {stat.hasL2 && (
                          <span className="inline-block px-1.5 py-0.5 text-xs font-semibold rounded bg-green-100 text-green-700 border border-green-300">L2</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 border-b border-gray-200 text-gray-600">
                      {stat.department}
                    </td>
                    {selectedShiftType === 'all' ? (
                      <>
                        <td className="px-4 py-3 border-b border-gray-200 text-center">
                          {stat.shiftsByType.fruehschicht}
                        </td>
                        <td className="px-4 py-3 border-b border-gray-200 text-center">
                          {stat.shiftsByType.verschieben}
                        </td>
                        <td className="px-4 py-3 border-b border-gray-200 text-center">
                          {stat.shiftsByType.nachtbereitschaft}
                        </td>
                      </>
                    ) : null}
                    <td className="px-4 py-3 border-b border-gray-200 text-center">
                      <span className="inline-block px-3 py-1 bg-primary-100 text-primary-800 rounded-full font-semibold">
                        {shiftCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 border-b border-gray-200 text-center">
                      <span className={`inline-block px-3 py-1 rounded-full font-semibold ${
                        Math.abs(Number(deviation)) < 10 
                          ? 'bg-green-100 text-green-800'
                          : Math.abs(Number(deviation)) < 25
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-red-100 text-red-800'
                      }`}>
                        {isAboveAverage ? '+' : ''}{deviation}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      
      {/* Visual Distribution Chart */}
      {fairnessMetrics && sortedStats.length > 0 && (
        <div className="mt-6 bg-white rounded-lg shadow-md p-6">
          <h3 className="font-semibold text-lg mb-4">Visuelle Verteilung</h3>
          <div className="space-y-3">
            {sortedStats.map(stat => {
              const shiftCount = selectedShiftType === 'all' 
                ? stat.totalShifts 
                : stat.shiftsByType[selectedShiftType];
              const percentage = fairnessMetrics.max > 0 
                ? (shiftCount / fairnessMetrics.max) * 100 
                : 0;
              
              return (
                <div key={stat.employeeId}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-700">{stat.employeeName}</span>
                      {stat.isOver55 && (
                        <span className="inline-block px-1.5 py-0.5 text-xs font-semibold rounded bg-amber-100 text-amber-800 border border-amber-300">Ü55</span>
                      )}
                      {!stat.hasL2 && (
                        <span className="inline-block px-1.5 py-0.5 text-xs font-semibold rounded bg-red-100 text-red-700 border border-red-300">kein L2</span>
                      )}
                      {stat.hasL2 && (
                        <span className="inline-block px-1.5 py-0.5 text-xs font-semibold rounded bg-green-100 text-green-700 border border-green-300">L2</span>
                      )}
                    </div>
                    <span className="text-sm text-gray-600">{shiftCount} Schichten</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-4 overflow-hidden">
                    <div 
                      className="bg-primary-600 h-full rounded-full transition-all duration-300"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      
      {/* Recommendations */}
      {fairnessMetrics && fairnessMetrics.fairnessScore < 70 && (
        <div className="mt-6 bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded">
          <div className="flex items-start">
            <AlertCircle className="text-yellow-600 mr-3 flex-shrink-0" size={24} />
            <div>
              <h4 className="font-semibold text-yellow-800 mb-2">Empfehlungen zur Verbesserung der Fairness</h4>
              <ul className="text-sm text-yellow-700 list-disc list-inside space-y-1">
                <li>Überprüfen Sie die Schichtzuweisung für Mitarbeiter mit überdurchschnittlich vielen Schichten</li>
                <li>Berücksichtigen Sie die Umverteilung von Schichten an weniger ausgelastete Mitarbeiter</li>
                <li>Nutzen Sie die Mitarbeiter-Präferenzen in der Mitarbeiterverwaltung zur besseren Planung</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
