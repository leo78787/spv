import React, { useState } from 'react';
import { EmployeeManagement } from './components/EmployeeManagement';
import { DepartmentManagement } from './components/DepartmentManagement';
import { ShiftPlanning } from './components/ShiftPlanning';
import { CalendarView } from './components/CalendarView';
import { FairnessKPIs } from './components/FairnessKPIs';
import { ViewTab } from './types';
import { Users, Calendar, ClipboardList, Building2, BarChart3, Settings, LogOut } from 'lucide-react';
import { HolidaySettings } from './components/HolidaySettings';
import { Login } from './components/Login';

function App() {
  const [activeTab, setActiveTab] = useState<ViewTab>('employees');
  const [showHolidaySettings, setShowHolidaySettings] = useState(false);

  // simple client-side auth (persisted in localStorage)
  const [authenticated, setAuthenticated] = useState<boolean>(() => {
    try {
      return localStorage.getItem('spm-authenticated') === 'true';
    } catch (err) {
      return false;
    }
  });

  
  const tabs = [
    { id: 'employees' as ViewTab, label: 'Mitarbeiter', icon: Users },
    { id: 'departments' as ViewTab, label: 'Abteilungen', icon: Building2 },
    { id: 'planning' as ViewTab, label: 'Planung', icon: ClipboardList },
    { id: 'calendar' as ViewTab, label: 'Kalender', icon: Calendar },
    { id: 'kpis' as ViewTab, label: 'Fairness KPIs', icon: BarChart3 },
  ];
  
  const SettingsButton = () => (
    <button onClick={() => setShowHolidaySettings(true)} title="Einstellungen: Feiertage verwalten" className="px-3 py-2 rounded hover:bg-gray-50 border border-gray-100 text-gray-600">
      <Settings size={16} />
    </button>
  );
  
  // if not authenticated show login screen only
  if (!authenticated) {
    return <Login onSuccess={() => setAuthenticated(true)} />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Header */}
      <header className="bg-white shadow-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="bg-primary-600 p-2 rounded-lg">
                <Calendar className="text-white" size={28} />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Schichtplan Manager</h1>
                <p className="text-sm text-gray-600">Intelligente Schichtplanung für Ihr Unternehmen</p>
              </div>
            </div>
          </div>
        </div>
        
        {/* Navigation Tabs */}
        <nav className="border-t border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between w-full">
              <div className="flex space-x-1">
                {tabs.map(tab => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`
                        flex items-center gap-2 px-6 py-4 font-medium transition-colors relative
                        ${isActive 
                          ? 'text-primary-600 bg-primary-50' 
                          : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                        }
                      `}
                    >
                      <Icon size={20} />
                      {tab.label}
                      {isActive && (
                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-primary-600"></div>
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="pr-2 flex items-center gap-2">
                <SettingsButton />
                <button
                  onClick={() => {
                    localStorage.removeItem('spm-authenticated');
                    setAuthenticated(false);
                  }}
                  title="Abmelden"
                  className="px-3 py-2 rounded hover:bg-gray-50 border border-gray-100 text-gray-600 flex items-center gap-2"
                >
                  <LogOut size={14} />
                  Abmelden
                </button>
              </div>
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
        <p>Schichtplan Manager © {new Date().getFullYear()}</p>
      </footer>
    </div>
  );
}

export default App;
