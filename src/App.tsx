import React, { useState, useEffect, lazy, Suspense } from 'react';
import { EmployeeManagement } from './components/EmployeeManagement';
import { DepartmentManagement } from './components/DepartmentManagement';
import { ShiftPlanning } from './components/ShiftPlanning';
import { CalendarView } from './components/CalendarView';
import { FairnessKPIs } from './components/FairnessKPIs';
import { ViewTab, DEFAULT_TAB_VISIBILITY } from './types';
import { Users, Calendar, ClipboardList, Building2, BarChart3, Settings, LogOut, ArrowLeftRight } from 'lucide-react';

const SwapManagement = lazy(() => import('./components/SwapManagement').then(m => ({ default: m.SwapManagement })));
import { HolidaySettings } from './components/HolidaySettings';
import { Login } from './components/Login';
import { getAuthToken, clearAuthToken, loadFromServer, useStore } from './store';

function App() {
  const [activeTab, setActiveTab] = useState<ViewTab>(() => {
    const saved = localStorage.getItem('spm-last-tab');
    return (saved as ViewTab) || 'employees';
  });
  const [showHolidaySettings, setShowHolidaySettings] = useState(false);
  const [stateLoaded, setStateLoaded] = useState(false);

  // Persist last visited tab
  const handleSetTab = (tab: ViewTab) => {
    setActiveTab(tab);
    localStorage.setItem('spm-last-tab', tab);
  };

  // server-based auth — the auth token is stored in localStorage
  const [authenticated, setAuthenticated] = useState<boolean>(() => !!getAuthToken());

  // Hydrate Zustand store from the server after login / on mount
  useEffect(() => {
    if (authenticated) {
      loadFromServer().then(() => setStateLoaded(true));
    }
  }, [authenticated]);

  // Real-time polling: watch for state changes made by employees / other tabs
  useEffect(() => {
    if (!authenticated) return;
    let lastVersion: string | null = null;
    const poll = async () => {
      try {
        const resp = await fetch('/api/state/version');
        const { version } = await resp.json();
        if (lastVersion !== null && version !== lastVersion) {
          await loadFromServer();
        }
        lastVersion = version;
      } catch {}
    };
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, [authenticated]);

  
  const swapSettings = useStore(s => s.swapSettings);
  const tabVisibility = useStore(s => s.tabVisibility) || DEFAULT_TAB_VISIBILITY;

  const allTabs = [
    { id: 'employees' as ViewTab, label: 'Mitarbeiter', icon: Users },
    { id: 'departments' as ViewTab, label: 'Abteilungen', icon: Building2 },
    { id: 'planning' as ViewTab, label: 'Planung', icon: ClipboardList },
    { id: 'calendar' as ViewTab, label: 'Kalender', icon: Calendar },
    { id: 'kpis' as ViewTab, label: 'Fairness KPIs', icon: BarChart3 },
    ...(swapSettings.enabled ? [{ id: 'swaps' as ViewTab, label: 'Tauschen', icon: ArrowLeftRight }] : []),
  ];

  const tabs = allTabs.filter(t => {
    return (tabVisibility as any)[t.id] !== false;
  });
  
  const SettingsButton = () => (
    <button onClick={() => setShowHolidaySettings(true)} title="Einstellungen: Feiertage verwalten" className="px-3 py-2 rounded hover:bg-gray-50 border border-gray-100 text-gray-600">
      <Settings size={16} />
    </button>
  );
  
  // if not authenticated show login screen only
  if (!authenticated) {
    return <Login onSuccess={() => setAuthenticated(true)} />;
  }

  // Wait for server state to load before rendering the main UI
  if (!stateLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100">
        <p className="text-gray-500">Lade Daten vom Server…</p>
      </div>
    );
  }

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
                <p className="text-xs sm:text-sm text-gray-600 hidden sm:block">Der Schichtplanplaner</p>
              </div>
            </div>
            <div className="flex items-center gap-1 sm:gap-2">
              <SettingsButton />
              <button
                onClick={() => {
                  clearAuthToken();
                  setAuthenticated(false);
                  setStateLoaded(false);
                }}
                title="Abmelden"
                className="px-2 sm:px-3 py-2 rounded hover:bg-gray-50 border border-gray-100 text-gray-600 flex items-center gap-1 sm:gap-2"
              >
                <LogOut size={14} />
                <span className="hidden sm:inline text-sm">Abmelden</span>
              </button>
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
        {activeTab === 'swaps' && swapSettings.enabled && (
          <Suspense fallback={<div className="p-6 text-gray-500">Lade Tausch-Verwaltung…</div>}>
            <SwapManagement />
          </Suspense>
        )}
      </main>
      
      {/* Holiday settings modal */}
      {showHolidaySettings && (
        <React.Suspense>
          <HolidaySettings onClose={() => setShowHolidaySettings(false)} />
        </React.Suspense>
      )}

      {/* Footer */}
      <footer className="mt-12 py-6 text-center text-sm text-gray-600 border-t border-gray-200">
        <p>Schichtplan Manager &copy; 2026</p>
        <p className="mt-1"><a href="/portal/impressum.html" className="text-gray-500 underline hover:text-gray-700">Impressum</a></p>
      </footer>
    </div>
  );
}

export default App;
