import type { Edge, Node } from "@xyflow/react";

export type PortType = "text" | "exec";
export type NodePort = { id: string; label: string; type: PortType };
export type NodeKind = "function" | "value";
export type EditableParameterKey = "name" | "description" | "inputCount" | "outputCount" | "logic" | "outputMappings";
export type NodeParameterEditability = Record<EditableParameterKey, boolean> & {
  minInputCount?: number;
  minOutputCount?: number;
};
export const DEFAULT_NODE_PARAMETER_EDITABILITY: NodeParameterEditability = {
  name: true,
  description: false,
  inputCount: false,
  outputCount: false,
  logic: false,
  outputMappings: false,
};
export type FunctionNodeData = {
  label: string; description: string; kind: NodeKind; inputs: NodePort[]; outputs: NodePort[];
  template: string; outputTemplates: string[]; value?: string; color?: string; width?: number; height?: number;
  definitionId?: string; category?: string; language?: string;
  definitionGraph?: { nodes: Node<FunctionNodeData>[]; edges: Edge[] };
  editableParameters?: NodeParameterEditability;
};
export type NodeDefinition = {
  id: string; name: string; description: string; kind: NodeKind; inputs: NodePort[]; outputs: NodePort[];
  template: string; outputTemplates: string[]; color?: string; category?: string; language?: string;
  definitionGraph?: { nodes: Node<FunctionNodeData>[]; edges: Edge[] };
  editableParameters?: NodeParameterEditability;
};
export const BUILT_IN_NODES: NodeDefinition[] = [
  { id: "builtin-value", name: "Value Node", description: "Supplies text to connected nodes.", kind: "value", inputs: [], outputs: [{id:"output1",label:"Value",type:"text"}], template: "", outputTemplates: ["value"] },
  { id: "builtin-function", name: "Function Node", description: "Generates text from an editable template.", kind: "function", inputs: [{id:"input1",label:"Input 1",type:"text"}], outputs: [{id:"output1",label:"Output 1",type:"text"}], template: "input1", outputTemplates: ["input1"] },
];
export function createNodeData(definition: NodeDefinition): FunctionNodeData {
 return { label: definition.name, description: definition.description, kind: definition.kind,
 inputs: definition.inputs.map(p=>({...p})), outputs: definition.outputs.map(p=>({...p})), template: definition.template,
 outputTemplates: [...definition.outputTemplates], editableParameters: { ...DEFAULT_NODE_PARAMETER_EDITABILITY, ...definition.editableParameters }, value: "", color: definition.color ?? (definition.kind === "value" ? "#303b52" : "#24344c"), definitionId: definition.id,
 category: definition.category ?? "Default", language: definition.language,
 definitionGraph: definition.definitionGraph ? structuredClone(definition.definitionGraph) : undefined, };
}
export function normalizeNodeData(data: Partial<FunctionNodeData>): FunctionNodeData {
 return { label:data.label ?? "Function", description:data.description ?? "", kind:data.kind ?? "function", inputs:data.inputs ?? [], outputs:data.outputs ?? [], template:data.template ?? "input1", outputTemplates:data.outputTemplates ?? [], editableParameters:data.editableParameters ? { ...DEFAULT_NODE_PARAMETER_EDITABILITY, ...data.editableParameters } : undefined, value:data.value ?? "", color:data.color ?? "#24344c", width:data.width, height:data.height, definitionId:data.definitionId, category:data.category ?? "Default", language:data.language, definitionGraph:data.definitionGraph };
}
export function arePortTypesCompatible(source: PortType, target: PortType): boolean { return source === target; }
export function normalizeLanguageExtension(value: string): string { const cleaned=value.trim().replace(/^\.+/,"").toLowerCase(); return cleaned ? `.${cleaned}` : ".py"; }

export function definitionMatchesExtension(definition: NodeDefinition,targetExtension: string): boolean { return !definition.language || normalizeLanguageExtension(definition.language)===normalizeLanguageExtension(targetExtension); }
