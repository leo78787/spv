import { useState } from 'react';
import {
  DndContext, closestCorners, PointerSensor, useSensor, useSensors,
  DragOverlay, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { Plus, MoreVertical, Trash2 } from 'lucide-react';
import { getAuthToken } from '../../store';
import { Board, BoardSection, BoardTask } from '../../types';
import type { OrgUser } from './BoardsModal';
import { TaskCard } from './TaskCard';
import { TaskDetailPopup } from './TaskDetailPopup';

interface Props {
  board: Board;
  orgUsers: OrgUser[];
  onBoardChanged: (board: Board) => void;
}

function Column({ section, orgUsers, onOpenTask, onAddTask, onDeleteSection }: {
  section: BoardSection;
  orgUsers: OrgUser[];
  onOpenTask: (taskId: string) => void;
  onAddTask: (sectionId: string, title: string) => void;
  onDeleteSection: (sectionId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: section.id });
  const [addingTask, setAddingTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  const submitTask = () => {
    if (!taskTitle.trim()) { setAddingTask(false); return; }
    onAddTask(section.id, taskTitle.trim());
    setTaskTitle('');
    setAddingTask(false);
  };

  return (
    <div className={`w-72 flex-shrink-0 bg-gray-50 rounded-lg flex flex-col max-h-full border ${isOver ? 'border-primary-400 bg-primary-50/40' : 'border-gray-200'}`}>
      <div className="flex items-center justify-between px-3 py-2 flex-shrink-0">
        <h5 className="font-medium text-sm text-gray-700">{section.name} <span className="text-gray-400 font-normal">({section.tasks.length})</span></h5>
        <div className="relative">
          <button onClick={() => setMenuOpen(v => !v)} className="p-1 text-gray-400 hover:bg-gray-200 rounded"><MoreVertical size={14} /></button>
          {menuOpen && (
            <div className="absolute right-0 top-7 z-10 bg-white border rounded-md shadow-lg py-1 w-40">
              <button
                onClick={() => { setMenuOpen(false); onDeleteSection(section.id); }}
                className="w-full text-left px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50 flex items-center gap-1.5"
              >
                <Trash2 size={12} /> Abschnitt löschen
              </button>
            </div>
          )}
        </div>
      </div>

      <div ref={setNodeRef} className="flex-1 overflow-y-auto px-2 space-y-2 pb-2 min-h-[40px]">
        <SortableContext items={section.tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
          {section.tasks.map(task => (
            <TaskCard key={task.id} task={task} orgUsers={orgUsers} onClick={() => onOpenTask(task.id)} />
          ))}
        </SortableContext>
      </div>

      <div className="p-2 flex-shrink-0">
        {addingTask ? (
          <div className="space-y-1.5">
            <input
              autoFocus
              value={taskTitle}
              onChange={e => setTaskTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitTask(); if (e.key === 'Escape') setAddingTask(false); }}
              placeholder="Titel der Aufgabe"
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
            <div className="flex gap-1.5">
              <button onClick={submitTask} className="px-2 py-1 bg-primary-600 text-white rounded text-xs">Hinzufügen</button>
              <button onClick={() => setAddingTask(false)} className="px-2 py-1 border rounded text-xs">Abbrechen</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAddingTask(true)} className="w-full flex items-center gap-1 px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-100 rounded">
            <Plus size={13} /> Aufgabe hinzufügen
          </button>
        )}
      </div>
    </div>
  );
}

export function KanbanBoard({ board, orgUsers, onBoardChanged }: Props) {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<BoardTask | null>(null);
  const [addingSection, setAddingSection] = useState(false);
  const [sectionName, setSectionName] = useState('');

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` });

  const refetchBoard = async () => {
    const resp = await fetch(`/api/boards/${board.id}`, { headers: { Authorization: `Bearer ${getAuthToken()}` } });
    if (resp.ok) onBoardChanged(await resp.json());
  };

  const addSection = async () => {
    if (!sectionName.trim()) { setAddingSection(false); return; }
    await fetch(`/api/boards/${board.id}/sections`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name: sectionName.trim() }) });
    setSectionName('');
    setAddingSection(false);
    refetchBoard();
  };

  const deleteSection = async (sectionId: string) => {
    if (!confirm('Abschnitt inkl. aller Aufgaben wirklich löschen?')) return;
    await fetch(`/api/boards/${board.id}/sections/${sectionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${getAuthToken()}` } });
    refetchBoard();
  };

  const addTask = async (sectionId: string, title: string) => {
    await fetch(`/api/boards/${board.id}/sections/${sectionId}/tasks`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ title }) });
    refetchBoard();
  };

  const findTaskAndSection = (taskId: string): { task: BoardTask; section: BoardSection } | null => {
    for (const s of board.sections) {
      const t = s.tasks.find(t => t.id === taskId);
      if (t) return { task: t, section: s };
    }
    return null;
  };

  const onDragStart = (event: DragStartEvent) => {
    const found = findTaskAndSection(String(event.active.id));
    setActiveTask(found?.task || null);
  };

  const onDragEnd = async (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    const source = findTaskAndSection(activeId);
    if (!source) return;

    // Dropped on a task -> use that task's section + its index; dropped on the column itself (empty area) -> use that section, append at end.
    const overIsSection = board.sections.some(s => s.id === overId);
    const targetSection = overIsSection ? board.sections.find(s => s.id === overId)! : findTaskAndSection(overId)?.section;
    if (!targetSection) return;
    const order = overIsSection ? targetSection.tasks.length : targetSection.tasks.findIndex(t => t.id === overId);

    // Optimistic local update so the card doesn't snap back while the request is in flight.
    const nextBoard: Board = {
      ...board,
      sections: board.sections.map(s => {
        if (s.id === source.section.id && s.id === targetSection.id) {
          const withoutTask = s.tasks.filter(t => t.id !== activeId);
          const insertAt = Math.max(0, Math.min(order, withoutTask.length));
          return { ...s, tasks: [...withoutTask.slice(0, insertAt), source.task, ...withoutTask.slice(insertAt)] };
        }
        if (s.id === source.section.id) return { ...s, tasks: s.tasks.filter(t => t.id !== activeId) };
        if (s.id === targetSection.id) {
          const insertAt = Math.max(0, Math.min(order, s.tasks.length));
          return { ...s, tasks: [...s.tasks.slice(0, insertAt), source.task, ...s.tasks.slice(insertAt)] };
        }
        return s;
      }),
    };
    onBoardChanged(nextBoard);

    await fetch(`/api/boards/${board.id}/tasks/${activeId}`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ targetSectionId: targetSection.id, order }),
    });
    refetchBoard();
  };

  const openTask = openTaskId ? findTaskAndSection(openTaskId)?.task ?? null : null;

  return (
    <div className="h-full p-4">
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="flex gap-3 h-full items-start">
          {board.sections.map(section => (
            <Column
              key={section.id}
              section={section}
              orgUsers={orgUsers}
              onOpenTask={setOpenTaskId}
              onAddTask={addTask}
              onDeleteSection={deleteSection}
            />
          ))}

          <div className="w-64 flex-shrink-0">
            {addingSection ? (
              <div className="bg-gray-50 border rounded-lg p-2 space-y-1.5">
                <input
                  autoFocus
                  value={sectionName}
                  onChange={e => setSectionName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addSection(); if (e.key === 'Escape') setAddingSection(false); }}
                  placeholder="z. B. Offen"
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
                <div className="flex gap-1.5">
                  <button onClick={addSection} className="px-2 py-1 bg-primary-600 text-white rounded text-xs">Hinzufügen</button>
                  <button onClick={() => setAddingSection(false)} className="px-2 py-1 border rounded text-xs">Abbrechen</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setAddingSection(true)} className="w-full flex items-center gap-1.5 px-3 py-2.5 text-sm text-gray-500 hover:bg-gray-100 rounded-lg border border-dashed border-gray-300">
                <Plus size={15} /> Abschnitt hinzufügen
              </button>
            )}
          </div>
        </div>

        <DragOverlay>
          {activeTask && <TaskCard task={activeTask} orgUsers={orgUsers} onClick={() => {}} />}
        </DragOverlay>
      </DndContext>

      {openTask && (
        <TaskDetailPopup
          board={board}
          task={openTask}
          orgUsers={orgUsers}
          onClose={() => setOpenTaskId(null)}
          onChanged={refetchBoard}
        />
      )}
    </div>
  );
}
