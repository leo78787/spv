import { useEffect, useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CheckSquare, Square, Calendar, MessageSquare, Paperclip } from 'lucide-react';
import { BoardTask } from '../../types';
import type { OrgUser } from './BoardsModal';
import { animateItemIn, animatePop } from './animations';

function initials(name: string): string {
  return name.split(' ').map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

interface ContentProps {
  task: BoardTask;
  orgUsers: OrgUser[];
  onToggleDone: () => void;
  checkRef?: React.Ref<HTMLButtonElement>;
  dragging?: boolean;
}

/**
 * Pure presentational card body — no `useSortable`. Used both by the real,
 * sortable-wrapped card below AND directly by KanbanBoard's `DragOverlay`.
 * The overlay must render a plain visual clone: if it called `useSortable`
 * too, it would register a second sortable node under the same task id as
 * the still-mounted original, and dnd-kit would layer that node's own
 * sortable transform on top of the overlay's own drag transform — which is
 * what caused the dragged card to render offset from the cursor and to
 * flicker briefly after drop.
 */
function TaskCardContent({ task, orgUsers, onToggleDone, checkRef, dragging }: ContentProps) {
  const doneSubtasks = task.subtasks.filter(s => s.done).length;
  const isOverdue = task.deadline && !task.done && new Date(task.deadline) < new Date(new Date().toDateString());
  const attachmentCount = task.comments.reduce((sum, c) => sum + c.attachmentIds.length, 0);

  return (
    <>
      <div className="flex items-start gap-1.5">
        <button
          ref={checkRef}
          onClick={e => { e.stopPropagation(); onToggleDone(); }}
          onPointerDown={e => e.stopPropagation()}
          className="flex-shrink-0 mt-0.5"
          title={task.done ? 'Als offen markieren' : 'Als erledigt markieren'}
          tabIndex={dragging ? -1 : undefined}
        >
          {task.done ? <CheckSquare size={15} className="text-primary-600" /> : <Square size={15} className="text-gray-300 hover:text-gray-400" />}
        </button>
        <span className={`text-sm text-gray-800 ${task.done ? 'line-through' : ''}`}>{task.title}</span>
      </div>
      {(task.deadline || task.subtasks.length > 0 || task.comments.length > 0 || attachmentCount > 0 || task.assigneeIds.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500 pl-[21px]">
          {task.deadline && (
            <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded ${isOverdue ? 'bg-rose-100 text-rose-700' : 'bg-gray-100'}`}>
              <Calendar size={11} /> {new Date(task.deadline).toLocaleDateString('de-DE')}
            </span>
          )}
          {task.subtasks.length > 0 && <span>{doneSubtasks}/{task.subtasks.length}</span>}
          {task.comments.length > 0 && <span className="flex items-center gap-0.5"><MessageSquare size={11} /> {task.comments.length}</span>}
          {attachmentCount > 0 && <span className="flex items-center gap-0.5"><Paperclip size={11} /> {attachmentCount}</span>}
          {task.assigneeIds.length > 0 && (
            <span className="flex -space-x-1 ml-auto">
              {task.assigneeIds.slice(0, 3).map(id => {
                const u = orgUsers.find(u => u.id === id);
                return (
                  <span key={id} title={u?.name} className="w-5 h-5 rounded-full bg-primary-200 text-primary-800 text-[9px] font-semibold flex items-center justify-center border border-white">
                    {u ? initials(u.name) : '?'}
                  </span>
                );
              })}
            </span>
          )}
        </div>
      )}
    </>
  );
}

export function TaskCard({ task, orgUsers, onClick, onToggleDone }: { task: BoardTask; orgUsers: OrgUser[]; onClick: () => void; onToggleDone: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  const cardRef = useRef<HTMLDivElement | null>(null);
  const checkRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    animateItemIn(cardRef.current);
    // Only on mount — a genuinely new card, not on every data refresh (same DOM node via `key`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={node => { setNodeRef(node); cardRef.current = node; }}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={`bg-white border rounded-md p-2.5 shadow-sm hover:shadow cursor-pointer space-y-1.5 ${task.done ? 'opacity-60' : ''}`}
    >
      <TaskCardContent
        task={task}
        orgUsers={orgUsers}
        checkRef={checkRef}
        onToggleDone={() => { animatePop(checkRef.current); onToggleDone(); }}
      />
    </div>
  );
}

/** Visual-only clone for `DragOverlay` — deliberately not sortable, see `TaskCardContent`'s doc comment. */
export function TaskCardOverlay({ task, orgUsers }: { task: BoardTask; orgUsers: OrgUser[] }) {
  return (
    <div className="bg-white border rounded-md p-2.5 shadow-lg space-y-1.5 cursor-grabbing">
      <TaskCardContent task={task} orgUsers={orgUsers} onToggleDone={() => {}} dragging />
    </div>
  );
}
