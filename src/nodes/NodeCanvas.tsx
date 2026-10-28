
import { useCallback, useMemo } from "react";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  MarkerType,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import NodeLibrary from "./NodeLibrary";
import { VisualNode } from "./VisualNode";

import {
  arePortTypesCompatible,
  normalizeNodeData,
  type FunctionNodeData,
  type NodeDefinition,
  type NodePort,
} from "./nodeDefinitions";

const nodeTypes = {
  function: VisualNode,
};

type NodeCanvasProps = {
  nodes: Node<FunctionNodeData>[];
  edges: Edge[];
  setNodes: React.Dispatch<
    React.SetStateAction<Node<FunctionNodeData>[]>
  >;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  libraryFolder: string;
  targetExtension: string;
  onChanged: () => void;
};

export default function NodeCanvas({
  nodes,
  edges,
  setNodes,
  setEdges,
  libraryFolder,
  targetExtension,
  onChanged,
}: NodeCanvasProps) {
  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<FunctionNodeData>>[]) => {
      setNodes((currentNodes) =>
        applyNodeChanges(changes, currentNodes)
      );
      onChanged();
    },
    [setNodes, onChanged]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((currentEdges) =>
        applyEdgeChanges(changes, currentEdges)
      );
      onChanged();
    },
    [setEdges, onChanged]
  );

  const handleAddNode = useCallback(
    (definition: NodeDefinition) => {
      const newNode: Node<FunctionNodeData> = {
        id: crypto.randomUUID(),
        type: "function",
        position: {
          x: 180 + Math.random() * 160,
          y: 120 + Math.random() * 160,
        },
        data: normalizeNodeData({
          label: definition.name,
          description: definition.description,
          kind: definition.kind,
          inputs: definition.inputs,
          outputs: definition.outputs,
          template: definition.template,
          outputTemplates: definition.outputTemplates,
          editableParameters: definition.editableParameters,
          value: "",
          definitionId: definition.id,
          category: definition.category,
          language: definition.language,
        }),
      };

      setNodes((currentNodes) => [...currentNodes, newNode]);
      onChanged();
    },
    [setNodes, onChanged]
  );

  const getPort = useCallback(
    (
      node: Node<FunctionNodeData> | undefined,
      handleId: string | null | undefined,
      direction: "input" | "output"
    ): NodePort | undefined => {
      if (!node || !handleId) {
        return undefined;
      }

      const prefix = direction === "input" ? "in:" : "out:";

      if (!handleId.startsWith(prefix)) {
        return undefined;
      }

      const portId = handleId.slice(prefix.length);
      const ports =
        direction === "input"
          ? node.data.inputs
          : node.data.outputs;

      return ports?.find((port) => port.id === portId);
    },
    []
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const sourceNode = nodes.find(
        (node) => node.id === connection.source
      );

      const targetNode = nodes.find(
        (node) => node.id === connection.target
      );

      const connectionId = "id" in connection ? connection.id : undefined;
      if (edges.some((edge) => edge.id !== connectionId && (
        (edge.source === connection.source && edge.sourceHandle === connection.sourceHandle) ||
        (edge.target === connection.target && edge.targetHandle === connection.targetHandle)
      ))) return false;

      if (!sourceNode || !targetNode) {
        return false;
      }

      // Prevent connecting a node to itself.
      if (connection.source === connection.target) {
        return false;
      }

      const sourcePort = getPort(
        sourceNode,
        connection.sourceHandle,
        "output"
      );

      const targetPort = getPort(
        targetNode,
        connection.targetHandle,
        "input"
      );

      // Only connect valid output-to-input handles.
      if (!sourcePort || !targetPort) {
        return false;
      }

      // Execution connections must connect to execution ports.
      if (
        sourcePort.type === "exec" ||
        targetPort.type === "exec"
      ) {
        return (
          sourcePort.type === "exec" &&
          targetPort.type === "exec"
        );
      }

      // Data connections must use compatible data types.
      return arePortTypesCompatible(
        sourcePort.type,
        targetPort.type
      );
    },
    [edges, nodes, getPort]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!isValidConnection(connection)) {
        return;
      }

      const sourceNode = nodes.find(
        (node) => node.id === connection.source
      );

      const sourcePort = getPort(
        sourceNode,
        connection.sourceHandle,
        "output"
      );

      const isExecutionConnection =
        sourcePort?.type === "exec";

      const newEdge: Edge = {
        ...connection,
        id: crypto.randomUUID(),
        type: "smoothstep",
        animated: isExecutionConnection,
        style: {
          stroke: isExecutionConnection ? "#f4f4f5" : "#60a5fa",
          strokeWidth: 2,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isExecutionConnection ? "#f4f4f5" : "#60a5fa",
        },
      };

      setEdges((currentEdges) => {
        if (currentEdges.some((edge) =>
          (edge.source === connection.source && edge.sourceHandle === connection.sourceHandle) ||
          (edge.target === connection.target && edge.targetHandle === connection.targetHandle)
        )) return currentEdges;
        return addEdge(newEdge, currentEdges);
      });
      onChanged();
    },
    [nodes, getPort, isValidConnection, setEdges, onChanged]
  );

  const styledEdges = useMemo(
    () =>
      edges.map((edge) => {
        const sourceNode = nodes.find(
          (node) => node.id === edge.source
        );

        const sourcePort = getPort(
          sourceNode,
          edge.sourceHandle,
          "output"
        );

        const isExecutionConnection =
          sourcePort?.type === "exec";

        return {
          ...edge,
          type: edge.type ?? "smoothstep",
          animated: edge.animated ?? isExecutionConnection,
          style: {
            stroke: isExecutionConnection ? "#f4f4f5" : "#60a5fa",
            strokeWidth: 2,
            ...edge.style,
          },
          markerEnd: edge.markerEnd ?? {
            type: MarkerType.ArrowClosed,
            color: isExecutionConnection ? "#f4f4f5" : "#60a5fa",
          },
        };
      }),
    [edges, nodes, getPort]
  );

  return (
    <div
      className="node-canvas"
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <NodeLibrary
        libraryFolder={libraryFolder}
        targetExtension={targetExtension}
        onAddNode={handleAddNode}
      />

      <div
        style={{
          flex: 1,
          minWidth: 0,
          height: "100%",
          position: "relative",
        }}
      >
        <ReactFlow<Node<FunctionNodeData>, Edge>
          nodes={nodes}
          edges={styledEdges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          isValidConnection={isValidConnection}
          fitView
          deleteKeyCode={["Backspace", "Delete"]}
          defaultEdgeOptions={{
            type: "smoothstep",
          }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
          />
          <Controls />
          <MiniMap
            nodeStrokeWidth={3}
            zoomable
            pannable
          />
        </ReactFlow>
      </div>
    </div>
  );
}
