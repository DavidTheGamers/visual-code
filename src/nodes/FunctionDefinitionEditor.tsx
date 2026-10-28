import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import {
  createNodeData,
  DEFAULT_NODE_PARAMETER_EDITABILITY,
  type EditableParameterKey,
  type FunctionNodeData,
  type NodeDefinition,
  type NodeParameterEditability,
  type NodePort,
} from "./nodeDefinitions";
import { VisualNode } from "./VisualNode";
import "./nodes.css";

const ROOT_ID = "definition-root";
const nodeTypes = { function: VisualNode };

type Props = {
  initialDefinition: NodeDefinition;
  themeMode: "dark" | "light";
  targetExtension: string;
  libraryFolder: string;
  onCancel: () => void;
  onSaved: (definition: NodeDefinition) => void;
  onAddNodeHandler: (handler: ((definition: NodeDefinition) => void) | null) => void;
};

function makePorts(count: number, direction: "input" | "output", current: NodePort[]): NodePort[] {
  const safeCount = Math.max(0, Math.min(16, count));
  return Array.from({ length: safeCount }, (_, index) => current[index] ?? {
    id: `${direction}${index + 1}`,
    label: `${direction === "input" ? "Input" : "Output"} ${index + 1}`,
    type: "text" as const,
  });
}

function validDefinitionEdges(definition: NodeDefinition): Edge[] {
  const nodes = definition.definitionGraph?.nodes ?? [];
  const inputs = new Set(definition.inputs.map((input) => input.id));
  const occupiedInputs = new Set<string>();
  const occupiedOutputs = new Set<string>();
  return (definition.definitionGraph?.edges ?? []).filter((edge) => {
    if (edge.target !== ROOT_ID || !edge.sourceHandle?.startsWith("out:") || !edge.targetHandle?.startsWith("in:")) return false;
    const source = nodes.find((node) => node.id === edge.source);
    const outputId = edge.sourceHandle.slice(4);
    const inputId = edge.targetHandle.slice(3);
    if (!source || source.data.kind !== "value" || !source.data.outputs.some((port) => port.id === outputId) || !inputs.has(inputId)) return false;
    const outputKey = `${edge.source}:${edge.sourceHandle}`;
    const inputKey = `${edge.target}:${edge.targetHandle}`;
    if (occupiedOutputs.has(outputKey) || occupiedInputs.has(inputKey)) return false;
    occupiedOutputs.add(outputKey);
    occupiedInputs.add(inputKey);
    return true;
  });
}

export default function FunctionDefinitionEditor({ initialDefinition, targetExtension, libraryFolder, themeMode, onCancel, onSaved, onAddNodeHandler }: Props) {
  const [name, setName] = useState(initialDefinition.name);
  const [description, setDescription] = useState(initialDefinition.description);
  const [template, setTemplate] = useState(initialDefinition.template);
  const [inputs, setInputs] = useState(initialDefinition.inputs);
  const [outputs, setOutputs] = useState(initialDefinition.outputs);
  const [outputMappings, setOutputMappings] = useState<string[]>(() =>
    initialDefinition.outputs.map((_port, index) =>
      initialDefinition.outputTemplates?.[index] ?? (index < initialDefinition.inputs.length ? initialDefinition.inputs[index].id : ""),
    ),
  );
  const [outputMappingMode, setOutputMappingMode] = useState(false);
  const [parameterEditable, setParameterEditable] = useState<Record<string, boolean>>(() => Object.fromEntries(
    (initialDefinition.valueParameters ?? []).map((parameter) => [parameter.inputId, parameter.editable]),
  ));
  const [parameterLabels, setParameterLabels] = useState<Record<string, string>>(() => Object.fromEntries(
    (initialDefinition.valueParameters ?? []).map((parameter) => [parameter.inputId, parameter.label ?? ""]),
  ));
  const [editableParameters, setEditableParameters] = useState<NodeParameterEditability>(() => ({
    ...DEFAULT_NODE_PARAMETER_EDITABILITY,
    ...initialDefinition.editableParameters,
  }));
  const [category, setCategory] = useState(initialDefinition.category ?? "Default");
  const [show, setShow] = useState(initialDefinition.show ?? true);
  const [categories, setCategories] = useState<string[]>(["Default"]);
  const [valueNodes, setValueNodes] = useState<Node<FunctionNodeData>[]>(() =>
    (initialDefinition.definitionGraph?.nodes ?? [])
      .filter((node) => node.data.kind === "value")
      .map((node) => ({
        ...node,
        position: { ...node.position },
        data: {
          ...node.data,
          inputs: node.data.inputs.map((port) => ({ ...port })),
          outputs: node.data.outputs.map((port) => ({ ...port })),
          outputTemplates: [...node.data.outputTemplates],
          definitionGraph: undefined,
        },
      })),
  );
  const [nodeValues, setNodeValues] = useState<Record<string, string>>(() => Object.fromEntries(
    (initialDefinition.definitionGraph?.nodes ?? [])
      .filter((node) => node.data.kind === "value")
      .map((node) => [node.id, node.data.value ?? ""]),
  ));
  const [edges, setEdges] = useState<Edge[]>(() => validDefinitionEdges(initialDefinition).map((edge) => ({ ...edge })));
  const [settingsNodeId, setSettingsNodeId] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const flowInstance = useRef<ReactFlowInstance<Node<FunctionNodeData>, Edge> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    invoke<string[]>("list_node_categories", { libraryFolder })
      .then((result) => { if (active) setCategories(result.length ? result : ["Default"]); })
      .catch((error) => { if (active) setMessage(`Could not load categories: ${String(error)}`); });
    return () => { active = false; };
  }, [libraryFolder]);

  const rootNode = useMemo<Node<FunctionNodeData>>(() => ({
    id: ROOT_ID,
    type: "function",
    position: { x: 430, y: 170 },
    draggable: false,
    selectable: false,
    data: {
      label: name || "Function Node",
      description,
      kind: "function",
      inputs,
      outputs,
      template,
      outputTemplates: outputMappings,
      color: "#24344c",
    },
  }), [name, description, inputs, outputs, outputMappings, template]);

  const preview = useMemo(() => {
    const values = new Map<string, string>();
    for (const input of inputs) {
      const edge = edges.find((item) => item.target === ROOT_ID && item.targetHandle === `in:${input.id}`);
      const source = valueNodes.find((node) => node.id === edge?.source);
      const value = source ? nodeValues[source.id] ?? source.data.value ?? "" : "";
      values.set(input.id, value);
    }
    return template.replace(/\binput(\d+)\b/g, (_match, index: string) => values.get(`input${index}`) ?? "");
  }, [edges, inputs, nodeValues, template, valueNodes]);

  const valueParameters = useMemo(() => inputs.flatMap((input, index) => {
    const edge = edges.find((item) => item.target === ROOT_ID && item.targetHandle === `in:${input.id}`);
    const source = valueNodes.find((node) => node.id === edge?.source);
    if (!source || source.data.kind !== "value") return [];
    const existing = initialDefinition.valueParameters?.find((parameter) => parameter.inputId === input.id);
    return [{
      inputId: input.id,
      name: `value${index + 1}`,
      label: parameterLabels[input.id] ?? initialDefinition.valueParameters?.find((parameter) => parameter.inputId === input.id)?.label ?? "",
      value: nodeValues[source.id] ?? source.data.value ?? "",
      editable: parameterEditable[input.id] ?? existing?.editable ?? true,
    }];
  }), [edges, initialDefinition.valueParameters, inputs, nodeValues, parameterEditable, parameterLabels, valueNodes]);

  const handleNodesChange = useCallback((changes: NodeChange<Node<FunctionNodeData>>[]) => {
    setValueNodes((current) => applyNodeChanges(changes.filter((change) => change.type === "add" || change.id !== ROOT_ID), current));
  }, []);

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const addValueNode = useCallback((definition: NodeDefinition, base = { x: 430, y: 285 }) => {
    if (definition.kind !== "value") return;
    let position = { ...base };
    let attempt = 0;
    const occupied = [rootNode, ...valueNodes];
    while (occupied.some((node) => Math.abs(node.position.x - position.x) < 190 && Math.abs(node.position.y - position.y) < 72)) {
      attempt += 1;
      position = { x: base.x + attempt * 28, y: base.y + attempt * 22 };
    }
    const node: Node<FunctionNodeData> = { id: crypto.randomUUID(), type: "function", position, data: createNodeData(definition) };
    setValueNodes((current) => [...current, node]);
    setNodeValues((current) => ({ ...current, [node.id]: "" }));
  }, [rootNode, valueNodes]);

  useEffect(() => {
    onAddNodeHandler((definition) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const center = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 430, y: 285 };
      const position = flowInstance.current?.screenToFlowPosition(center) ?? { x: 430, y: 285 };
      addValueNode(definition, position);
    });
    return () => onAddNodeHandler(null);
  }, [addValueNode, onAddNodeHandler]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const raw = event.dataTransfer.getData("application/x-visual-code-node") || event.dataTransfer.getData("text/plain");
    if (!raw) return;
    try {
      const definition = JSON.parse(raw) as NodeDefinition;
      const base = flowInstance.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 430, y: 170 };
      addValueNode(definition, base);
    } catch (error) { console.error("Could not add a Value Node to the definition:", error); }
  }, [addValueNode]);

  const handleConnect = useCallback((connection: Connection) => {
    if (connection.target !== ROOT_ID || !connection.targetHandle?.startsWith("in:")) return;
    const source = valueNodes.find((node) => node.id === connection.source);
    if (!source || source.data.kind !== "value" || !connection.sourceHandle ||
      !source.data.outputs.some((port) => `out:${port.id}` === connection.sourceHandle) ||
      !inputs.some((port) => `in:${port.id}` === connection.targetHandle)) return;
    setEdges((current) => {
      if (current.some((edge) =>
        (edge.source === connection.source && edge.sourceHandle === connection.sourceHandle) ||
        (edge.target === connection.target && edge.targetHandle === connection.targetHandle)
      )) return current;
      return addEdge({
        ...connection,
        id: crypto.randomUUID(),
        type: "smoothstep",
        style: { stroke: "#60a5fa", strokeWidth: 2 },
      }, current);
    });
  }, [inputs, valueNodes]);

  function setInputCount(count: number) {
    const next = makePorts(count, "input", inputs);
    setInputs(next);
    const validInputIds = new Set(next.map((port) => port.id));
    setOutputMappings((current) => current.map((mapping) => mapping === "Logic" || validInputIds.has(mapping) ? mapping : ""));
    const allowed = new Set(next.map((port) => "in:" + port.id));
    setEdges((current) => current.filter((edge) => edge.target !== ROOT_ID || allowed.has(edge.targetHandle ?? "")));
  }

  function setOutputCount(count: number) {
    const next = makePorts(count, "output", outputs);
    setOutputs(next);
    setOutputMappings((current) => next.map((_port, index) => current[index] ?? ""));
  }

  async function saveDefinition() {
    const cleanName = name.trim();
    if (!cleanName) { setMessage("Enter a name for this Function Node."); return; }
    const mappings = outputs.map((_port, index) => (outputMappings[index] ?? "").trim());
    const invalidMappingIndex = mappings.findIndex((mapping) => mapping && mapping !== "Logic" && !inputs.some((input) => input.id === mapping));
    if (invalidMappingIndex >= 0) {
      setMessage("Output " + (invalidMappingIndex + 1) + " must map to Logic or one of the current inputs (input1, input2, …).");
      return;
    }
    setSaving(true);
    setMessage("");
    const definition: NodeDefinition = {
      id: initialDefinition.id === "builtin-function" ? crypto.randomUUID() : initialDefinition.id,
      name: cleanName,
      description: description.trim(),
      kind: "function",
      inputs,
      outputs,
      template,
      outputTemplates: mappings,
      show,
      valueParameters,
      editableParameters: {
        ...editableParameters,
        minInputCount: inputs.length,
        minOutputCount: outputs.length,
      },
      category,
      language: targetExtension,
      definitionGraph: {
        nodes: valueNodes.map((node) => ({
          ...node,
          data: { ...node.data, value: nodeValues[node.id] ?? node.data.value ?? "" },
        })),
        edges,
      },
    };
    try {
      await invoke("save_node_definition", { libraryFolder, definition, category });
      onSaved(definition);
    } catch (error) {
      setMessage(`Could not save node definition: ${String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  const selectedValueNode = valueNodes.find((node) => node.id === settingsNodeId);
  const editabilityOption = (key: EditableParameterKey) => (
    <label className="definition-editability-option">
      <input
        type="checkbox"
        checked={editableParameters[key]}
        onChange={(event) => setEditableParameters((current) => ({ ...current, [key]: event.target.checked }))}
      />
      Editable on instances
    </label>
  );

  return (
    <div className="function-definition-editor">
      <div className="definition-editor-toolbar">
        <div><strong>Define Function Node</strong><span>Build a reusable node for {targetExtension}</span></div>
        <button className="cancel-button" onClick={onCancel}>Back to graph</button>
      </div>
      <div ref={canvasRef} className="definition-canvas" onDrop={handleDrop} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; }}>
        <ReactFlow<Node<FunctionNodeData>, Edge>
          nodes={[rootNode, ...valueNodes]}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          onInit={(instance) => { flowInstance.current = instance; }}
          onNodeDoubleClick={(_event, node) => { if (node.id !== ROOT_ID) setSettingsNodeId(node.id); }}
          onNodeContextMenu={(event, node) => { event.preventDefault(); if (node.id !== ROOT_ID) setSettingsNodeId(node.id); }}
          fitView
          colorMode={themeMode}
          defaultEdgeOptions={{ type: "smoothstep" }}
        >
          <Background color={themeMode === "light" ? "#b8c4d4" : "#303c50"} gap={22} size={1} />
          <Controls />
          <MiniMap nodeColor="#162238" maskColor="rgba(9, 11, 16, 0.75)" />
        </ReactFlow>
        {selectedValueNode && <div key={selectedValueNode.id} className="node-instance-settings definition-value-settings">
          <header><strong>Value Node settings</strong><button onClick={() => setSettingsNodeId("")}>×</button></header>
          <label>Value<input autoFocus value={nodeValues[selectedValueNode.id] ?? selectedValueNode.data.value ?? ""} onChange={(event) => {
            const selectedId = selectedValueNode.id;
            const nextValue = event.target.value;
            setNodeValues((current) => ({ ...current, [selectedId]: nextValue }));
            setValueNodes((current) => current.map((node) => node.id === selectedId
              ? { ...node, data: { ...node.data, value: nextValue } }
              : node));
          }} /></label>
        </div>}
      </div>
      <div className="definition-parameters">
        <div className="definition-parameter-field">
          <label className="definition-field-control">Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Function name" /></label>
          {editabilityOption("name")}
        </div>
        <div className="definition-parameter-field">
          <label className="definition-field-control">Description<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this node does" /></label>
          {editabilityOption("description")}
        </div>
        <div className="definition-parameter-field">
          <label className="definition-field-control">Number of Inputs<input type="number" min="0" max="16" value={inputs.length} onChange={(event) => setInputCount(Number(event.target.value))} /></label>
          {editabilityOption("inputCount")}
        </div>
        <div className="definition-output-control">
          <button type="button" className="definition-output-mode-toggle" onClick={() => setOutputMappingMode((current) => !current)}>Number of Outputs</button>
          {outputMappingMode ? (
            <div className="definition-output-mappings">
              {outputs.length ? outputs.map((output, index) => (
                <label className="definition-output-mapping" key={output.id}>
                  <span>{output.label || "Output " + (index + 1)}</span>
                  <input
                    aria-label={(output.label || "Output " + (index + 1)) + " mapping"}
                    value={outputMappings[index] ?? ""}
                    placeholder="input1 or Logic"
                    onChange={(event) => setOutputMappings((current) => current.map((mapping, mappingIndex) => mappingIndex === index ? event.target.value : mapping))}
                  />
                </label>
              )) : <small>No outputs defined.</small>}
            </div>
          ) : <input type="number" min="0" max="16" value={outputs.length} onChange={(event) => setOutputCount(Number(event.target.value))} />}
          {editabilityOption("outputCount")}
          {editabilityOption("outputMappings")}
        </div>
        <div className="definition-parameter-field definition-logic-field">
          <label className="definition-field-control">Logic<textarea value={template} onChange={(event) => setTemplate(event.target.value)} placeholder="input1 = input2" spellCheck={false} /></label>
          {editabilityOption("logic")}
        </div>
        <div className="definition-save-controls">
          <label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
          <label className="definition-show-default"><input type="checkbox" checked={show} onChange={(event) => setShow(event.target.checked)} /> Show by default</label>
          <button className="save-button" disabled={saving || !libraryFolder.trim()} onClick={() => void saveDefinition()}>{saving ? "Saving…" : "Save definition"}</button>
        </div>
      {valueParameters.length > 0 && <div className="definition-value-parameters">
        <strong>Value parameters</strong>
        {valueParameters.map((parameter) => <label key={parameter.inputId}>
          <span>{parameter.name} · {parameter.inputId}</span>
          {parameter.editable && <input aria-label={`${parameter.name} display label`} placeholder={parameter.name} value={parameter.label ?? ""} onChange={(event) => setParameterLabels((current) => ({ ...current, [parameter.inputId]: event.target.value }))} />}
          <input value={parameter.value} readOnly aria-label={`${parameter.name} default value`} />
          <span><input type="checkbox" checked={parameter.editable} onChange={(event) => setParameterEditable((current) => ({ ...current, [parameter.inputId]: event.target.checked }))} /> Editable on instances</span>
        </label>)}
      </div>}
      <div className="definition-preview"><span>Preview from connected Value Nodes</span><code>{preview || "Generated text will appear here."}</code>{message && <small>{message}</small>}</div>
      </div>
    </div>
  );
}
