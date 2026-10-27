
import { Handle, Position, type NodeProps } from "@xyflow/react";

type FunctionNodeData = {
  label: string;
  description?: string;
};

export default function FunctionNode({
  data,
  selected,
}: NodeProps) {
  const nodeData = data as FunctionNodeData;

  return (
    <div className={`function-node${selected ? " selected" : ""}`}>
      <Handle type="target" position={Position.Left} />

      <div className="function-node-title">
        {String(nodeData.label)}
      </div>

      {nodeData.description && (
        <div className="function-node-description">
          {nodeData.description}
        </div>
      )}

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
