import { useState, useCallback, useMemo } from 'react';
import ReactFlow, {
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { X, Trash2 } from 'lucide-react';
import { CustomRule, ConditionNode, ShiftType, SHIFT_LABELS, Department } from '../types';

const SHIFT_TYPES: ShiftType[] = ['fruehschicht', 'verschieben', 'nachtbereitschaft'];

// ═══════════════════════════════════════════════════════════════════════
// Graph <-> ConditionNode serialization (single condition tree per popup,
// feeding into one fixed "Ergebnis" sink node representing the rule itself
// — name/description/target shift types live in the surrounding form, not
// on the canvas).
// ═══════════════════════════════════════════════════════════════════════

const RESULT_NODE_ID = 'result';

let idCounter = 0;
function freshId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

interface LayoutResult { nodes: Node[]; edges: Edge[] }

function layoutCondition(node: ConditionNode, depth: number, leafCursor: { y: number }, collect: LayoutResult): { id: string; y: number } {
  const x = -depth * 280;
  if (node.type === 'and' || node.type === 'or') {
    const children = node.children.map(c => layoutCondition(c, depth + 1, leafCursor, collect));
    const y = children.length > 0 ? children.reduce((s, c) => s + c.y, 0) / children.length : leafCursor.y;
    const id = freshId(node.type);
    collect.nodes.push({ id, type: node.type, position: { x, y }, data: {} });
    children.forEach(c => collect.edges.push({ id: freshId('e'), source: c.id, target: id }));
    return { id, y };
  }
  if (node.type === 'not') {
    const child = layoutCondition(node.child, depth + 1, leafCursor, collect);
    const id = freshId('not');
    collect.nodes.push({ id, type: 'not', position: { x, y: child.y }, data: {} });
    collect.edges.push({ id: freshId('e'), source: child.id, target: id });
    return { id, y: child.y };
  }
  const y = leafCursor.y;
  leafCursor.y += 130;
  const id = freshId(node.type);
  collect.nodes.push({ id, type: node.type, position: { x, y }, data: { ...node } });
  return { id, y };
}

function conditionToGraph(condition: ConditionNode | null): LayoutResult {
  const collect: LayoutResult = { nodes: [{ id: RESULT_NODE_ID, type: 'result', position: { x: 0, y: 0 }, data: {} }], edges: [] };
  if (!condition) return collect;
  const leafCursor = { y: 0 };
  const top = layoutCondition(condition, 1, leafCursor, collect);
  collect.nodes.find(n => n.id === RESULT_NODE_ID)!.position.y = top.y;
  collect.edges.push({ id: freshId('e'), source: top.id, target: RESULT_NODE_ID });
  return collect;
}

function buildConditionTree(nodeId: string, nodes: Node[], edges: Edge[]): ConditionNode | null {
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return null;
  const incomingIds = edges.filter(e => e.target === nodeId).map(e => e.source);
  switch (node.type) {
    case 'and':
    case 'or': {
      const children = incomingIds.map(id => buildConditionTree(id, nodes, edges)).filter((c): c is ConditionNode => c !== null);
      if (children.length === 0) return null;
      return { type: node.type, children };
    }
    case 'not': {
      if (incomingIds.length !== 1) return null;
      const child = buildConditionTree(incomingIds[0], nodes, edges);
      return child ? { type: 'not', child } : null;
    }
    case 'assignmentGap':
      return { type: 'assignmentGap', shiftType: node.data.shiftType, direction: node.data.direction, minDays: node.data.minDays, maxDays: node.data.maxDays };
    case 'nearVacation':
      return { type: 'nearVacation', direction: node.data.direction, minDays: node.data.minDays, maxDays: node.data.maxDays };
    case 'isWeekend':
      return { type: 'isWeekend' };
    case 'weekendNearVacation':
      return { type: 'weekendNearVacation', minDays: node.data.minDays, maxDays: node.data.maxDays };
    case 'employeeAttribute':
      return { type: 'employeeAttribute', attribute: node.data.attribute, equals: node.data.equals };
    default:
      return null;
  }
}

function graphToCondition(nodes: Node[], edges: Edge[]): { condition: ConditionNode | null; errors: string[] } {
  const errors: string[] = [];
  const incomingToResult = edges.filter(e => e.target === RESULT_NODE_ID).map(e => e.source);
  if (incomingToResult.length === 0) {
    return { condition: null, errors: ['Keine Bedingung mit "Ergebnis" verbunden.'] };
  }
  const trees = incomingToResult.map(id => buildConditionTree(id, nodes, edges)).filter((c): c is ConditionNode => c !== null);
  if (trees.length === 0) {
    errors.push('Ungültige Bedingung.');
  }
  for (const n of nodes) {
    if (n.id === RESULT_NODE_ID) continue;
    if ((n.type === 'and' || n.type === 'or') && edges.filter(e => e.target === n.id).length === 0) {
      errors.push(`${n.type === 'and' ? 'UND' : 'ODER'}-Baustein ohne verbundene Bedingungen.`);
    }
    if (n.type === 'not' && edges.filter(e => e.target === n.id).length !== 1) {
      errors.push('NICHT-Baustein braucht genau eine verbundene Bedingung.');
    }
  }
  const condition: ConditionNode | null = trees.length === 0 ? null : trees.length === 1 ? trees[0] : { type: 'and', children: trees };
  return { condition, errors };
}

// ═══════════════════════════════════════════════════════════════════════
// Node components
// ═══════════════════════════════════════════════════════════════════════

const nodeCard = 'rounded-lg shadow-sm border text-xs bg-white min-w-[220px]';
const NUMBER_INPUT = 'nodrag w-14 px-1 py-0.5 border rounded text-xs';
const SELECT_INPUT = 'nodrag px-1 py-0.5 border rounded text-xs';

function ResultNode() {
  return (
    <div className={`${nodeCard} border-primary-300`}>
      <Handle type="target" position={Position.Left} style={{ background: '#4f46e5' }} />
      <div className="bg-primary-50 px-3 py-2 rounded-lg flex items-center justify-center">
        <span className="font-semibold text-primary-800">Ergebnis (Regel-Bedingung)</span>
      </div>
    </div>
  );
}

function CombinatorNode({ id, data, type }: NodeProps & { type: 'and' | 'or' | 'not' }) {
  const label = type === 'and' ? 'UND' : type === 'or' ? 'ODER' : 'NICHT';
  return (
    <div className={`${nodeCard} border-gray-300`}>
      <Handle type="target" position={Position.Left} style={{ background: '#6b7280' }} />
      <div className="bg-gray-100 px-3 py-2 rounded-t-lg border-b border-gray-200 flex items-center justify-between">
        <span className="font-semibold text-gray-700">{label}</span>
        <button className="nodrag text-gray-400 hover:text-rose-600" title="Löschen" onClick={() => data.onDeleteNode(id)}>
          <Trash2 size={12} />
        </button>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: '#6b7280' }} />
    </div>
  );
}

function AssignmentGapNode({ id, data }: NodeProps) {
  return (
    <div className={`${nodeCard} border-amber-300`}>
      <div className="bg-amber-50 px-3 py-1.5 rounded-t-lg border-b border-amber-200 flex items-center justify-between">
        <span className="font-semibold text-amber-800">Schicht-Abstand</span>
        <button className="nodrag text-gray-400 hover:text-rose-600" onClick={() => data.onDeleteNode(id)}><Trash2 size={12} /></button>
      </div>
      <div className="p-2.5 space-y-1.5">
        <select className={SELECT_INPUT} value={data.shiftType} onChange={e => data.onChange(id, { shiftType: e.target.value })}>
          {SHIFT_TYPES.map(t => <option key={t} value={t}>{SHIFT_LABELS[t]}</option>)}
        </select>
        <select className={SELECT_INPUT} value={data.direction} onChange={e => data.onChange(id, { direction: e.target.value })}>
          <option value="before">davor</option>
          <option value="after">danach</option>
          <option value="either">davor oder danach</option>
        </select>
        <div className="flex items-center gap-1">
          <input type="number" min={0} className={NUMBER_INPUT} value={data.minDays} onChange={e => data.onChange(id, { minDays: Math.max(0, Number(e.target.value)) })} />
          <span>–</span>
          <input type="number" min={0} className={NUMBER_INPUT} value={data.maxDays} onChange={e => data.onChange(id, { maxDays: Math.max(0, Number(e.target.value)) })} />
          <span>Tage</span>
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: '#d97706' }} />
    </div>
  );
}

function NearVacationNode({ id, data }: NodeProps) {
  return (
    <div className={`${nodeCard} border-emerald-300`}>
      <div className="bg-emerald-50 px-3 py-1.5 rounded-t-lg border-b border-emerald-200 flex items-center justify-between">
        <span className="font-semibold text-emerald-800">Urlaubs-Nähe</span>
        <button className="nodrag text-gray-400 hover:text-rose-600" onClick={() => data.onDeleteNode(id)}><Trash2 size={12} /></button>
      </div>
      <div className="p-2.5 space-y-1.5">
        <select className={SELECT_INPUT} value={data.direction} onChange={e => data.onChange(id, { direction: e.target.value })}>
          <option value="before">davor</option>
          <option value="after">danach</option>
          <option value="either">davor oder danach</option>
        </select>
        <div className="flex items-center gap-1">
          <input type="number" min={0} className={NUMBER_INPUT} value={data.minDays} onChange={e => data.onChange(id, { minDays: Math.max(0, Number(e.target.value)) })} />
          <span>–</span>
          <input type="number" min={0} className={NUMBER_INPUT} value={data.maxDays} onChange={e => data.onChange(id, { maxDays: Math.max(0, Number(e.target.value)) })} />
          <span>Tage</span>
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: '#059669' }} />
    </div>
  );
}

function WeekendNearVacationNode({ id, data }: NodeProps) {
  return (
    <div className={`${nodeCard} border-sky-300`}>
      <div className="bg-sky-50 px-3 py-1.5 rounded-t-lg border-b border-sky-200 flex items-center justify-between">
        <span className="font-semibold text-sky-800">Wochenende nahe Urlaub</span>
        <button className="nodrag text-gray-400 hover:text-rose-600" onClick={() => data.onDeleteNode(id)}><Trash2 size={12} /></button>
      </div>
      <div className="p-2.5 space-y-1.5">
        <p className="text-gray-500">Trifft zu für jeden Sa/So innerhalb der Schicht, der nahe an Urlaub liegt:</p>
        <div className="flex items-center gap-1">
          <input type="number" min={0} className={NUMBER_INPUT} value={data.minDays} onChange={e => data.onChange(id, { minDays: Math.max(0, Number(e.target.value)) })} />
          <span>–</span>
          <input type="number" min={0} className={NUMBER_INPUT} value={data.maxDays} onChange={e => data.onChange(id, { maxDays: Math.max(0, Number(e.target.value)) })} />
          <span>Tage</span>
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: '#0284c7' }} />
    </div>
  );
}

function IsWeekendNode({ id, data }: NodeProps) {
  return (
    <div className={`${nodeCard} border-sky-300`}>
      <div className="bg-sky-50 px-3 py-1.5 rounded-t-lg border-b border-sky-200 flex items-center justify-between">
        <span className="font-semibold text-sky-800">Ist Wochenende</span>
        <button className="nodrag text-gray-400 hover:text-rose-600" onClick={() => data.onDeleteNode(id)}><Trash2 size={12} /></button>
      </div>
      <div className="p-2.5 text-gray-500">Trifft zu, wenn die betrachtete Schicht auf Sa/So liegt.</div>
      <Handle type="source" position={Position.Right} style={{ background: '#0284c7' }} />
    </div>
  );
}

function EmployeeAttributeNode({ id, data, departments }: NodeProps & { departments: Department[] }) {
  return (
    <div className={`${nodeCard} border-violet-300`}>
      <div className="bg-violet-50 px-3 py-1.5 rounded-t-lg border-b border-violet-200 flex items-center justify-between">
        <span className="font-semibold text-violet-800">Mitarbeiter-Merkmal</span>
        <button className="nodrag text-gray-400 hover:text-rose-600" onClick={() => data.onDeleteNode(id)}><Trash2 size={12} /></button>
      </div>
      <div className="p-2.5 space-y-1.5">
        <select
          className={SELECT_INPUT}
          value={data.attribute}
          onChange={e => data.onChange(id, { attribute: e.target.value, equals: e.target.value === 'isOver55' ? true : (departments[0]?.name || '') })}
        >
          <option value="isOver55">Ü55</option>
          <option value="department">Abteilung</option>
        </select>
        {data.attribute === 'isOver55' ? (
          <select className={SELECT_INPUT} value={String(data.equals)} onChange={e => data.onChange(id, { equals: e.target.value === 'true' })}>
            <option value="true">ist Ü55</option>
            <option value="false">ist nicht Ü55</option>
          </select>
        ) : (
          <select className={SELECT_INPUT} value={data.equals} onChange={e => data.onChange(id, { equals: e.target.value })}>
            {departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: '#7c3aed' }} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Canvas
// ═══════════════════════════════════════════════════════════════════════

function Canvas({ condition, onChange, departments, canEdit, onErrors }: {
  condition: ConditionNode | null;
  onChange: (condition: ConditionNode | null) => void;
  departments: Department[];
  canEdit: boolean;
  onErrors: (errors: string[]) => void;
}) {
  const initial = useMemo(() => conditionToGraph(condition), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const { fitView } = useReactFlow();

  const sync = useCallback((nds: Node[], eds: Edge[]) => {
    const { condition: c, errors } = graphToCondition(nds, eds);
    onErrors(errors);
    if (errors.length === 0) onChange(c);
  }, [onChange, onErrors]);

  const updateNodeData = useCallback((id: string, patch: Record<string, any>) => {
    setNodes(nds => {
      const next = nds.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n);
      sync(next, edges);
      return next;
    });
  }, [setNodes, edges, sync]);

  const deleteNode = useCallback((id: string) => {
    setNodes(nds => {
      const nextNodes = nds.filter(n => n.id !== id);
      setEdges(eds => {
        const nextEdges = eds.filter(e => e.source !== id && e.target !== id);
        sync(nextNodes, nextEdges);
        return nextEdges;
      });
      return nextNodes;
    });
  }, [setNodes, setEdges, sync]);

  const nodesWithHandlers = useMemo(() => nodes.map(n => ({
    ...n,
    data: { ...n.data, onChange: updateNodeData, onDeleteNode: deleteNode },
  })), [nodes, updateNodeData, deleteNode]);

  const onConnect = useCallback((c: Connection) => setEdges(eds => {
    const next = addEdge(c, eds);
    sync(nodes, next);
    return next;
  }), [setEdges, nodes, sync]);

  const onNodesChangeWrapped = useCallback((changes: any) => {
    onNodesChange(changes);
  }, [onNodesChange]);

  const onEdgesChangeAndSync = useCallback((changes: any) => {
    onEdgesChange(changes);
    setTimeout(() => setEdges(eds => { sync(nodes, eds); return eds; }), 0);
  }, [onEdgesChange, setEdges, nodes, sync]);

  const addNode = (type: string, dataDefaults: Record<string, any>) => {
    const id = freshId(type);
    const x = -280 - (nodes.length % 3) * 30;
    const y = (nodes.length % 6) * 90;
    setNodes(nds => [...nds, { id, type, position: { x, y }, data: dataDefaults }]);
    // A newly-added node can otherwise land outside the viewport the
    // initial fitView (which only accounted for the starting node) chose —
    // re-fit so it's always visible without the user having to pan/zoom.
    // The delay lets reactflow measure the new node's DOM dimensions first
    // (fitView computed too early would still use stale/incomplete bounds).
    setTimeout(() => fitView({ padding: 0.3, duration: 200 }), 50);
  };

  const nodeTypes = useMemo(() => ({
    result: ResultNode,
    and: (p: NodeProps) => <CombinatorNode {...p} type="and" />,
    or: (p: NodeProps) => <CombinatorNode {...p} type="or" />,
    not: (p: NodeProps) => <CombinatorNode {...p} type="not" />,
    assignmentGap: AssignmentGapNode,
    nearVacation: NearVacationNode,
    weekendNearVacation: WeekendNearVacationNode,
    isWeekend: IsWeekendNode,
    employeeAttribute: (p: NodeProps) => <EmployeeAttributeNode {...p} departments={departments} />,
  }), [departments]);

  return (
    <div>
      {canEdit && (
        <div className="flex flex-wrap gap-2 mb-2">
          <button className="text-xs px-2 py-1 border rounded" onClick={() => addNode('assignmentGap', { shiftType: 'verschieben', direction: 'before', minDays: 1, maxDays: 7 })}>+ Schicht-Abstand</button>
          <button className="text-xs px-2 py-1 border rounded" onClick={() => addNode('nearVacation', { direction: 'before', minDays: 1, maxDays: 7 })}>+ Urlaubs-Nähe</button>
          <button className="text-xs px-2 py-1 border rounded" onClick={() => addNode('weekendNearVacation', { minDays: 1, maxDays: 2 })}>+ Wochenende nahe Urlaub</button>
          <button className="text-xs px-2 py-1 border rounded" onClick={() => addNode('isWeekend', {})}>+ Ist Wochenende</button>
          <button className="text-xs px-2 py-1 border rounded" onClick={() => addNode('employeeAttribute', { attribute: 'isOver55', equals: true })}>+ Mitarbeiter-Merkmal</button>
          <button className="text-xs px-2 py-1 border rounded" onClick={() => addNode('and', {})}>+ UND</button>
          <button className="text-xs px-2 py-1 border rounded" onClick={() => addNode('or', {})}>+ ODER</button>
          <button className="text-xs px-2 py-1 border rounded" onClick={() => addNode('not', {})}>+ NICHT</button>
        </div>
      )}
      <div style={{ height: 380 }} className="border rounded-lg bg-gray-50">
        <ReactFlow
          nodes={nodesWithHandlers}
          edges={edges}
          onNodesChange={canEdit ? onNodesChangeWrapped : undefined}
          onEdgesChange={canEdit ? onEdgesChangeAndSync : undefined}
          onConnect={canEdit ? onConnect : undefined}
          nodeTypes={nodeTypes}
          nodesDraggable={canEdit}
          nodesConnectable={canEdit}
          elementsSelectable={canEdit}
          fitView
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Popup
// ═══════════════════════════════════════════════════════════════════════

interface Props {
  rule: CustomRule | null;
  departments: Department[];
  canEdit: boolean;
  onSave: (rule: CustomRule) => void;
  onDelete?: () => void;
  onClose: () => void;
}

export function RuleEditPopup({ rule, departments, canEdit, onSave, onDelete, onClose }: Props) {
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [targetShiftTypes, setTargetShiftTypes] = useState<ShiftType[]>(rule?.targetShiftTypes ?? []);
  const [condition, setCondition] = useState<ConditionNode | null>(rule?.condition ?? null);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggleShiftType = (t: ShiftType) => {
    setTargetShiftTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  };

  const canSave = canEdit && name.trim().length > 0 && targetShiftTypes.length > 0 && condition !== null && errors.length === 0;

  const handleSave = () => {
    if (!canSave || !condition) return;
    onSave({
      id: rule?.id ?? `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim(),
      description: description.trim() || undefined,
      enabled,
      targetShiftTypes,
      condition,
      builtinKey: rule?.builtinKey,
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-4xl bg-white rounded-lg shadow-lg overflow-hidden max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-semibold">
            {rule ? 'Regel bearbeiten' : 'Neue Regel'}
            {rule?.builtinKey && <span className="ml-2 text-xs font-normal px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full align-middle">System-Regel</span>}
          </h3>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded"><X /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input
                type="text" value={name} onChange={e => setName(e.target.value)} disabled={!canEdit}
                placeholder="z. B. Keine Nacht nach Versetzt-Woche"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Blockiert Schichttyp(en)</label>
              <div className="flex flex-wrap gap-2 pt-2">
                {SHIFT_TYPES.map(t => (
                  <label key={t} className={`flex items-center gap-1.5 px-2 py-1 border rounded ${canEdit ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                    <input type="checkbox" checked={targetShiftTypes.includes(t)} onChange={() => canEdit && toggleShiftType(t)} disabled={!canEdit} />
                    <span className="text-sm">{SHIFT_LABELS[t]}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Beschreibung</label>
            <textarea
              value={description} onChange={e => setDescription(e.target.value)} disabled={!canEdit} rows={2}
              placeholder="Erklärt, was diese Regel bewirkt"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-100"
            />
          </div>

          <label className="flex items-center gap-2">
            <button
              type="button" role="switch" aria-checked={enabled}
              onClick={() => canEdit && setEnabled(v => !v)} disabled={!canEdit}
              className={`relative flex-shrink-0 w-11 h-6 rounded-full overflow-hidden transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${enabled ? 'bg-primary-600' : 'bg-gray-300'}`}
            >
              <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
            <span className="text-sm text-gray-700">Aktiv</span>
          </label>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Bedingung (Baukasten)</label>
            <p className="text-xs text-gray-500 mb-2">Bausteine per Ziehen mit "Ergebnis" verbinden — optional über UND/ODER/NICHT kombiniert.</p>
            <ReactFlowProvider>
              <Canvas condition={condition} onChange={setCondition} departments={departments} canEdit={canEdit} onErrors={setErrors} />
            </ReactFlowProvider>
            {errors.length > 0 && (
              <div className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded p-2 space-y-0.5">
                {errors.map((e, i) => <div key={i}>{e}</div>)}
              </div>
            )}
          </div>
        </div>

        <div className="p-4 border-t flex items-center justify-between gap-2">
          <div>
            {onDelete && canEdit && (
              confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-rose-600">Wirklich löschen?</span>
                  <button onClick={onDelete} className="px-3 py-1.5 bg-rose-600 text-white rounded text-sm">Ja, löschen</button>
                  <button onClick={() => setConfirmDelete(false)} className="px-3 py-1.5 border rounded text-sm">Abbrechen</button>
                </div>
              ) : (
                <button onClick={() => setConfirmDelete(true)} className="px-3 py-1.5 border border-rose-200 text-rose-600 rounded text-sm hover:bg-rose-50 flex items-center gap-1.5">
                  <Trash2 size={14} /> Regel löschen
                </button>
              )
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 border rounded">Abbrechen</button>
            {canEdit && (
              <button onClick={handleSave} disabled={!canSave} className="px-4 py-2 bg-primary-600 text-white rounded font-medium hover:bg-primary-700 disabled:bg-gray-300">
                {rule ? 'Speichern' : 'Hinzufügen'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
