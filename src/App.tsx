import React, { useState } from 'react';
import { EmployeeManagement } from './components/EmployeeManagement';
import { DepartmentManagement } from './components/DepartmentManagement';
import { ShiftPlanning } from './components/ShiftPlanning';
import { CalendarView } from './components/CalendarView';
import { FairnessKPIs } from './components/FairnessKPIs';
import { ViewTab, DEFAULT_TAB_VISIBILITY } from './types';
import { Users, Calendar, ClipboardList, Building2, BarChart3, Settings } from 'lucide-react';
import { HolidaySettings } from './components/HolidaySettings';
import { useStore } from './store';

function App() {
  const [activeTab, setActiveTab] = useState<ViewTab>(() => {
    const saved = localStorage.getItem('spm-last-tab');
    return (saved as ViewTab) || 'employees';
  });
  const [showHolidaySettings, setShowHolidaySettings] = useState(false);

  const handleSetTab = (tab: ViewTab) => {
    setActiveTab(tab);
    localStorage.setItem('spm-last-tab', tab);
  };

  const tabVisibility = useStore(s => s.tabVisibility) || DEFAULT_TAB_VISIBILITY;

  const allTabs = [
    { id: 'employees' as ViewTab, label: 'Mitarbeiter', icon: Users },
    { id: 'departments' as ViewTab, label: 'Abteilungen', icon: Building2 },
    { id: 'planning' as ViewTab, label: 'Planung', icon: ClipboardList },
    { id: 'calendar' as ViewTab, label: 'Kalender', icon: Calendar },
    { id: 'kpis' as ViewTab, label: 'Fairness KPIs', icon: BarChart3 },
  ];

  const tabs = allTabs.filter(t => {
    return (tabVisibility as any)[t.id] !== false;
  });
  
  const SettingsButton = () => (
    <button onClick={() => setShowHolidaySettings(true)} title="Einstellungen: Feiertage verwalten" className="px-3 py-2 rounded hover:bg-gray-50 border border-gray-100 text-gray-600">
      <Settings size={16} />
    </button>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Header */}
      <header className="bg-white shadow-md">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-3 sm:py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="bg-primary-600 p-1.5 sm:p-2 rounded-lg">
                <Calendar className="text-white" size={22} />
              </div>
              <div>
                <h1 className="text-lg sm:text-2xl font-bold text-gray-900">Schichtplan Manager</h1>
                <p className="text-xs sm:text-sm text-gray-600 hidden sm:block">Lokale Version — Offline-Betrieb</p>
              </div>
            </div>
            <div className="flex items-center gap-1 sm:gap-2">
              <SettingsButton />
            </div>
          </div>
        </div>
        
        {/* Navigation Tabs */}
        <nav className="border-t border-gray-200">
          <div className="max-w-7xl mx-auto px-0 sm:px-6 lg:px-8">
            <div className="flex overflow-x-auto scrollbar-hide">
              {tabs.map(tab => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                
                return (
                  <button
                    key={tab.id}
                    onClick={() => handleSetTab(tab.id)}
                    className={`
                      flex items-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-3 sm:py-4 text-xs sm:text-sm font-medium transition-colors relative whitespace-nowrap flex-shrink-0
                      ${isActive 
                        ? 'text-primary-600 bg-primary-50' 
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                      }
                    `}
                  >
                    <Icon size={18} />
                    <span className="hidden xs:inline">{tab.label}</span>
                    {isActive && (
                      <div className="absolute bottom-0 left-0 right-0 h-1 bg-primary-600"></div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </nav>
      </header>
      
      {/* Main Content */}
      <main className="max-w-7xl mx-auto">
        {activeTab === 'employees' && <EmployeeManagement />}
        {activeTab === 'departments' && <DepartmentManagement />}
        {activeTab === 'planning' && <ShiftPlanning />}
        {activeTab === 'calendar' && <CalendarView />}
        {activeTab === 'kpis' && <FairnessKPIs />}
      </main>
      
      {/* Holiday settings modal */}
      {showHolidaySettings && (
        <React.Suspense>
          <HolidaySettings onClose={() => setShowHolidaySettings(false)} />
        </React.Suspense>
      )}

      {/* Footer */}
      <footer className="mt-12 py-6 text-center text-sm text-gray-600 border-t border-gray-200">
        <p>Schichtplan Manager &copy; 2026 — Lokale Version</p>
      </footer>
    </div>
  );
}

export default App;
