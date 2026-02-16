# Schichtplan Manager V5

Eine moderne, production-ready Web-Applikation für intelligente Schichtplanung in Unternehmen.

## Features

### ✨ Kernfunktionalitäten

- **Mitarbeiterverwaltung**: Verwaltung von Mitarbeitern mit Abteilungszuordnung
- **Abteilungsverwaltung**: Erstellen, Bearbeiten und Löschen von Abteilungen
- **Mitarbeiter-Schicht Matrix**: Interaktive Matrix-Ansicht
  - Mitarbeiter vertikal, Schichttypen horizontal
  - Schnelle Präferenzänderung per Klick
  - Drei Zustände: Neutral → Bevorzugt → Vermeiden
  - Filterung nach Abteilungen
  - Präferenz-Statistiken in Echtzeit
- **Attribute**: Ü55-Status, L2-Zertifizierung, Urlaubstage, Schichtpräferenzen
- **Intelligente Planung**: KI-gestützte Schichtvorschläge basierend auf:
  - Mitarbeiterpräferenzen
  - Urlaubszeiten
  - Faire Arbeitsverteilung
  - Abteilungszuordnung
- **Drei Schichtarten**:
  - Frühschicht (Wochenende): Sa-So, 2 Personen aus verschiedenen Abteilungen
  - Verschobene Schicht: Mo-Fr, 4 Personen aus verschiedenen Abteilungen
  - Nachtbereitschaft: Sa-Sa, 2 Personen aus verschiedenen Abteilungen
- **Fairness KPIs**: Echtzeit-Dashboard zur Schichtverteilung
  - Fairness Score (0-100%)
  - Durchschnittliche Schichten pro Mitarbeiter
  - Spannweite und Standardabweichung
  - Visuelle Balkendiagramme
  - Filterung nach Schichttyp
  - Abweichungen vom Durchschnitt
  - Automatische Empfehlungen bei Unausgewogenheit
- **Jahresplanung**: Vollständiger Schichtplan für ein ganzes Jahr
- **Monatsansicht**: Übersichtliche Kalenderdarstellung
- **Bearbeitung**: Vorschläge können bestätigt, abgelehnt oder geändert werden

### 🎨 Design

- Modernes, responsives Design
- Tailwind CSS für konsistente Gestaltung
- Intuitive Benutzeroberfläche
- Optimiert für Desktop und Tablet

### 💾 Datenspeicherung

- Lokale Speicherung mit LocalStorage
- Automatische Persistierung aller Daten
- Keine externe Datenbank erforderlich

## Technologie-Stack

- **Frontend**: React 18 mit TypeScript
- **Build Tool**: Vite 5
- **Styling**: Tailwind CSS 3
- **State Management**: Zustand
- **Datum/Zeit**: date-fns
- **Icons**: Lucide React

## Installation

### Voraussetzungen

- Node.js 18+ 
- npm oder yarn

### Schritte

1. Repository klonen oder Dateien herunterladen

2. Dependencies installieren:
```bash
npm install
```

3. Entwicklungsserver starten:
```bash
npm run dev
```

Die Anwendung ist dann unter `http://localhost:3000` erreichbar.

## Production Build

```bash
npm run build
```

Die optimierten Dateien werden im `dist` Ordner erstellt.

### Preview des Production Builds

```bash
npm run preview
```

## Verwendung

### 1. Abteilungen anlegen

- Navigieren Sie zum "Abteilungen" Tab
- Klicken Sie auf "Abteilung hinzufügen"
- Tragen Sie den Abteilungsnamen ein
- Bearbeiten oder löschen Sie Abteilungen nach Bedarf
- Abteilungen mit zugeordneten Mitarbeitern können nicht gelöscht werden

### 2. Mitarbeiter anlegen

- Navigieren Sie zum "Mitarbeiter" Tab
- Klicken Sie auf "Mitarbeiter hinzufügen"
- Tragen Sie alle relevanten Informationen ein:
  - Name und Abteilung
  - Ü55 und L2 Status
  - Urlaubstage
  - Schichtpräferenzen (welche Schichten bevorzugt/vermieden werden)

### 3. Matrix-Ansicht nutzen

- Wechseln Sie zum "Matrix" Tab
- Sehen Sie alle Mitarbeiter (vertikal) und Schichttypen (horizontal)
- Klicken Sie auf Zellen um Präferenzen zu ändern:
  - ○ Neutral (keine Präferenz)
  - ✓ Bevorzugt (möchte diese Schicht gerne)
  - ✗ Vermeiden (möchte diese Schicht nicht)
- Filtern Sie nach Abteilungen
- Prüfen Sie die Präferenz-Übersicht unten

### 4. Schichtplan erstellen      # Mitarbeiterverwaltung
│   │   ├── DepartmentManagement.tsx    # Abteilungsverwaltung
│   │   ├── EmployeeShiftMatrix.tsx     # Matrix-Ansicht
│   │   ├── ShiftPlanning.tsx           # Planungs-Assistent
│   │   ├── CalendarView.tsx            # Kalenderansicht
│   │   └── FairnessKPIs.tsx            # KPI Dashboard Tab
- Wählen Sie das gewünschte Jahr
- Klicken Sie auf "Schichtplan generieren"
- Prüfen Sie die Vorschläge und bestätigen oder lehnen Sie diese ab
- Der Algorithmus berücksichtigt automatisch alle Präferenzen

### 5. Schichtplan ansehen

- Im "Kalender" Tab können Sie den erstellten Schichtplan monatsweise einsehen
- Navigieren Sie mit den Pfeilen zwischen den Monaten
- Sehen Sie Statistiken und Details zu jeder Schicht
- Löschen Sie Schichten falls nötig

### 6. Fairness prüfen

- Wechseln Sie zum "Fairness KPIs" Tab
- Sehen Sie den Fairness Score (0-100%)
- Prüfen Sie die Verteilung der Schichten
- Filtern Sie nach spezifischen Schichttypen
- Beachten Sie die Empfehlungen bei niedrigem Fairness Score
- Nutzen Sie die visuellen Diagramme zur Analyse

## Projekt-Struktur

```
Schichtplan_V5/
├── src/
│   ├── components/          # React Komponenten
│   │   ├── EmployeeManagement.tsx
│   │   ├── ShiftPlanning.tsx
│   │   └── CalendarView.tsx
│   ├── utils/               # Hilfsfunktionen
│   │   ├── scheduler.ts     # Scheduling-Algorithmus
│   │   └── helpers.ts       # Allgemeine Hilfsfunktionen
│   ├── App.tsx              # Haupt-App-Komponente
│   ├── store.ts             # Zustand State Management
│   ├── types.ts             # TypeScript Typdefinitionen
│   ├── main.tsx             # Einstiegspunkt
│   └── index.css            # Globale Styles
├── public/                  # Statische Assets
├── index.html               # HTML Template
├── package.json             # Dependencies
├── tsconfig.json            # TypeScript Konfiguration
├── vite.config.ts           # Vite Konfiguration
└── tailwind.config.js       # Tailwind CSS Konfiguration
```

## Algorithmus

Der Scheduling-Algorithmus berücksichtigt:

1. **Urlaubszeiten**: Mitarbeiter im Urlaub werden nicht eingeplant
2. **Präferenzen**: Bevorzugte Schichten erhalten +30 Punkte, vermiedene -30 Punkte
3. **Faire Verteilung**: Mitarbeiter mit weniger Schichten werden bevorzugt (-5 Punkte pro Schicht)
4. **L2-Zertifizierung**: Bonus von +10 Punkten
5. **Alter (Ü55)**: Berücksichtigung bei Nachtschichten (-15 Punkte)
6. **Abteilungsvielfalt**: Automatische Auswahl aus verschiedenen Abteilungen

## Browser-Kompatibilität

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## Lizenz

Dieses Projekt wurde speziell für Ihre Anforderungen entwickelt.

## Support

Bei Fragen oder Problemen können Sie Issues im Repository erstellen oder den Code direkt anpassen.
