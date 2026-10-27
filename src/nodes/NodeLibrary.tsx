
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  BUILT_IN_NODES,
  definitionMatchesExtension,
  normalizeLanguageExtension,
  type NodeDefinition,
} from "./nodeDefinitions";

type NodeLibraryProps = {
  libraryFolder: string;
  targetExtension: string;
  onAddNode: (definition: NodeDefinition) => void;
};

export default function NodeLibrary({
  libraryFolder,
  targetExtension,
  onAddNode,
}: NodeLibraryProps) {
  const [definitions, setDefinitions] = useState<NodeDefinition[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function refreshLibrary() {
    if (!libraryFolder.trim()) {
      setDefinitions([]);
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const result = await invoke<NodeDefinition[]>(
        "list_node_definitions",
        { libraryFolder },
      );

      setDefinitions(Array.isArray(result) ? result : []);
    } catch (error) {
      console.error("Could not load node library:", error);
      setMessage("Could not load saved node definitions.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshLibrary();
  }, [libraryFolder]);

  const visibleBuiltIns = useMemo(
    () =>
      BUILT_IN_NODES.filter((definition) =>
        definitionMatchesExtension(definition, targetExtension),
      ),
    [targetExtension],
  );

  const visibleCustomDefinitions = useMemo(
    () =>
      definitions.filter((definition) =>
        definitionMatchesExtension(definition, targetExtension),
      ),
    [definitions, targetExtension],
  );

  function renderNode(definition: NodeDefinition, custom = false) {
    return (
      <button
        key={definition.id}
        className="node-library-item"
        title={definition.description}
        onClick={() => onAddNode(definition)}
      >
        <span className="node-library-item-icon">
          {custom ? "ƒ" : definition.kind === "value" ? "◇" : "ƒ"}
        </span>

        <span className="node-library-item-name">
          {definition.name}
        </span>

        <span className="node-library-add">+</span>
      </button>
    );
  }

  return (
    <div className="node-library-inner">
      <button
        className="node-library-heading"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="section-title">NODE LIBRARY</span>
        <span className="collapse-arrow">
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      {expanded && (
        <div className="node-library-content">
          {/* Fixed controls: these stay outside the scrolling list. */}
          <div className="node-library-controls">
            <div className="node-library-toolbar">
              <span className="node-library-language">
                Target: {normalizeLanguageExtension(targetExtension)}
              </span>

              <button
                className="node-library-refresh"
                onClick={() => void refreshLibrary()}
                disabled={loading}
                title="Refresh node definitions"
              >
                {loading ? "…" : "↻"}
              </button>
            </div>
          </div>

          {/* Only this region scrolls through the node definitions. */}
          <div className="node-library-list">
            <div className="node-library-subheading">Default</div>

            {visibleBuiltIns.length > 0 ? (
              visibleBuiltIns.map((definition) =>
                renderNode(definition),
              )
            ) : (
              <p className="empty-library">
                No built-in nodes available.
              </p>
            )}

            <div className="node-library-subheading">My functions</div>

            {visibleCustomDefinitions.length > 0 ? (
              visibleCustomDefinitions.map((definition) =>
                renderNode(definition, true),
              )
            ) : (
              <p className="empty-library">
                No saved functions for this target yet.
              </p>
            )}
          </div>

          {/* Messages stay separate from the node list. */}
          {(message || !libraryFolder.trim()) && (
            <div className="node-library-status">
              {message && (
                <div className="node-library-message">{message}</div>
              )}

              {!libraryFolder.trim() && (
                <div className="node-library-message">
                  Choose a node library folder in Settings to save
                  reusable functions.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
