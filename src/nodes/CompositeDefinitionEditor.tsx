import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyEdgeChanges, applyNodeChanges, Background, Controls, ReactFlow, type Connection, type Edge, type Node, type NodeChange, type ReactFlowInstance } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import { arePortTypesCompatible, DEFAULT_NODE_PARAMETER_EDITABILITY, retainValidSinglePortConnections, type CompositeInputMapping, type CompositeOutputMapping, type CompositeParameter, type FunctionNodeData, type NodeDefinition, type NodePort } from "./nodeDefinitions";
import { VisualNode } from "./VisualNode";
import "./nodes.css";

const nodeTypes = { function: VisualNode };
const ports = (count: number, direction: "input" | "output", current: NodePort[]) => Array.from({ length: Math.max(0, Math.min(16, count)) }, (_, index) => current[index] ?? ({ id: `${direction}${index + 1}`, label: `${direction === "input" ? "Input" : "Output"} ${index + 1}`, type: "text" as const }));

type Props = { initialDefinition: NodeDefinition; libraryFolder: string; targetExtension: string; isNew?: boolean; minimumInputs?: number; minimumOutputs?: number; onCancel: () => void; onSaved: (definition: NodeDefinition) => void; onAddNodeHandler: (handler: ((definition: NodeDefinition) => void) | null) => void };

export default function CompositeDefinitionEditor({ initialDefinition, libraryFolder, targetExtension, isNew = false, minimumInputs = 0, minimumOutputs = 0, onCancel, onSaved, onAddNodeHandler }: Props) {
  const [name, setName] = useState(initialDefinition.name);
  const [category, setCategory] = useState(initialDefinition.category ?? "Default");
  const [nodes, setNodes] = useState<Node<FunctionNodeData>[]>(initialDefinition.definitionGraph?.nodes ?? []);
  const [edges, setEdges] = useState<Edge[]>(() => retainValidSinglePortConnections(initialDefinition.definitionGraph?.nodes ?? [], initialDefinition.definitionGraph?.edges ?? []));
  const [inputs, setInputs] = useState(initialDefinition.inputs);
  const [outputs, setOutputs] = useState(initialDefinition.outputs);
  const [inputMappings, setInputMappings] = useState<CompositeInputMapping[]>(initialDefinition.compositeInputMappings ?? []);
  const [outputMappings, setOutputMappings] = useState<CompositeOutputMapping[]>(initialDefinition.compositeOutputMappings ?? []);
  const [parameters, setParameters] = useState<CompositeParameter[]>(initialDefinition.compositeParameters ?? []);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [settingsNodeId, setSettingsNodeId] = useState("");
  const flow = useRef<ReactFlowInstance<Node<FunctionNodeData>, Edge> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const selectedNode = nodes.find((node) => node.id === settingsNodeId);
  const internalEditability = selectedNode ? { ...DEFAULT_NODE_PARAMETER_EDITABILITY, ...selectedNode.data.editableParameters } : DEFAULT_NODE_PARAMETER_EDITABILITY;
  const internalDefinitionLocked = Boolean(selectedNode?.data.definitionId && selectedNode.data.definitionId !== "builtin-function" && selectedNode.data.definitionId !== "builtin-value");
  const internalInputs = useMemo(() => nodes.flatMap((node) => node.data.inputs.map((port) => ({ nodeId: node.id, nodeName: node.data.label, portId: port.id }))), [nodes]);
  const internalOutputs = useMemo(() => nodes.flatMap((node) => node.data.outputs.map((port) => ({ nodeId: node.id, nodeName: node.data.label, portId: port.id }))), [nodes]);
  const parameterSources = useMemo(() => {
    const fromValues = edges.flatMap((edge) => {
      const source = nodes.find((node) => node.id === edge.source);
      const target = nodes.find((node) => node.id === edge.target);
      if (!source || source.data.kind !== "value" || !target || !edge.targetHandle?.startsWith("in:")) return [];
      const inputId = edge.targetHandle.slice(3);
      const index = target.data.inputs.findIndex((port) => port.id === inputId) + 1;
      return [{ id: `${source.id}|${target.id}|${inputId}`, name: `value${index}`, sourceNodeId: source.id, targetNodeId: target.id, inputId, value: source.data.value ?? "", sourceKind: "value" as const, display: `${source.data.label} → ${target.data.label} · ${inputId}` }];
    });
    const fromFunctionParameters = nodes.flatMap((node) => (node.data.valueParameters ?? []).map((parameter) => ({ id: `${node.id}|${node.id}|${parameter.inputId}`, name: parameter.name, sourceNodeId: node.id, targetNodeId: node.id, inputId: parameter.inputId, value: parameter.value, sourceKind: "function" as const, display: `${node.data.label} · ${parameter.name}` })));
    return [...fromValues, ...fromFunctionParameters];
  }, [edges, nodes]);
  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle || connection.source === connection.target) return;
    const source = nodes.find((node) => node.id === connection.source);
    const target = nodes.find((node) => node.id === connection.target);
    const output = source?.data.outputs.find((port) => `out:${port.id}` === connection.sourceHandle);
    const input = target?.data.inputs.find((port) => `in:${port.id}` === connection.targetHandle);
    if (!output || !input || !arePortTypesCompatible(output.type, input.type)) return;
    setEdges((current) => {
      if (current.some((edge) => edge.source === connection.source && edge.sourceHandle === connection.sourceHandle || edge.target === connection.target && edge.targetHandle === connection.targetHandle)) return current;
      return [...current, { ...connection, id: crypto.randomUUID(), type: "smoothstep" }];
    });
  }, [nodes]);
  const addInternalNode = useCallback((definition: NodeDefinition, position: { x: number; y: number }) => {
    if (definition.id === initialDefinition.id) return;
    const data: FunctionNodeData = { label: definition.name, description: definition.description, kind: definition.kind, inputs: definition.inputs, outputs: definition.outputs, template: definition.template, outputTemplates: definition.outputTemplates, definitionId: definition.id, definitionGraph: definition.definitionGraph, valueParameters: definition.valueParameters, editableParameters: definition.editableParameters, compositeInputMappings: definition.compositeInputMappings, compositeOutputMappings: definition.compositeOutputMappings, compositeParameters: definition.compositeParameters, value: "", color: definition.color ?? "#24344c" };
    setNodes((current) => [...current, { id: crypto.randomUUID(), type: "function", position, data }]);
  }, [initialDefinition.id]);
  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault(); event.stopPropagation();
    const raw = event.dataTransfer.getData("application/x-visual-code-node") || event.dataTransfer.getData("text/plain");
    if (!raw) return;
    try {
      const definition = JSON.parse(raw) as NodeDefinition;
      const position = flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 120, y: 100 };
      addInternalNode(definition, position);
    } catch (error) { console.error("Could not add an internal node:", error); }
  }, [addInternalNode]);
  useEffect(() => {
    onAddNodeHandler((definition) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const screenPosition = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 120, y: 100 };
      const position = flow.current?.screenToFlowPosition(screenPosition) ?? { x: 120, y: 100 };
      addInternalNode(definition, position);
    });
    return () => onAddNodeHandler(null);
  }, [addInternalNode, onAddNodeHandler]);
  function updateInternalNode(patch: Partial<FunctionNodeData>) {
    if (!selectedNode) return;
    setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, ...patch } } : node));
  }
  function resizeInternalPorts(direction: "inputs" | "outputs", count: number) {
    if (!selectedNode) return;
    const currentPorts = selectedNode.data[direction];
    const minimum = direction === "inputs" ? selectedNode.data.editableParameters?.minInputCount ?? currentPorts.length : selectedNode.data.editableParameters?.minOutputCount ?? currentPorts.length;
    const next = ports(Math.max(minimum, count), direction === "inputs" ? "input" : "output", currentPorts);
    updateInternalNode({ [direction]: next });
    const handlePrefix = direction === "inputs" ? "in:" : "out:";
    const validHandles = new Set(next.map((port) => handlePrefix + port.id));
    setEdges((current) => current.filter((edge) => direction === "inputs"
      ? edge.target !== selectedNode.id || validHandles.has(edge.targetHandle ?? "")
      : edge.source !== selectedNode.id || validHandles.has(edge.sourceHandle ?? "")));
  }
  async function save() {
    if (!name.trim()) { setMessage("Enter a name for this Composite Node."); return; }
    const definition: NodeDefinition = { ...initialDefinition, id: initialDefinition.id, name: name.trim(), kind: "composite", inputs, outputs, template: "", outputTemplates: outputs.map(() => ""), category, language: targetExtension,
      definitionGraph: { nodes, edges }, compositeInputMappings: inputMappings.filter((mapping) => inputs.some((input) => input.id === mapping.inputId) && nodes.some((node) => node.id === mapping.nodeId && node.data.inputs.some((port) => port.id === mapping.nodeInputId))),
      compositeOutputMappings: outputMappings.filter((mapping) => outputs.some((output) => output.id === mapping.outputId) && nodes.some((node) => node.id === mapping.nodeId && node.data.outputs.some((port) => port.id === mapping.nodeOutputId))),
      compositeParameters: parameters.flatMap((parameter) => {
        const source = nodes.find((node) => node.id === parameter.sourceNodeId);
        if (!source || !nodes.some((node) => node.id === parameter.targetNodeId)) return [];
        const value = parameter.sourceKind === "value" ? source.data.value ?? "" : source.data.valueParameters?.find((item) => item.inputId === parameter.inputId)?.value ?? parameter.value;
        return [{ ...parameter, value }];
      }),
    };
    setSaving(true); setMessage("");
    try {
      const categories = await invoke<string[]>("list_node_categories", { libraryFolder });
      if (!categories.includes(category.trim())) await invoke("create_node_category", { libraryFolder, category: category.trim() });
      await invoke("save_node_definition", { libraryFolder, definition, category }); onSaved(definition);
    }
    catch (error) { setMessage(`Could not save Composite Node: ${String(error)}`); }
    finally { setSaving(false); }
  }
  return <div className="function-definition-editor composite-definition-editor">
    <div className="definition-editor-toolbar"><div><strong>{isNew ? "Define Composite Node" : "Edit Composite Node"}</strong><span>Configure its public interface around the internal graph</span></div><button className="cancel-button" onClick={onCancel}>Back to graph</button></div>
    <div ref={canvasRef} className="composite-internal-workspace" onDrop={onDrop} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; }}><div className="composite-internal-heading">Internal network · nodes inside this boundary define the Composite Node</div>
      <ReactFlow<Node<FunctionNodeData>, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        onNodesChange={(changes: NodeChange<Node<FunctionNodeData>>[]) => setNodes((current) => applyNodeChanges(changes, current))}
        onEdgesChange={(changes) => setEdges((current) => retainValidSinglePortConnections(nodes, applyEdgeChanges(changes, current)))} onConnect={onConnect} onInit={(instance) => { flow.current = instance; }}
        isValidConnection={(connection) => {
          if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle || connection.source === connection.target) return false;
          const source = nodes.find((node) => node.id === connection.source);
          const target = nodes.find((node) => node.id === connection.target);
          const output = source?.data.outputs.find((port) => `out:${port.id}` === connection.sourceHandle);
          const input = target?.data.inputs.find((port) => `in:${port.id}` === connection.targetHandle);
          return Boolean(output && input && arePortTypesCompatible(output.type, input.type) && !edges.some((edge) => edge.source === connection.source && edge.sourceHandle === connection.sourceHandle || edge.target === connection.target && edge.targetHandle === connection.targetHandle));
        }}
        onNodeDoubleClick={(_event, node) => setSettingsNodeId(node.id)} onNodeContextMenu={(event, node) => { event.preventDefault(); setSettingsNodeId(node.id); }} fitView colorMode="dark" deleteKeyCode={["Backspace", "Delete"]}>
        <Background color="#303c50" gap={22} size={1} /><Controls />
      </ReactFlow>
      {selectedNode && <div className="node-instance-settings definition-value-settings"><header><strong>Internal node settings</strong><button onClick={() => setSettingsNodeId("")}>×</button></header>
        {(!internalDefinitionLocked || internalEditability.name) && <label>Name<input value={selectedNode.data.label} onChange={(event) => updateInternalNode({ label: event.target.value })} /></label>}
        <label>Color<input type="color" value={selectedNode.data.color ?? "#24344c"} onChange={(event) => updateInternalNode({ color: event.target.value })} /></label>
        {internalDefinitionLocked && internalEditability.description && <label>Description<input value={selectedNode.data.description} onChange={(event) => updateInternalNode({ description: event.target.value })} /></label>}
        {selectedNode.data.kind === "value" && <label>Value<input value={selectedNode.data.value ?? ""} onChange={(event) => updateInternalNode({ value: event.target.value })} /></label>}
        {selectedNode.data.kind === "function" && internalEditability.inputCount && <label>Inputs<input type="number" min={selectedNode.data.editableParameters?.minInputCount ?? selectedNode.data.inputs.length} max="16" value={selectedNode.data.inputs.length} onChange={(event) => resizeInternalPorts("inputs", Number(event.target.value))} /></label>}
        {selectedNode.data.kind === "function" && internalEditability.outputCount && <label>Outputs<input type="number" min={selectedNode.data.editableParameters?.minOutputCount ?? selectedNode.data.outputs.length} max="16" value={selectedNode.data.outputs.length} onChange={(event) => resizeInternalPorts("outputs", Number(event.target.value))} /></label>}
        {internalDefinitionLocked && internalEditability.logic && <label>Logic<textarea value={selectedNode.data.template} onChange={(event) => updateInternalNode({ template: event.target.value })} /></label>}
        {internalDefinitionLocked && internalEditability.outputMappings && selectedNode.data.outputs.map((output, index) => <label key={output.id}>Output {index + 1}<select value={selectedNode.data.outputTemplates?.[index] ?? ""} onChange={(event) => updateInternalNode({ outputTemplates: selectedNode.data.outputs.map((_port, mappingIndex) => mappingIndex === index ? event.target.value : selectedNode.data.outputTemplates?.[mappingIndex] ?? "") })}><option value="">No mapping</option><option value="Logic">Logic</option>{selectedNode.data.inputs.map((input) => <option key={input.id} value={input.id}>{input.id}</option>)}</select></label>)}
        {(selectedNode.data.valueParameters ?? []).filter((parameter) => parameter.editable && !edges.some((edge) => edge.target === selectedNode.id && edge.targetHandle === `in:${parameter.inputId}`)).map((parameter) => <label key={parameter.inputId}>{parameter.name}<input value={parameter.value} onChange={(event) => updateInternalNode({ valueParameters: (selectedNode.data.valueParameters ?? []).map((item) => item.inputId === parameter.inputId ? { ...item, value: event.target.value } : item) })} /></label>)}
      </div>}
    </div>
    <div className="composite-public-interface">
      <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Category/subcategory<input value={category} onChange={(event) => setCategory(event.target.value)} /></label>
      <label>Inputs<input type="number" min={minimumInputs} max="16" value={inputs.length} onChange={(event) => { const next = ports(Math.max(minimumInputs, Number(event.target.value)), "input", inputs); setInputs(next); setInputMappings((current) => current.filter((mapping) => next.some((port) => port.id === mapping.inputId))); }} /></label>
      <div className="composite-mappings"><strong>Outer inputs → internal inputs</strong>{inputs.map((port, index) => <label key={port.id}>input{index + 1}<select value={inputMappings.find((mapping) => mapping.inputId === port.id) ? `${inputMappings.find((mapping) => mapping.inputId === port.id)!.nodeId}|${inputMappings.find((mapping) => mapping.inputId === port.id)!.nodeInputId}` : ""} onChange={(event) => { const [nodeId, nodeInputId] = event.target.value.split("|"); setInputMappings((current) => [...current.filter((mapping) => mapping.inputId !== port.id), ...(nodeId ? [{ inputId: port.id, nodeId, nodeInputId }] : [])]); }}><option value="">Unmapped</option>{internalInputs.filter((target) => !inputMappings.some((mapping) => mapping.inputId !== port.id && mapping.nodeId === target.nodeId && mapping.nodeInputId === target.portId)).map((target) => <option key={`${target.nodeId}|${target.portId}`} value={`${target.nodeId}|${target.portId}`}>{target.nodeName} · {target.portId}</option>)}</select></label>)}</div>
      <label>Outputs<input type="number" min={minimumOutputs} max="16" value={outputs.length} onChange={(event) => { const next = ports(Math.max(minimumOutputs, Number(event.target.value)), "output", outputs); setOutputs(next); setOutputMappings((current) => current.filter((mapping) => next.some((port) => port.id === mapping.outputId))); }} /></label>
      <div className="composite-mappings"><strong>Internal outputs → outer outputs</strong>{outputs.map((port, index) => <label key={port.id}>output{index + 1}<select value={outputMappings.find((mapping) => mapping.outputId === port.id) ? `${outputMappings.find((mapping) => mapping.outputId === port.id)!.nodeId}|${outputMappings.find((mapping) => mapping.outputId === port.id)!.nodeOutputId}` : ""} onChange={(event) => { const [nodeId, nodeOutputId] = event.target.value.split("|"); setOutputMappings((current) => [...current.filter((mapping) => mapping.outputId !== port.id), ...(nodeId ? [{ outputId: port.id, nodeId, nodeOutputId }] : [])]); }}><option value="">Unmapped</option>{internalOutputs.filter((target) => !outputMappings.some((mapping) => mapping.outputId !== port.id && mapping.nodeId === target.nodeId && mapping.nodeOutputId === target.portId)).map((target) => <option key={`${target.nodeId}|${target.portId}`} value={`${target.nodeId}|${target.portId}`}>{target.nodeName} · {target.portId}</option>)}</select></label>)}</div>
      <div className="composite-mappings"><strong>Exposed internal parameters</strong><select value="" onChange={(event) => { const source = parameterSources.find((item) => item.id === event.target.value); if (source && !parameters.some((parameter) => parameter.id === source.id)) setParameters((current) => [...current, { id: source.id, name: source.name, sourceNodeId: source.sourceNodeId, targetNodeId: source.targetNodeId, inputId: source.inputId, value: source.value, sourceKind: source.sourceKind, editable: true }]); }}><option value="">Expose a parameter…</option>{parameterSources.filter((source) => !parameters.some((parameter) => parameter.id === source.id)).map((source) => <option key={source.id} value={source.id}>{source.display}</option>)}</select>{parameters.map((parameter) => <label key={parameter.id}><input aria-label="Outer parameter name" value={parameter.name} onChange={(event) => setParameters((current) => current.map((item) => item.id === parameter.id ? { ...item, name: event.target.value } : item))} /><span><input type="checkbox" checked={parameter.editable} onChange={(event) => setParameters((current) => current.map((item) => item.id === parameter.id ? { ...item, editable: event.target.checked } : item))} /> Editable</span><button type="button" onClick={() => setParameters((current) => current.filter((item) => item.id !== parameter.id))}>×</button></label>)}</div>
      <label>Save<button className="save-button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save Composite"}</button></label>
      {message && <small>{message}</small>}
    </div>
  </div>;
}
