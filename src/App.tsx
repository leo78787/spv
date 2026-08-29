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
      useStore.getState().loadAdminMe();
    }
  }, [authenticated]);

  // If the server rejects our token (e.g. it was restarted and lost its
  // in-memory sessions) loadFromServer()/loadAdminMe() flag this — drop back
  // to the login screen automatically instead of getting stuck showing
  // stale/empty data until the user manually clears site data.
  const sessionExpired = useStore(s => s.sessionExpired);
  useEffect(() => {
    if (sessionExpired) {
      setAuthenticated(false);
      setStateLoaded(false);
      useStore.setState({ sessionExpired: false });
    }
  }, [sessionExpired]);

  // Real-time polling: watch for state changes made by employees / other tabs
  useEffect(() => {
    if (!authenticated) return;
    let lastVersion: string | null = null;
    const poll = async () => {
      const token = getAuthToken();
      if (!token) return;
      try {
        const resp = await fetch('/api/state/version', { headers: { Authorization: `Bearer ${token}` } });
        if (resp.status === 401) {
          clearAuthToken();
          useStore.setState({ sessionExpired: true });
          return;
        }
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

  // Real-time polling: role/permissions/tab-visibility can be changed by an
  // Admin elsewhere (Team tab, orga portal) while this session stays open —
  // re-check periodically instead of requiring logout/login to pick it up.
  useEffect(() => {
    if (!authenticated) return;
    const timer = setInterval(() => { useStore.getState().loadAdminMe(); }, 10000);
    return () => clearInterval(timer);
  }, [authenticated]);

  const swapSettings = useStore(s => s.swapSettings);
  const effectiveTabVisibility = useStore(s => s.effectiveTabVisibility) || DEFAULT_TAB_VISIBILITY;

  const allTabs = [
    { id: 'employees' as ViewTab, label: 'Mitarbeiter', icon: Users },
    { id: 'departments' as ViewTab, label: 'Abteilungen', icon: Building2 },
    { id: 'planning' as ViewTab, label: 'Planung', icon: ClipboardList },
    { id: 'calendar' as ViewTab, label: 'Kalender', icon: Calendar },
    { id: 'kpis' as ViewTab, label: 'Fairness KPIs', icon: BarChart3 },
    ...(swapSettings.enabled ? [{ id: 'swaps' as ViewTab, label: 'Tauschen', icon: ArrowLeftRight }] : []),
  ];

  const tabs = allTabs.filter(t => {
    return (effectiveTabVisibility as any)[t.id] !== false;
  });

  // If the currently active tab becomes hidden (e.g. an Admin restricts
  // Betrachter tab visibility while this session is open), redirect to the
  // first still-visible tab instead of leaving a blank/orphaned view.
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some(t => t.id === activeTab)) {
      handleSetTab(tabs[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.map(t => t.id).join(',')]);

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
        <p className="mt-1"><a href="https://schichtapp.de/impressum.html?from=admin" className="text-gray-500 underline hover:text-gray-700">Impressum</a></p>
      </footer>
    </div>
  );
}

export default App;
