import { Handle, Position, NodeResizer, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import type { FunctionNodeData } from "./nodeDefinitions";
import "./nodes.css";

export function VisualNode({ id, data, selected }: NodeProps<Node<FunctionNodeData>>) {
  const flow = useReactFlow<Node<FunctionNodeData>>();
  const minimumHeight = Math.max(72, (Math.max(data.inputs.length, data.outputs.length) + 1) * 18);

  const renderPorts = (items: FunctionNodeData["inputs"], direction: "input" | "output") =>
    items.map((port, index) => {
      const label = port.label || `${direction === "input" ? "Input" : "Output"} ${index + 1}`;
      const position = ((index + 1) / (items.length + 1)) * 100;
      const isInput = direction === "input";
      return (
        <Handle
          key={port.id}
          id={`${isInput ? "in" : "out"}:${port.id}`}
          type={isInput ? "target" : "source"}
          position={isInput ? Position.Left : Position.Right}
          title={label}
          aria-label={label}
          className={`vc-node-handle vc-node-handle-${direction} type-${port.type}`}
          style={{ top: `${position}%` }}
        />
      );
    });

  return (
    <div className={`vc-node${selected ? " vc-node-selected" : ""}`} style={{ background: data.color, width: data.width, minHeight: Math.max(minimumHeight, data.height ?? 0) }}>
      <NodeResizer
        isVisible={selected}
        minWidth={190}
        minHeight={minimumHeight}
        onResizeEnd={(_event, size) => {
          const selectedNodes = flow.getNodes().filter((node) => node.selected);
          const targets = selectedNodes.length > 1 ? selectedNodes : flow.getNodes().filter((node) => node.id === id);
          for (const node of targets) {
            const minimum = Math.max(72, (Math.max(node.data.inputs.length, node.data.outputs.length) + 1) * 18);
            flow.updateNodeData(node.id, { width: Math.max(190, size.width), height: Math.max(minimum, size.height) });
          }
        }}
      />
      {renderPorts(data.inputs, "input")}
      {renderPorts(data.outputs, "output")}
      <Handle id="order:in" type="target" position={Position.Top} title="Order after this node" aria-label="Order after this node" className="vc-order-handle vc-order-target" />
      <Handle id="order:out" type="source" position={Position.Bottom} title="Order before connected node" aria-label="Order before connected node" className="vc-order-handle vc-order-source" />
      <div className="vc-node-header">
        <span className="vc-node-symbol">{data.kind === "value" ? "◇" : data.kind === "composite" ? "▧" : "ƒ"}</span>
        <strong>{data.label}</strong>
      </div>
    </div>
  );
}
