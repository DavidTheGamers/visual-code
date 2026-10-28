import type { Edge, Node } from "@xyflow/react";
import type { FunctionNodeData } from "./nodeDefinitions";

export function generateSource(nodes: Node<FunctionNodeData>[], edges: Edge[]): string {
  let expandedNodes = [...nodes];
  let expandedEdges = [...edges];
  // Inline the stored graph of each Composite Node while retaining its actual
  // nodes and edges. A unique prefix keeps nested and reused composites apart.
  for (let depth = 0; depth < 24; depth += 1) {
    const composite = expandedNodes.find((node) => node.data.kind === "composite");
    if (!composite) break;
    const graph = composite.data.definitionGraph;
    const prefix = `${composite.id}::`;
    const boundaryEdges = expandedEdges.filter((edge) => edge.source === composite.id || edge.target === composite.id);
    const internalNodes = (graph?.nodes ?? []).map((node) => {
      const parameters = composite.data.compositeParameters ?? [];
      let data = node.data;
      for (const parameter of parameters.filter((item) => item.sourceNodeId === node.id)) {
        if (parameter.sourceKind === "value" && data.kind === "value") data = { ...data, value: parameter.value };
        else if (parameter.sourceKind === "function") data = { ...data, valueParameters: (data.valueParameters ?? []).map((item) => item.inputId === parameter.inputId ? { ...item, value: parameter.value } : item) };
      }
      return { ...node, id: prefix + node.id, selected: false, data };
    });
    const externalInputs = new Set(boundaryEdges
      .filter((edge) => edge.target === composite.id)
      .flatMap((edge) => {
        const inputId = edge.targetHandle?.replace(/^in:/, "") ?? "";
        const mapping = composite.data.compositeInputMappings?.find((item) => item.inputId === inputId);
        return mapping ? [`${mapping.nodeId}:in:${mapping.nodeInputId}`] : [];
      }));
    const internalEdges = (graph?.edges ?? []).filter((edge) => !externalInputs.has(`${edge.target}:${edge.targetHandle ?? ""}`)).map((edge) => ({ ...edge, id: `${prefix}${edge.id}`, source: prefix + edge.source, target: prefix + edge.target }));
    const nodeIds = new Set((graph?.nodes ?? []).map((node) => node.id));
    const mappedEdges: Edge[] = [];
    for (const edge of boundaryEdges) {
      if (edge.target === composite.id) {
        const inputId = edge.targetHandle?.replace(/^in:/, "") ?? "";
        const mapping = composite.data.compositeInputMappings?.find((item) => item.inputId === inputId);
        if (mapping && nodeIds.has(mapping.nodeId)) mappedEdges.push({ ...edge, id: `${edge.id}::in`, target: prefix + mapping.nodeId, targetHandle: `in:${mapping.nodeInputId}` });
      } else if (edge.source === composite.id) {
        const outputId = edge.sourceHandle?.replace(/^out:/, "") ?? "";
        const mapping = composite.data.compositeOutputMappings?.find((item) => item.outputId === outputId);
        if (mapping && nodeIds.has(mapping.nodeId)) mappedEdges.push({ ...edge, id: `${edge.id}::out`, source: prefix + mapping.nodeId, sourceHandle: `out:${mapping.nodeOutputId}` });
      }
    }
    expandedNodes = [...expandedNodes.filter((node) => node.id !== composite.id), ...internalNodes];
    expandedEdges = [...expandedEdges.filter((edge) => edge.source !== composite.id && edge.target !== composite.id), ...internalEdges, ...mappedEdges];
  }
  nodes = expandedNodes;
  edges = expandedEdges;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const cache = new Map<string, string>();

  const isAtomicExpression = (value: string) =>
    /^(?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/.test(value.trim());

  const isFullyParenthesized = (value: string) => {
    const text = value.trim();
    if (text.length < 2 || text[0] !== "(" || text[text.length - 1] !== ")") return false;
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === "'" || character === '"') { quote = character; continue; }
      if (character === "(") depth += 1;
      if (character === ")") {
        depth -= 1;
        if (depth === 0 && index !== text.length - 1) return false;
        if (depth < 0) return false;
      }
    }
    return depth === 0 && !quote;
  };

  const substituteInputs = (text: string, values: Map<string, string>) =>
    text.replace(/\binput(\d+)\b/g, (_match, index: string) => {
      const value = values.get("input" + index) ?? "";
      if (!value.trim() || isAtomicExpression(value) || isFullyParenthesized(value)) return value;
      return "(" + value + ")";
    });

  const resolveOutput = (nodeId: string, portId: string, stack: Set<string>): string => {
    const key = nodeId + ":" + portId;
    if (cache.has(key)) return cache.get(key)!;
    if (stack.has(nodeId)) return "";

    const node = byId.get(nodeId);
    if (!node) return "";
    const data = node.data;
    if (data.kind === "value") return data.value ?? "";

    const nextStack = new Set(stack);
    nextStack.add(nodeId);
    const values = new Map<string, string>();
    for (const input of data.inputs ?? []) {
      const edge = edges.find((item) => item.target === nodeId && item.targetHandle === "in:" + input.id);
      const parameter = data.valueParameters?.find((item) => item.inputId === input.id);
      values.set(input.id, edge && edge.sourceHandle
        ? resolveOutput(edge.source, edge.sourceHandle.replace(/^out:/, ""), nextStack)
        : parameter?.value ?? "");
    }
    const outputIndex = (data.outputs ?? []).findIndex((port) => port.id === portId);
    const mapping = data.outputTemplates?.[outputIndex] ?? "";
    const output = mapping === "Logic" ? substituteInputs(data.template, values) : substituteInputs(mapping, values);
    cache.set(key, output);
    return output;
  };

  const functionNodes = nodes.filter((node) => node.data.kind === "function");
  const functionNodeIds = new Set(functionNodes.map((node) => node.id));
  const pending = [...functionNodes];
  const orderedNodes: Node<FunctionNodeData>[] = [];

  // Connected functions follow the function supplying their input.
  // Preserve graph order among functions that are ready at the same time.
  while (pending.length > 0) {
    const readyIndex = pending.findIndex((node) =>
      !edges.some((edge) =>
        edge.target === node.id &&
        edge.source !== node.id &&
        functionNodeIds.has(edge.source) &&
        pending.some((candidate) => candidate.id === edge.source),
      ),
    );
    if (readyIndex < 0) {
      orderedNodes.push(...pending);
      break;
    }
    orderedNodes.push(pending.splice(readyIndex, 1)[0]);
  }

  const statements = orderedNodes.map((node) => {
    const values = new Map<string, string>();
    for (const input of node.data.inputs ?? []) {
      const edge = edges.find((item) => item.target === node.id && item.targetHandle === "in:" + input.id);
      const parameter = node.data.valueParameters?.find((item) => item.inputId === input.id);
      values.set(input.id, edge && edge.sourceHandle
        ? resolveOutput(edge.source, edge.sourceHandle.replace(/^out:/, ""), new Set([node.id]))
        : parameter?.value ?? "");
    }
    return substituteInputs(node.data.template, values);
  });

  return statements.filter((line) => line.length > 0).join("\n") + (statements.some(Boolean) ? "\n" : "");
}
