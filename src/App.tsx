import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ReactFlow,
  SelectionMode,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type OnNodesChange,
  type OnEdgesChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { open } from "@tauri-apps/plugin-dialog";
import { load } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import {
  arePortTypesCompatible,
  BUILT_IN_NODES,
  createNodeData,
  DEFAULT_NODE_PARAMETER_EDITABILITY,
  normalizeLanguageExtension,
  retainValidSinglePortConnections,
  type FunctionNodeData,
  type NodeDefinition,
  type NodePort,
} from "./nodes/nodeDefinitions";
import { VisualNode } from "./nodes/VisualNode";
import FunctionDefinitionEditor from "./nodes/FunctionDefinitionEditor";
import { generateSource } from "./nodes/codeGeneration";
import CompositeDefinitionEditor from "./nodes/CompositeDefinitionEditor";

import "@xyflow/react/dist/style.css";
import "./App.css";

type NodGraphFile = {
  format: "visual-code-graph";
  version: 1;
  name: string;
  targetExtension: string;
  sourceFile: string;
  nodes: Node<FunctionNodeData>[];
  edges: Edge[];
};

type CompositeCreationDraft = { definitionId: string; nodeIds: string[]; incomingEdges: Edge[]; outgoingEdges: Edge[]; center: { x: number; y: number } };

type ProjectEntry = {
  path: string;
  name: string;
  isDir: boolean;
  extension: string | null;
};

type EditorKind = "graph" | "text" | "none";

const DEFAULT_EXTENSION = ".py";

function normalizeExtension(value: string): string {
  const cleaned = value.trim().replace(/^\.+/, "").toLowerCase();
  return cleaned ? `.${cleaned}` : DEFAULT_EXTENSION;
}

function nodeLibraryPath(root: string, targetExtension: string): string {
  const selected = root.trim().replace(/[\\/]+$/, "");
  const extension = normalizeExtension(targetExtension);
  const languageFolder = `Nodes${extension}`;
  const parts = selected.split(/[\\/]/);
  const last = parts[parts.length - 1] ?? "";
  const base = /^Nodes\.[^.]+$/i.test(last)
    ? parts.slice(0, -1).join(selected.includes("\\") ? "\\" : "/")
    : selected;
  return base ? `${base}${base.includes("\\") ? "\\" : "/"}${languageFolder}` : languageFolder;
}

function folderName(path: string): string {
  if (!path) return "";
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function safeGraphFileName(name: string): string {
  return name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .replace(/^\.+$/, "");
}

/* -------------------- NODE LIBRARY -------------------- */
type NodeLibraryProps = {
  libraryFolder: string;
  targetExtension: string;
  onAddNode: (definition: NodeDefinition) => void;
  onEditDefinition: (definition: NodeDefinition) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  refreshVersion: number;
};

type NodeCategoryTree = { name: string; path: string; children: NodeCategoryTree[] };
function buildCategoryTree(paths: string[]): NodeCategoryTree[] {
  const roots: NodeCategoryTree[] = [];
  for (const path of paths) {
    let siblings = roots;
    let currentPath = "";
    for (const name of path.split("/")) {
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      let node = siblings.find((candidate) => candidate.name === name);
      if (!node) { node = { name, path: currentPath, children: [] }; siblings.push(node); }
      siblings = node.children;
    }
  }
  return roots;
}

function NodeLibrary({ libraryFolder, targetExtension, onAddNode, onEditDefinition, expanded, onExpandedChange, refreshVersion }: NodeLibraryProps) {
  const [definitions, setDefinitions] = useState<NodeDefinition[]>([]);
  const [categories, setCategories] = useState<string[]>(["Default"]);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(["Default"]));
  const [message, setMessage] = useState("");
  const requestId = useRef(0);
  const [addingCategory, setAddingCategory] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [categoryMenu, setCategoryMenu] = useState<string | null>(null);
  const [categoryDestination, setCategoryDestination] = useState("");
  const dragClickGuard = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setMessage("");
    if (!libraryFolder.trim()) {
      setDefinitions([]);
      setCategories(["Default"]);
      return;
    }
    try {
      const [defs, cats] = await Promise.all([
        invoke<NodeDefinition[]>("list_node_definitions", { libraryFolder }),
        invoke<string[]>("list_node_categories", { libraryFolder }),
      ]);
      if (currentRequest !== requestId.current) return;
      const nextCategories = cats.length ? cats : ["Default"];
      setDefinitions(defs);
      setCategories(nextCategories);
      setExpandedCategories((previous) => new Set([...previous, "Default"].filter((name) => nextCategories.includes(name))));
    } catch (error) {
      if (currentRequest === requestId.current) setMessage(`Could not load Node Library: ${String(error)}`);
    }
  }, [libraryFolder]);

  useEffect(() => {
    setDefinitions([]);
    setCategories(["Default"]);
    setExpandedCategories(new Set(["Default"]));
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh, refreshVersion]);
  const extension = normalizeLanguageExtension(targetExtension);
  const visibleDefinitions = definitions.filter((definition) => !definition.language || normalizeLanguageExtension(definition.language) === extension);
  const categoryTree = useMemo(() => buildCategoryTree(categories), [categories]);

  async function createCategory() {
    const name = categoryName.trim();
    if (!name) return;
    try {
      await invoke("create_node_category", { libraryFolder, category: name });
      setCategoryName("");
      setAddingCategory(false);
      setExpandedCategories((previous) => {
        const next = new Set(previous);
        const segments = name.split("/");
        for (let index = 1; index <= segments.length; index += 1) next.add(segments.slice(0, index).join("/"));
        return next;
      });
      await refresh();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function moveDefinition(definition: NodeDefinition) {
    const fromCategory = definition.category ?? "Default";
    const available = categories.filter((name) => name !== fromCategory);
    if (!available.length) { setMessage("Create another category first."); return; }
    const destination = window.prompt(`Move ${definition.name} to category (${available.join(", ")}):`, available[0]);
    if (!destination || !available.includes(destination)) return;
    try {
      await invoke("move_node_definition", { libraryFolder, definitionId: definition.id, fromCategory, toCategory: destination });
      await refresh();
    } catch (error) { setMessage(String(error)); }
  }

  async function moveCategory(category: string) {
    try {
      await invoke("move_node_category", { libraryFolder, category, destinationParent: categoryDestination });
      const destination = categoryDestination ? `${categoryDestination}/${category.split("/").pop()}` : category.split("/").pop() ?? category;
      const remap = (value: string) => value === category || value.startsWith(`${category}/`) ? `${destination}${value.slice(category.length)}` : value;
      setExpandedCategories((current) => {
        const next = new Set([...current].map(remap));
        const segments = destination.split("/");
        for (let index = 1; index <= segments.length; index += 1) next.add(segments.slice(0, index).join("/"));
        return next;
      });
      setCategoryMenu(null);
      await refresh();
    } catch (error) { setMessage(String(error)); }
  }

  async function reorderCategory(category: string, direction: "up" | "down") {
    try { await invoke("reorder_node_category", { libraryFolder, category, direction }); await refresh(); }
    catch (error) { setMessage(String(error)); }
  }

  function renderDefinition(definition: NodeDefinition, builtIn = false) {
    return (
      <div className="node-library-definition" key={definition.id}>
            <button
              className="node-library-item"
              title={definition.description}
              draggable
              onDragStart={(event) => {
                dragClickGuard.current = definition.id;
                const serialized = JSON.stringify(definition);
                event.dataTransfer.setData("application/x-visual-code-node", serialized);
                event.dataTransfer.setData("text/plain", serialized);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onDragEnd={() => { window.setTimeout(() => { if (dragClickGuard.current === definition.id) dragClickGuard.current = null; }, 500); }}
              onClick={() => {
                if (dragClickGuard.current === definition.id) {
                  dragClickGuard.current = null;
                  return;
                }
                onAddNode(definition);
              }}
            >
          <span className={`node-library-item-icon${definition.kind === "value" ? " value-icon" : " function-icon"}`}>{definition.kind === "value" ? "◇" : definition.kind === "composite" ? "▧" : "ƒ"}</span>
          <span className="node-library-item-name">{definition.name}</span>
          <span className="node-library-add">+</span>
        </button>
        {!builtIn && <>
          {(definition.kind === "function" || definition.kind === "composite") && <button className="node-library-move" title="Edit definition" aria-label={`Edit ${definition.name}`} onClick={() => onEditDefinition(definition)}>✎</button>}
          <button className="node-library-move" title="Move to another category" aria-label={`Move ${definition.name}`} onClick={() => void moveDefinition(definition)}>↗</button>
        </>}
      </div>
    );
  }

  const renderCategory = (category: NodeCategoryTree, siblings: NodeCategoryTree[], index: number): ReactNode => {
    const name = category.path;
    const isOpen = expandedCategories.has(name);
    const builtIns = name === "Default" ? BUILT_IN_NODES : [];
    const customNodes = visibleDefinitions.filter((definition) => (definition.category ?? "Default") === name);
    const availableParents = categories.filter((candidate) => candidate !== name && !candidate.startsWith(`${name}/`));
    return <section className={`node-category${isOpen ? " category-open" : ""}`} key={name}>
      <div className="node-category-heading">
        <button className="node-category-toggle" onClick={() => setExpandedCategories((previous) => { const next = new Set(previous); if (next.has(name)) next.delete(name); else next.add(name); return next; })} aria-expanded={isOpen}>
          <span className="node-category-chevron">{isOpen ? "⌄" : "›"}</span><span className="node-category-name">{category.name}</span><span className="node-category-count">{builtIns.length + customNodes.length}</span>
        </button>
        <button className="node-category-menu-trigger" title={`Category actions for ${category.name}`} aria-label={`Category actions for ${category.name}`} onClick={() => { setCategoryMenu((current) => current === name ? null : name); setCategoryDestination(category.path.includes("/") ? category.path.slice(0, category.path.lastIndexOf("/")) : ""); }}>⋯</button>
      </div>
      {categoryMenu === name && <div className="node-category-menu" onClick={(event) => event.stopPropagation()}>
        <label>Move under<select value={categoryDestination} onChange={(event) => setCategoryDestination(event.target.value)}>
          <option value="">Root</option>{availableParents.map((parent) => <option key={parent} value={parent}>{parent.split("/").join(" › ")}</option>)}
        </select></label>
        <button disabled={name === "Default"} onClick={() => void moveCategory(name)}>Move</button>
        <div className="node-category-order-actions">
          <button disabled={index === 0} title="Move up within this parent" onClick={() => void reorderCategory(name, "up")}>↑ Up</button>
          <button disabled={index === siblings.length - 1} title="Move down within this parent" onClick={() => void reorderCategory(name, "down")}>↓ Down</button>
        </div>
      </div>}
      {isOpen && <>
        <div className="node-category-items">
          {builtIns.map((definition) => renderDefinition(definition, true))}
          {customNodes.map((definition) => renderDefinition(definition))}
          {!builtIns.length && !customNodes.length && category.children.length === 0 && <p className="node-category-empty">No nodes in this category yet.</p>}
        </div>
        {category.children.length > 0 && <div className="node-category-children">{category.children.map((child, childIndex) => renderCategory(child, category.children, childIndex))}</div>}
      </>}
    </section>;
  };

  return (
    <div className={`node-library-inner${expanded ? " is-expanded" : " is-collapsed"}`}>
      <button className="node-library-heading" onClick={() => onExpandedChange(!expanded)} aria-expanded={expanded}>
        <span className="node-library-heading-mark">{expanded ? "▾" : "▸"}</span>
        <span className="node-library-heading-title">Node Library</span>
        <span className="node-library-heading-target">{extension}</span>
      </button>
      {expanded && <div className="node-library-content">
        <div className="node-library-toolbar">
          <div><span className="node-library-kicker">NODE SET</span><span className="node-library-language">Nodes{extension}</span></div>
          <button className="node-library-refresh" onClick={() => void refresh()} title="Refresh Node Library" aria-label="Refresh Node Library">↻</button>
        </div>
        <div className="node-library-categories-header">
          <span>Categories</span>
          <button onClick={() => { setAddingCategory((value) => !value); setMessage(""); }} aria-label="Create category" title="Create category">+</button>
        </div>
        {addingCategory && <form className="node-library-category-form" onSubmit={(event) => { event.preventDefault(); void createCategory(); }}>
          <input autoFocus value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="Category or Parent/Subcategory" aria-label="Category or subcategory name" />
          <button type="submit" disabled={!categoryName.trim()}>Add</button>
          <button type="button" className="category-cancel" onClick={() => { setAddingCategory(false); setCategoryName(""); }}>×</button>
        </form>}
        <div className="node-library-scroll">
          {categoryTree.map((category, index) => renderCategory(category, categoryTree, index))}
          {message && <div className="node-library-message">{message}</div>}
        </div>
      </div>}
    </div>
  );
}
const nodeTypes = { function: VisualNode };

/* -------------------- MAIN APPLICATION -------------------- */

export default function App() {
  const [nodes, setNodes, onNodesChange] =
    useNodesState<Node<FunctionNodeData>>([]);

  const [edges, setEdges, onEdgesChange] =
    useEdgesState<Edge>([]);

  const [projectFolder, setProjectFolder] = useState("");
  const [nodeLibraryFolder, setNodeLibraryFolder] = useState("");

  const [preferredExtension, setPreferredExtension] =
    useState(DEFAULT_EXTENSION);

  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);

  const [entries, setEntries] = useState<ProjectEntry[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [explorerOrder, setExplorerOrder] = useState<string[]>([]);
  const [explorerLoading, setExplorerLoading] = useState(false);

  const [editorKind, setEditorKind] = useState<EditorKind>("none");
  const [currentFile, setCurrentFile] = useState("");
  const [graphName, setGraphName] = useState("");

  const [targetExtension, setTargetExtension] =
    useState(DEFAULT_EXTENSION);

  const [sourceFile, setSourceFile] = useState("");
  const [textContents, setTextContents] = useState("");
  const [isDirty, setIsDirty] = useState(false);

  const [notice, setNotice] = useState(
    "Choose a project folder to begin.",
  );

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [entryDialogKind, setEntryDialogKind] = useState<"file" | "folder" | "">("");
  const [newEntryName, setNewEntryName] = useState("");
  const [newEntryParent, setNewEntryParent] = useState("");
  const [moveEntry, setMoveEntry] = useState<ProjectEntry | null>(null);
  const [moveParent, setMoveParent] = useState("");
  const [newGraphName, setNewGraphName] = useState("main");

  const [newGraphExtension, setNewGraphExtension] =
    useState(DEFAULT_EXTENSION);

  const [existingSourceChoice, setExistingSourceChoice] = useState("");
  const [creatingGraph, setCreatingGraph] = useState(false);
  const [activeContextMenu, setActiveContextMenu] = useState("");
  const [settingsNodeId, setSettingsNodeId] = useState("");
  const [nodeValueOverrides, setNodeValueOverrides] = useState<Record<string, string>>({});
  const [definitionTargetNodeId, setDefinitionTargetNodeId] = useState("");
  const [definitionDraft, setDefinitionDraft] = useState<NodeDefinition | null>(null);
  const [compositeCreationDraft, setCompositeCreationDraft] = useState<CompositeCreationDraft | null>(null);
  const [nodeLibraryRefreshVersion, setNodeLibraryRefreshVersion] = useState(0);
  const definitionAddNodeHandler = useRef<((definition: NodeDefinition) => void) | null>(null);
  const registerDefinitionAddNodeHandler = useCallback((handler: ((definition: NodeDefinition) => void) | null) => { definitionAddNodeHandler.current = handler; }, []);
  const mainFlowInstance = useRef<ReactFlowInstance<Node<FunctionNodeData>, Edge> | null>(null);
  const [nodeLibraryExpanded, setNodeLibraryExpanded] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const effectiveSidebarWidth = Math.max(190, Math.min(sidebarWidth, viewportWidth - 390, 520));

  const projectName = folderName(projectFolder);

  const sourceCandidates = useMemo(
    () =>
      entries.filter(
        (entry) =>
          !entry.isDir &&
          entry.extension?.toLowerCase() ===
            normalizeExtension(newGraphExtension)
              .slice(1)
              .toLowerCase() &&
          entry.extension?.toLowerCase() !== "graph",
      ),
    [entries, newGraphExtension],
  );

  useEffect(() => {
    async function loadSettings() {
      try {
        const store = await load("settings.json", {
          autoSave: true,
        });

        const savedProject =
          await store.get<string>("projectFolder");

        const savedLibrary =
          await store.get<string>("nodeLibraryFolder");

        const savedExtension =
          await store.get<string>("preferredExtension");
        const savedSidebarWidth = await store.get<number>("sidebarWidth");

        if (typeof savedSidebarWidth === "number" && Number.isFinite(savedSidebarWidth)) setSidebarWidth(savedSidebarWidth);
        setProjectFolder(savedProject ?? "");
        setNodeLibraryFolder(savedLibrary ?? "");

        setPreferredExtension(
          normalizeExtension(savedExtension ?? DEFAULT_EXTENSION),
        );

        setNewGraphExtension(
          normalizeExtension(savedExtension ?? DEFAULT_EXTENSION),
        );
      } catch (error) {
        console.error("Could not load settings:", error);
        setNotice(
          "Could not load saved settings. Check the console.",
        );
      } finally {
        setSettingsLoading(false);
      }
    }

    void loadSettings();
  }, []);

  useEffect(() => {
    const updateViewport = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  const setSidebarWidthFromPointer = useCallback((clientX: number) => {
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const max = Math.max(190, Math.min(520, bounds.width - 350));
    const next = Math.round(Math.max(190, Math.min(max, clientX - bounds.left)));
    sidebarWidthRef.current = next;
    setSidebarWidth(next);
  }, []);

  async function saveSidebarWidth() {
    await persistSetting("sidebarWidth", sidebarWidthRef.current);
  }

  const refreshExplorer = useCallback(
    async (folder = projectFolder) => {
      if (!folder) {
        setEntries([]);
        return;
      }

      setExplorerLoading(true);

      try {
        const result = await invoke<ProjectEntry[]>(
          "list_project_entries",
          { projectFolder: folder },
        );

        setEntries(result);
        try {
          const savedOrder = await invoke<string>("read_explorer_order", { projectFolder: folder });
          const parsed = JSON.parse(savedOrder);
          setExplorerOrder(Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === "string") : []);
        } catch (error) {
          console.error("Could not read Explorer order:", error);
          setExplorerOrder([]);
        }
      } catch (error) {
        console.error("Could not load project files:", error);
        setNotice(
          `Could not load project files: ${String(error)}`,
        );
      } finally {
        setExplorerLoading(false);
      }
    },
    [projectFolder],
  );

  useEffect(() => {
    if (projectFolder) {
      void refreshExplorer(projectFolder);
    } else {
      setEntries([]);
    }
  }, [projectFolder, refreshExplorer]);

  const persistSetting = async (
    key: string,
    value: string | number,
  ) => {
    try {
      const store = await load("settings.json", {
        autoSave: true,
      });

      await store.set(key, value);
      await store.save();
    } catch (error) {
      console.error(`Could not save ${key}:`, error);
      setNotice("Could not save a setting. Check the console.");
    }
  };

  async function chooseProjectFolder() {
    try {
      const selected = await open({
        title: "Choose Visual Code project folder",
        directory: true,
        multiple: false,
      });

      if (typeof selected !== "string") return;

      if (
        isDirty &&
        !window.confirm(
          "Switch projects? Unsaved changes may be lost.",
        )
      ) {
        return;
      }

      setProjectFolder(selected);
      setCurrentFile("");
      setEditorKind("none");
      setNodes([]);
      setEdges([]);
      setTextContents("");
      setSourceFile("");
      setGraphName("");
      setIsDirty(false);
      setExpandedFolders(new Set());
      setActiveContextMenu("");

      await persistSetting("projectFolder", selected);

      setNotice(`Project selected: ${folderName(selected)}`);
    } catch (error) {
      console.error("Project folder selection failed:", error);
      setNotice("Could not select the project folder.");
    }
  }

  async function chooseNodeLibraryFolder() {
    try {
      const selected = await open({
        title: "Choose node library folder",
        directory: true,
        multiple: false,
      });

      if (typeof selected !== "string") return;

      setNodeLibraryFolder(selected);
      setSettingsNotice("Node library folder selected.");
    } catch (error) {
      console.error("Node folder selection failed:", error);
      setSettingsNotice("Could not select that folder.");
    }
  }

  async function saveGlobalSettings() {
    setSettingsSaving(true);

    try {
      const extension = normalizeExtension(preferredExtension);

      const store = await load("settings.json", {
        autoSave: true,
      });

      await store.set("nodeLibraryFolder", nodeLibraryFolder);
      await store.set("preferredExtension", extension);
      await store.save();

      setPreferredExtension(extension);
      setNewGraphExtension(extension);
      setSettingsNotice("Settings saved.");
    } catch (error) {
      console.error("Could not save settings:", error);
      setSettingsNotice("Could not save settings. Check the console.");
    } finally {
      setSettingsSaving(false);
    }
  }

  const getPort = useCallback(
    (
      node: Node<FunctionNodeData> | undefined,
      handleId: string | null | undefined,
      direction: "input" | "output",
    ): NodePort | undefined => {
      const prefix = direction === "input" ? "in:" : "out:";
      if (!node || !handleId?.startsWith(prefix)) return undefined;

      const portId = handleId.slice(prefix.length);
      const ports = direction === "input" ? node.data.inputs : node.data.outputs;
      return ports?.find((port) => port.id === portId);
    },
    [],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      if (!connection.source || !connection.target || connection.source === connection.target) {
        return false;
      }

      const sourceNode = nodes.find((node) => node.id === connection.source);
      const targetNode = nodes.find((node) => node.id === connection.target);
      const sourcePort = getPort(sourceNode, connection.sourceHandle, "output");
      const targetPort = getPort(targetNode, connection.targetHandle, "input");

      // Ports are single-connection endpoints. Ignore the same edge when
      // validating an existing edge, but never replace another connection.
      const connectionId = "id" in connection ? connection.id : undefined;
      const occupied = edges.some((edge) => edge.id !== connectionId && (
        (edge.source === connection.source && edge.sourceHandle === connection.sourceHandle) ||
        (edge.target === connection.target && edge.targetHandle === connection.targetHandle)
      ));
      if (occupied) return false;

      return Boolean(
        sourcePort &&
          targetPort &&
          arePortTypesCompatible(sourcePort.type, targetPort.type),
      );
    },
    [edges, getPort, nodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!isValidConnection(connection)) return;

      const sourceNode = nodes.find((node) => node.id === connection.source);
      const sourcePort = getPort(sourceNode, connection.sourceHandle, "output");
      const isExecutionConnection = sourcePort?.type === "exec";
      const edgeColor = isExecutionConnection ? "#f4f4f5" : "#60a5fa";

      setEdges((current) => {
        // Recheck against the latest state so rapid or concurrent connection
        // gestures cannot claim the same input or output.
        if (current.some((edge) =>
          (edge.source === connection.source && edge.sourceHandle === connection.sourceHandle) ||
          (edge.target === connection.target && edge.targetHandle === connection.targetHandle)
        )) return current;
        return addEdge(
          {
            ...connection,
            id: crypto.randomUUID(),
            type: "smoothstep",
            animated: isExecutionConnection,
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: edgeColor,
            },
            style: {
              stroke: edgeColor,
              strokeWidth: 2,
            },
          },
          current,
        );
      });

      setIsDirty(true);
    },
    [edges, getPort, isValidConnection, nodes, setEdges],
  );

  const handleNodesChange = useCallback<
    OnNodesChange<Node<FunctionNodeData>>
  >(
    (changes) => {
      onNodesChange(changes);
      if (changes.length) setIsDirty(true);
    },
    [onNodesChange],
  );

  const handleEdgesChange = useCallback<OnEdgesChange<Edge>>(
    (changes) => {
      onEdgesChange(changes);
      if (changes.length) setIsDirty(true);
    },
    [onEdgesChange],
  );

  function createCompositeFromSelection() {
    const selected = nodes.filter((node) => node.selected);
    if (selected.length < 2) return;
    if (!nodeLibraryFolder.trim()) { setNotice("Choose a Node Library folder before creating a reusable Composite Node."); return; }
    const selectedIds = new Set(selected.map((node) => node.id));
    const internalEdges = edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target));
    const incomingEdges = edges.filter((edge) => !selectedIds.has(edge.source) && selectedIds.has(edge.target));
    const outgoingEdges = edges.filter((edge) => selectedIds.has(edge.source) && !selectedIds.has(edge.target));
    const inputs = incomingEdges.map((_edge, index) => ({ id: `input${index + 1}`, label: `Input ${index + 1}`, type: "text" as const }));
    const outputs = outgoingEdges.map((_edge, index) => ({ id: `output${index + 1}`, label: `Output ${index + 1}`, type: "text" as const }));
    const compositeInputMappings = incomingEdges.map((edge, index) => ({ inputId: inputs[index].id, nodeId: edge.target, nodeInputId: (edge.targetHandle ?? "").replace(/^in:/, "") }));
    const compositeOutputMappings = outgoingEdges.map((edge, index) => ({ outputId: outputs[index].id, nodeId: edge.source, nodeOutputId: (edge.sourceHandle ?? "").replace(/^out:/, "") }));
    const center = selected.reduce((point, node) => ({ x: point.x + node.position.x / selected.length, y: point.y + node.position.y / selected.length }), { x: 0, y: 0 });
    const definition: NodeDefinition = {
      id: crypto.randomUUID(), name: "New Composite", description: "Reusable network of Visual Code nodes.", kind: "composite",
      inputs, outputs, template: "", outputTemplates: outputs.map(() => ""), category: "Default", language: normalizeExtension(targetExtension),
      definitionGraph: { nodes: selected.map((node) => ({ ...node, selected: false })), edges: internalEdges },
      compositeInputMappings, compositeOutputMappings,
    };
    setCompositeCreationDraft({ definitionId: definition.id, nodeIds: [...selectedIds], incomingEdges, outgoingEdges, center });
    setDefinitionTargetNodeId("");
    setDefinitionDraft(definition);
    setSettingsNodeId("");
  }

  async function saveGraph() {
    if (
      !projectFolder ||
      editorKind !== "graph" ||
      !currentFile
    ) {
      return;
    }

    const graph: NodGraphFile = {
      format: "visual-code-graph",
      version: 1,
      name: graphName,
      targetExtension,
      sourceFile,
      nodes,
      edges,
    };

    try {
      await invoke("save_project_graph", {
        projectFolder,
        fileName: currentFile,
        contents: JSON.stringify(graph, null, 2),
        overwrite: true,
      });
      if (sourceFile) {
        const generated = generateSource(nodes, edges);
        await invoke("write_project_file", { projectFolder, filePath: sourceFile, contents: generated });
        setTextContents(generated);
      }

      setIsDirty(false);
      setNotice(`Saved ${currentFile}.`);

      await refreshExplorer();
    } catch (error) {
      console.error("Graph save failed:", error);
      setNotice(`Could not save graph: ${String(error)}`);
    }
  }

  async function saveTextFile() {
    if (
      !projectFolder ||
      editorKind !== "text" ||
      !currentFile
    ) {
      return;
    }

    try {
      await invoke("write_project_file", {
        projectFolder,
        filePath: currentFile,
        contents: textContents,
      });

      setIsDirty(false);
      setNotice(`Saved ${currentFile}.`);

      await refreshExplorer();
    } catch (error) {
      console.error("Text file save failed:", error);
      setNotice(`Could not save file: ${String(error)}`);
    }
  }

  async function saveCurrentFile() {
    if (editorKind === "graph") {
      await saveGraph();
    } else if (editorKind === "text") {
      await saveTextFile();
    }
  }

  async function openProjectFile(entry: ProjectEntry) {
    if (entry.isDir) {
      setExpandedFolders((previous) => {
        const next = new Set(previous);

        if (next.has(entry.path)) {
          next.delete(entry.path);
        } else {
          next.add(entry.path);
        }

        return next;
      });

      return;
    }

    if (entry.path === currentFile) {
      setActiveContextMenu("");
      return;
    }

    if (
      isDirty &&
      !window.confirm(
        "Open this file and discard unsaved changes?",
      )
    ) {
      return;
    }

    setActiveContextMenu("");

    try {
      if (entry.extension?.toLowerCase() === "graph") {
        const contents = await invoke<string>(
          "read_project_graph",
          {
            projectFolder,
            fileName: entry.path,
          },
        );

        const parsed: unknown = JSON.parse(contents);

        if (
          typeof parsed !== "object" ||
          parsed === null
        ) {
          throw new Error("This is not a valid graph object.");
        }

        const data = parsed as Record<string, unknown>;

        if (
          data.format !== "visual-code-graph" ||
          data.version !== 1 ||
          typeof data.name !== "string" ||
          typeof data.sourceFile !== "string" ||
          !Array.isArray(data.nodes) ||
          !Array.isArray(data.edges)
        ) {
          throw new Error(
            "Unsupported Visual Code graph file.",
          );
        }

        const sourceExtension = data.sourceFile.match(/\.([^.\/\\]+)$/)?.[1];
        const extension = normalizeExtension(
          sourceExtension ?? (typeof data.targetExtension === "string" ? data.targetExtension : DEFAULT_EXTENSION),
        );

        setGraphName(data.name);
        setTargetExtension(extension);
        setSourceFile(data.sourceFile);
        setNodes(data.nodes as Node<FunctionNodeData>[]);
        setEdges(retainValidSinglePortConnections(data.nodes as Node<FunctionNodeData>[], data.edges as Edge[]));
        setEditorKind("graph");
        setCurrentFile(entry.path);
        setIsDirty(false);
        setNotice(`Opened graph ${entry.path}.`);
      } else {
        const contents = await invoke<string>(
          "read_project_file",
          {
            projectFolder,
            filePath: entry.path,
          },
        );

        setTextContents(contents);
        setEditorKind("text");
        setCurrentFile(entry.path);
        setIsDirty(false);
        setNotice(`Opened ${entry.path}.`);
      }
    } catch (error) {
      console.error("Could not open project file:", error);
      setNotice(
        `Could not open ${entry.path}: ${String(error)}`,
      );
    }
  }

  function startNewGraph() {
    if (!projectFolder) {
      setNotice(
        "Choose a project folder before creating a graph.",
      );
      return;
    }

    if (
      isDirty &&
      !window.confirm(
        "Discard unsaved changes and create a new graph?",
      )
    ) {
      return;
    }

    setNewGraphName("main");
    setNewGraphExtension(
      normalizeExtension(preferredExtension),
    );
    setExistingSourceChoice("");
    setCreateDialogOpen(true);
  }

  async function createGraph() {
    const cleanName = safeGraphFileName(newGraphName);
    const extension = normalizeExtension(newGraphExtension);

    if (!cleanName) {
      setNotice("Enter a valid graph name.");
      return;
    }

    if (extension.toLowerCase() === ".graph") {
      setNotice("The source extension cannot be .graph.");
      return;
    }

    const graphPath = `${cleanName}.graph`;
    const linkedSource =
      existingSourceChoice || `${cleanName}${extension}`;

    if (linkedSource.toLowerCase().endsWith(".graph")) {
      setNotice("A graph cannot be its own source file.");
      return;
    }

    const graphExists = entries.some(
      (entry) =>
        !entry.isDir &&
        entry.path.toLowerCase() === graphPath.toLowerCase(),
    );

    if (graphExists) {
      setNotice(
        `${graphPath} already exists. Choose another graph name.`,
      );
      return;
    }

    const sourceExists = entries.some(
      (entry) =>
        !entry.isDir &&
        entry.path.toLowerCase() === linkedSource.toLowerCase(),
    );

    if (!existingSourceChoice && sourceExists) {
      setNotice(
        `${linkedSource} already exists. Select it as the existing source file or choose another graph name.`,
      );
      return;
    }

    setCreatingGraph(true);

    try {
      if (!existingSourceChoice) {
        await invoke("create_project_file", {
          projectFolder,
          filePath: linkedSource,
          contents: "",
        });
      }

      const graph: NodGraphFile = {
        format: "visual-code-graph",
        version: 1,
        name: cleanName,
        targetExtension: extension,
        sourceFile: linkedSource,
        nodes: [],
        edges: [],
      };

      await invoke("save_project_graph", {
        projectFolder,
        fileName: graphPath,
        contents: JSON.stringify(graph, null, 2),
        overwrite: false,
      });

      setGraphName(cleanName);
      setTargetExtension(extension);
      setSourceFile(linkedSource);
      setCurrentFile(graphPath);
      setNodes([]);
      setEdges([]);
      setEditorKind("graph");
      setIsDirty(false);
      setCreateDialogOpen(false);
      setNotice(
        `Created ${graphPath}, linked to ${linkedSource}.`,
      );

      await persistSetting("preferredExtension", extension);
      setPreferredExtension(extension);

      await refreshExplorer();
    } catch (error) {
      console.error("Graph creation failed:", error);
      setNotice(`Could not create graph: ${String(error)}`);
      await refreshExplorer();
    } finally {
      setCreatingGraph(false);
    }
  }

  async function deleteGraph(entry: ProjectEntry) {
    if (
      entry.isDir ||
      entry.extension?.toLowerCase() !== "graph"
    ) {
      return;
    }

    const linkedSource =
      entry.path === currentFile && editorKind === "graph"
        ? sourceFile
        : "";

    const message = linkedSource
      ? `Delete ${entry.path}?\n\nIts associated source file (${linkedSource}) will NOT be deleted.`
      : `Delete ${entry.path}?\n\nThis permanently deletes the graph file only.`;

    if (!window.confirm(message)) return;

    try {
      await invoke("delete_project_graph", {
        projectFolder,
        filePath: entry.path,
      });

      if (
        currentFile === entry.path &&
        editorKind === "graph"
      ) {
        setCurrentFile("");
        setEditorKind("none");
        setGraphName("");
        setSourceFile("");
        setNodes([]);
        setEdges([]);
        setIsDirty(false);
      }

      setActiveContextMenu("");
      setNotice(`Deleted ${entry.path}.`);

      await refreshExplorer();
    } catch (error) {
      console.error("Graph deletion failed:", error);
      setNotice(`Could not delete graph: ${String(error)}`);
    }
  }

  async function deleteProjectEntry(entry: ProjectEntry) {
    if (entry.extension?.toLowerCase() === "graph" && !entry.isDir) {
      await deleteGraph(entry);
      return;
    }

    const normalizedPath = entry.path.replace(/\\/g, "/").replace(/\/$/, "");
    const activePath = currentFile.replace(/\\/g, "/");
    const removesActiveFile = Boolean(
      activePath &&
      (activePath === normalizedPath ||
        (entry.isDir && activePath.startsWith(`${normalizedPath}/`))),
    );
    const message = entry.isDir
      ? `Delete folder ${entry.path} and everything inside it? This cannot be undone.`
      : `Delete ${entry.path}? This cannot be undone.`;

    if (!window.confirm(message)) return;
    if (removesActiveFile && isDirty &&
      !window.confirm("The selected item contains unsaved changes. Delete it and discard those changes?")) {
      return;
    }

    try {
      await invoke("delete_project_entry", {
        projectFolder,
        filePath: entry.path,
      });

      if (removesActiveFile) {
        setCurrentFile("");
        setEditorKind("none");
        setGraphName("");
        setSourceFile("");
        setNodes([]);
        setEdges([]);
        setIsDirty(false);
      }

      setActiveContextMenu("");
      setNotice(`Deleted ${entry.path}.`);
      await refreshExplorer();
    } catch (error) {
      console.error("Project entry deletion failed:", error);
      setNotice(`Could not delete ${entry.path}: ${String(error)}`);
    }
  }

  function beginCreateEntry(kind: "file" | "folder") {
    setCreateMenuOpen(false);
    setEntryDialogKind(kind);
    setNewEntryName("");
    setNewEntryParent("");
  }

  async function createProjectEntry() {
    const name = newEntryName.trim();
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
      setNotice("Enter a name without folder separators.");
      return;
    }
    if (entryDialogKind === "file" && (!name.includes(".") || name.endsWith("."))) {
      setNotice("Enter a file name with its extension, such as script.py.");
      return;
    }
    if (entryDialogKind === "file" && /\.(graph|nod)$/i.test(name)) {
      setNotice(name.toLowerCase().endsWith(".graph")
        ? "Create graph workspaces with New graph so their source file can be linked."
        : "Node definitions are created from the Node Library.");
      return;
    }

    const path = newEntryParent ? `${newEntryParent}/${name}` : name;
    try {
      if (entryDialogKind === "folder") {
        await invoke("create_project_directory", { projectFolder, directoryPath: path });
      } else if (entryDialogKind === "file") {
        await invoke("create_project_file", { projectFolder, filePath: path, contents: "" });
      }
      if (newEntryParent) setExpandedFolders((current) => new Set(current).add(newEntryParent));
      setEntryDialogKind("");
      setNotice(`Created ${path}.`);
      await refreshExplorer();
    } catch (error) {
      console.error("Project entry creation failed:", error);
      setNotice(`Could not create ${path}: ${String(error)}`);
    }
  }

  async function persistExplorerOrder(nextOrder: string[]) {
    setExplorerOrder(nextOrder);
    try {
      await invoke("save_explorer_order", {
        projectFolder,
        orderJson: JSON.stringify(nextOrder),
      });
    } catch (error) {
      console.error("Could not save Explorer order:", error);
      setNotice(`Could not save Explorer order: ${String(error)}`);
    }
  }

  function orderedSiblings(entry: ProjectEntry) {
    const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
    const ranks = new Map(explorerOrder.map((path, index) => [path, index]));
    return entries
      .filter((candidate) => (candidate.path.includes("/") ? candidate.path.slice(0, candidate.path.lastIndexOf("/")) : "") === parent)
      .sort((a, b) => {
        const rankA = ranks.get(a.path);
        const rankB = ranks.get(b.path);
        return rankA !== undefined && rankB !== undefined && rankA !== rankB
          ? rankA - rankB
          : a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
  }

  async function moveEntryBy(entry: ProjectEntry, direction: -1 | 1) {
    const siblings = orderedSiblings(entry);
    const index = siblings.findIndex((candidate) => candidate.path === entry.path);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= siblings.length) return;
    [siblings[index], siblings[nextIndex]] = [siblings[nextIndex], siblings[index]];
    const siblingPaths = new Set(siblings.map((sibling) => sibling.path));
    const nextOrder = explorerOrder.filter((path) => !siblingPaths.has(path));
    nextOrder.push(...siblings.map((sibling) => sibling.path));
    await persistExplorerOrder(nextOrder);
    setActiveContextMenu("");
  }

  function beginMoveEntry(entry: ProjectEntry) {
    setMoveEntry(entry);
    setMoveParent(entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "");
    setActiveContextMenu("");
  }

  async function moveEntryToSelectedParent() {
    if (!moveEntry) return;
    const entry = moveEntry;
    const destination = moveParent ? `${moveParent}/${entry.name}` : entry.name;
    const oldPath = entry.path;
    if (destination === oldPath) {
      setMoveEntry(null);
      return;
    }
    try {
      await invoke("move_project_entry", {
        projectFolder,
        sourcePath: oldPath,
        destinationPath: destination,
      });
      const remap = (path: string) => path === oldPath || (entry.isDir && path.startsWith(`${oldPath}/`))
        ? `${destination}${path.slice(oldPath.length)}`
        : path;
      if (currentFile) setCurrentFile(remap(currentFile));
      if (sourceFile) setSourceFile(remap(sourceFile));
      setExpandedFolders((current) => new Set([...current].map(remap)));
      const nextOrder = [...new Set(explorerOrder.map(remap))];
      if (!nextOrder.includes(destination)) nextOrder.push(destination);
      setMoveEntry(null);
      setNotice(`Moved ${oldPath} to ${destination}.`);
      await persistExplorerOrder(nextOrder);
      await refreshExplorer();
    } catch (error) {
      console.error("Project entry move failed:", error);
      setNotice(`Could not move ${oldPath}: ${String(error)}`);
    }
  }

  function addDefinitionToGraph(definition: NodeDefinition) {
    if (editorKind !== "graph") {
      setNotice(
        "Open or create a .graph workspace before adding a node.",
      );
      return;
    }

    const nextIndex = nodes.length;

    const node: Node<FunctionNodeData> = {
      id: crypto.randomUUID(),
      type: "function",
      position: {
        x: 100 + (nextIndex % 3) * 260,
        y: 100 + Math.floor(nextIndex / 3) * 160,
      },
      data: createNodeData(definition),
    };

    setNodes((current) => [...current, node]);
    setIsDirty(true);
    setNotice(
      `Added "${definition.name}" to the current graph.`,
    );
  }

  function updateNodeValue(nodeId: string, value: string) {
    setNodeValueOverrides((current) => ({ ...current, [nodeId]: value }));
    setNodes((current) => current.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, value } }
      : node));
    setIsDirty(true);
  }

  function handleMainGraphDrop(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    const raw = event.dataTransfer.getData("application/x-visual-code-node") || event.dataTransfer.getData("text/plain");
    if (!raw) return;
    try {
      const definition = JSON.parse(raw) as NodeDefinition;
      const base = mainFlowInstance.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 180, y: 120 };
      let position = { ...base };
      let attempt = 0;
      while (nodes.some((existing) => Math.abs(existing.position.x - position.x) < 210 && Math.abs(existing.position.y - position.y) < 90)) {
        attempt += 1;
        position = { x: base.x + attempt * 30, y: base.y + attempt * 24 };
      }
      const node: Node<FunctionNodeData> = {
        id: crypto.randomUUID(),
        type: "function",
        position,
        data: createNodeData(definition),
      };
      setNodes((current) => [...current, node]);
      setIsDirty(true);
    } catch (error) {
      console.error("Could not add the dropped node to the graph:", error);
    }
  }

  function beginFunctionDefinition(nodeId: string) {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node || node.data.kind !== "function") return;
    const data = node.data;
    setDefinitionTargetNodeId(data.definitionId && data.definitionId !== "builtin-function" ? "" : nodeId);
    setDefinitionDraft({
      id: data.definitionId ?? "builtin-function",
      name: data.label,
      description: data.description,
      kind: "function",
      inputs: data.inputs.map((port) => ({ ...port })),
      outputs: data.outputs.map((port) => ({ ...port })),
      template: data.template,
      outputTemplates: [...data.outputTemplates],
      valueParameters: data.valueParameters?.map((parameter) => ({ ...parameter })) ?? [],
      category: data.category ?? "Default",
      language: normalizeExtension(targetExtension),
      definitionGraph: data.definitionGraph,
      editableParameters: data.editableParameters,
    });
    setSettingsNodeId("");
  }

  function handleFunctionDefinitionSaved(definition: NodeDefinition) {
    const targetId = definitionTargetNodeId;
    const compositeCreation = compositeCreationDraft;
    if (definition.kind === "composite" && compositeCreation?.definitionId === definition.id) {
      const selectedIds = new Set(compositeCreation.nodeIds);
      const outerId = crypto.randomUUID();
      const outer: Node<FunctionNodeData> = { id: outerId, type: "function", position: compositeCreation.center, data: createNodeData(definition) };
      const incoming = compositeCreation.incomingEdges.flatMap((edge, index) => {
        const input = definition.inputs[index];
        return input ? [{ ...edge, target: outerId, targetHandle: `in:${input.id}` }] : [];
      });
      const outgoing = compositeCreation.outgoingEdges.flatMap((edge, index) => {
        const output = definition.outputs[index];
        return output ? [{ ...edge, source: outerId, sourceHandle: `out:${output.id}` }] : [];
      });
      const nextNodes = [...nodes.filter((node) => !selectedIds.has(node.id)), outer];
      const nextEdges = [...edges.filter((edge) => !selectedIds.has(edge.source) && !selectedIds.has(edge.target)), ...incoming, ...outgoing];
      setNodes(nextNodes);
      setEdges(retainValidSinglePortConnections(nextNodes, nextEdges));
      setCompositeCreationDraft(null);
      setIsDirty(true);
      setDefinitionDraft(null);
      setNodeLibraryRefreshVersion((version) => version + 1);
      setNotice(`Created Composite Node “${definition.name}”.`);
      return;
    }
    const definitionEditability = { ...DEFAULT_NODE_PARAMETER_EDITABILITY, ...definition.editableParameters };
    const nextNodes = nodes.map((node) => (targetId ? node.id === targetId : node.data.definitionId === definition.id)
      ? { ...node, data: {
          ...node.data,
          label: targetId || !definitionEditability.name ? definition.name : node.data.label,
          description: !definitionEditability.description ? definition.description : node.data.description,
          kind: definition.kind,
          inputs: definitionEditability.inputCount ? [...definition.inputs, ...node.data.inputs.filter((port) => !definition.inputs.some((next) => next.id === port.id))] : definition.inputs,
          outputs: definitionEditability.outputCount ? [...definition.outputs, ...node.data.outputs.filter((port) => !definition.outputs.some((next) => next.id === port.id))] : definition.outputs,
          template: definitionEditability.logic ? node.data.template : definition.template,
          outputTemplates: definitionEditability.outputMappings ? node.data.outputTemplates : definition.outputTemplates,
          definitionId: definition.id,
          category: definition.category ?? "Default",
          language: definition.language,
          definitionGraph: definition.definitionGraph,
          editableParameters: definition.editableParameters,
          valueParameters: (definition.valueParameters ?? []).map((parameter) => ({
            ...parameter,
            value: node.data.valueParameters?.find((current) => current.inputId === parameter.inputId)?.value ?? parameter.value,
          })),
          compositeInputMappings: definition.compositeInputMappings ?? [],
          compositeOutputMappings: definition.compositeOutputMappings ?? [],
          compositeParameters: (definition.compositeParameters ?? []).map((parameter) => ({
            ...parameter,
            value: node.data.compositeParameters?.find((current) => current.id === parameter.id)?.value ?? parameter.value,
          })),
        } }
      : node);
    setNodes(nextNodes);
    setEdges((current) => retainValidSinglePortConnections(nextNodes, current));
    setIsDirty(true);
    setDefinitionDraft(null);
    setDefinitionTargetNodeId("");
    setNodeLibraryRefreshVersion((version) => version + 1);
    setNotice(`Saved reusable ${definition.kind === "composite" ? "Composite" : "Function"} Node “${definition.name}”.`);
  }

  const visibleEntries = useMemo(
    () => {
      const ranks = new Map(explorerOrder.map((path, index) => [path, index]));
      const comparePath = (pathA: string, pathB: string) => {
        const partsA = pathA.split("/");
        const partsB = pathB.split("/");
        const length = Math.min(partsA.length, partsB.length);
        for (let index = 0; index < length; index++) {
          if (partsA[index] === partsB[index]) continue;
          const pathOfA = partsA.slice(0, index + 1).join("/");
          const pathOfB = partsB.slice(0, index + 1).join("/");
          const rankA = ranks.get(pathOfA);
          const rankB = ranks.get(pathOfB);
          if (rankA !== undefined && rankB !== undefined && rankA !== rankB) return rankA - rankB;
          return partsA[index].localeCompare(partsB[index], undefined, { sensitivity: "base" });
        }
        return partsA.length - partsB.length;
      };
      return [...entries].sort((a, b) => comparePath(a.path, b.path)).filter((entry) => {
        const parts = entry.path.split("/");

        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join("/");
          if (!expandedFolders.has(parent)) return false;
        }

        return true;
      });
    },
    [entries, expandedFolders, explorerOrder],
  );

  return (
    <main
      className="container"
      onClick={() => setActiveContextMenu("")}
    >
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">V</div>

          <div>
            <h1>Visual Code</h1>
            <p>Visual Development Environment</p>
          </div>
        </div>

        <div className="topbar-actions">
          {editorKind !== "none" && !definitionDraft && (
            <button
              className="save-button"
              onClick={() => void saveCurrentFile()}
              disabled={!isDirty}
            >
              ↓ Save
            </button>
          )}
          <button
            className="settings-button"
            onClick={(event) => {
              event.stopPropagation();
              setSettingsOpen(true);
            }}
          >
            ⚙ Settings
          </button>

          <div className="workspace-status">
            <span
              className={`status-dot${isDirty ? " unsaved" : ""}`}
            />
            {isDirty
              ? "Unsaved changes"
              : "All changes saved"}
          </div>
        </div>
      </header>

      <div
        className={`workspace${resizingSidebar ? " is-resizing-sidebar" : ""}`}
        ref={workspaceRef}
        style={{ gridTemplateColumns: `${effectiveSidebarWidth}px 8px minmax(0, 1fr)` }}
      >
        <aside className="sidebar">
          <div className="project-toolbar">
            <div
              className="project-heading"
              title={projectFolder || "No project selected"}
            >
              <span className="section-title">
                {projectName || "NO PROJECT"}
              </span>

              <button
                className="folder-button"
                title="Choose project folder"
                aria-label="Choose project folder"
                onClick={() => void chooseProjectFolder()}
              >
                ▣
              </button>
            </div>

            <div className="project-actions">
              <button
                onClick={() => setCreateMenuOpen((open) => !open)}
                disabled={!projectFolder}
              >
                + New File/Folder
              </button>
              {createMenuOpen && (
                <div className="explorer-context-menu create-entry-menu" onClick={(event) => event.stopPropagation()}>
                  <button onClick={() => beginCreateEntry("file")}>New file…</button>
                  <button onClick={() => beginCreateEntry("folder")}>New folder…</button>
                  <button onClick={() => { setCreateMenuOpen(false); startNewGraph(); }}>New graph…</button>
                </div>
              )}

              <button
                onClick={() => void refreshExplorer()}
                disabled={!projectFolder || explorerLoading}
                title="Refresh project files"
              >
                ↻ Refresh
              </button>
            </div>
          </div>

          <div className="explorer-heading">
            <span className="section-title">EXPLORER</span>
            {explorerLoading && (
              <span className="explorer-loading">Loading…</span>
            )}
          </div>

          <div className="explorer-tree">
            {!projectFolder ? (
              <p className="empty-library">
                Choose a project folder to see its files.
              </p>
            ) : visibleEntries.length === 0 && !explorerLoading ? (
              <p className="empty-library">
                This project folder is empty.
              </p>
            ) : (
              visibleEntries.map((entry) => {
                const depth = entry.path.split("/").length - 1;
                const isExpanded = expandedFolders.has(entry.path);
                const isCurrent = currentFile === entry.path;
                const siblings = orderedSiblings(entry);
                const siblingIndex = siblings.findIndex((sibling) => sibling.path === entry.path);
                const isGraph =
                  entry.extension?.toLowerCase() === "graph";

                return (
                  <div
                    className={`explorer-row${isCurrent ? " explorer-row-active" : ""}`}
                    key={entry.path}
                    style={{
                      paddingLeft: `${10 + depth * 15}px`,
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setActiveContextMenu(entry.path);
                    }}
                  >
                    <button
                      className="explorer-file-button"
                      title={entry.path}
                      onClick={(event) => {
                        event.stopPropagation();
                        void openProjectFile(entry);
                      }}
                    >
                      <span className="explorer-file-icon">
                        {entry.isDir
                          ? isExpanded
                            ? "▾"
                            : "▸"
                          : isGraph
                            ? "◇"
                            : entry.extension === "css"
                              ? "#"
                              : entry.extension === "html"
                                ? "〈〉"
                                : entry.extension === "js" ||
                                    entry.extension === "ts"
                                  ? "JS"
                                  : "·"}
                      </span>

                      <span className="explorer-file-name">
                        {entry.name}
                      </span>
                    </button>

                    <button
                      className="explorer-more-button"
                      title={`Actions for ${entry.name}`}
                      aria-label={`Actions for ${entry.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setActiveContextMenu((current) => current === entry.path ? "" : entry.path);
                      }}
                    >
                      ⋯
                    </button>

                    {activeContextMenu === entry.path && (
                      <div
                        className="explorer-context-menu"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button disabled={siblingIndex <= 0} onClick={() => void moveEntryBy(entry, -1)}>
                          Move up
                        </button>
                        <button disabled={siblingIndex < 0 || siblingIndex >= siblings.length - 1} onClick={() => void moveEntryBy(entry, 1)}>
                          Move down
                        </button>
                        <button onClick={() => beginMoveEntry(entry)}>
                          Move to folder…
                        </button>
                        <div className="explorer-menu-divider" />
                        <button className="explorer-menu-danger" onClick={() => void deleteProjectEntry(entry)}>
                          {entry.isDir ? "Delete folder…" : isGraph ? "Delete graph…" : "Delete file…"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Node Library stays directly below Explorer. */}
          <div className={`sidebar-section node-library-section${nodeLibraryExpanded ? " library-expanded" : " library-collapsed"}`}>
            <NodeLibrary
              key={nodeLibraryPath(nodeLibraryFolder, targetExtension)}
              libraryFolder={nodeLibraryPath(nodeLibraryFolder, targetExtension)}
              targetExtension={targetExtension}
              onAddNode={definitionDraft
                ? (definition) => { if (definitionAddNodeHandler.current) definitionAddNodeHandler.current(definition); }
                : addDefinitionToGraph}
              onEditDefinition={(definition) => { setDefinitionTargetNodeId(""); setDefinitionDraft(definition); setSettingsNodeId(""); }}
              expanded={nodeLibraryExpanded}
              onExpandedChange={setNodeLibraryExpanded}
              refreshVersion={nodeLibraryRefreshVersion}
            />
          </div>

          <div className="sidebar-footer">
            {projectFolder
              ? "Project folder selected"
              : "No project selected"}
          </div>
        </aside>

        <div
          className="workspace-splitter"
          role="separator"
          aria-label="Resize Explorer and editor panels"
          aria-orientation="vertical"
          aria-valuemin={190}
          aria-valuemax={Math.max(190, Math.min(520, viewportWidth - 390))}
          aria-valuenow={effectiveSidebarWidth}
          tabIndex={0}
          onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setResizingSidebar(true); setSidebarWidthFromPointer(event.clientX); }}
          onPointerMove={(event) => { if (resizingSidebar) setSidebarWidthFromPointer(event.clientX); }}
          onPointerUp={() => { if (resizingSidebar) { setResizingSidebar(false); void saveSidebarWidth(); } }}
          onLostPointerCapture={() => { if (resizingSidebar) { setResizingSidebar(false); void saveSidebarWidth(); } }}
          onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const amount = event.shiftKey ? 32 : 12; const next = sidebarWidth + (event.key === "ArrowRight" ? amount : -amount); const max = Math.max(190, Math.min(520, viewportWidth - 390)); const bounded = Math.max(190, Math.min(max, next)); sidebarWidthRef.current = bounded; setSidebarWidth(bounded); void persistSetting("sidebarWidth", bounded); } }}
        />

        <section className="editor">
          <div className="editor-toolbar">
            <div className="tab active-tab">
              <span className="tab-icon">
                {editorKind === "graph"
                  ? "◇"
                  : editorKind === "text"
                    ? "</>"
                    : "◇"}
              </span>

              {currentFile || "No file open"}
            </div>

            <div className="toolbar-spacer" />

          </div>

          {editorKind === "graph" ? (
            definitionDraft ? (
              <div className="definition-editor-host">
                {definitionDraft.kind === "composite" ? <CompositeDefinitionEditor
                  initialDefinition={definitionDraft}
                  targetExtension={normalizeExtension(targetExtension)}
                  libraryFolder={nodeLibraryPath(nodeLibraryFolder, targetExtension)}
                  isNew={compositeCreationDraft?.definitionId === definitionDraft.id}
                  minimumInputs={compositeCreationDraft?.definitionId === definitionDraft.id ? compositeCreationDraft.incomingEdges.length : 0}
                  minimumOutputs={compositeCreationDraft?.definitionId === definitionDraft.id ? compositeCreationDraft.outgoingEdges.length : 0}
                  onCancel={() => { setDefinitionDraft(null); setDefinitionTargetNodeId(""); setCompositeCreationDraft(null); }}
                  onSaved={handleFunctionDefinitionSaved}
                  onAddNodeHandler={registerDefinitionAddNodeHandler}
                /> : <FunctionDefinitionEditor
                  initialDefinition={definitionDraft}
                  targetExtension={normalizeExtension(targetExtension)}
                  libraryFolder={nodeLibraryPath(nodeLibraryFolder, targetExtension)}
                  onCancel={() => { setDefinitionDraft(null); setDefinitionTargetNodeId(""); setCompositeCreationDraft(null); }}
                  onSaved={handleFunctionDefinitionSaved}
                  onAddNodeHandler={registerDefinitionAddNodeHandler}
                />}
              </div>
            ) : (
            <>
              <div className="graph-info-bar">
                <div>
                  <span className="graph-info-label">
                    SOURCE FILE
                  </span>
                  <strong>
                    {sourceFile || "No associated source file"}
                  </strong>
                </div>

                <div>
                  <span className="graph-info-label">
                    TARGET EXTENSION
                  </span>
                  <strong>
                    {normalizeExtension(targetExtension)}
                  </strong>
                </div>
                {nodes.filter((node) => node.selected).length > 1 && <button className="create-composite-button" onClick={() => void createCompositeFromSelection()}>
                  Create Composite ({nodes.filter((node) => node.selected).length})
                </button>}
              </div>

              <div className="graph-area">
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={handleNodesChange}
                  onEdgesChange={handleEdgesChange}
                  onConnect={onConnect}
                  onInit={(instance) => { mainFlowInstance.current = instance; }}
                  onDrop={handleMainGraphDrop}
                  onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
                  onNodeDoubleClick={(_event, node) => setSettingsNodeId(node.id)}
                  onNodeContextMenu={(event, node) => { event.preventDefault(); setSettingsNodeId(node.id); }}
                  onPaneContextMenu={(event) => { event.preventDefault(); if (nodes.filter((node) => node.selected).length > 1) void createCompositeFromSelection(); }}
                  isValidConnection={isValidConnection}
                  selectionOnDrag
                  selectionMode={SelectionMode.Partial}
                  multiSelectionKeyCode="Shift"
                  fitView
                  colorMode="dark"
                  deleteKeyCode={["Backspace", "Delete"]}
                  defaultEdgeOptions={{
                    markerEnd: {
                      type: MarkerType.ArrowClosed,
                    },
                  }}
                >
                  <Background
                    color="#303c50"
                    gap={22}
                    size={1}
                  />

                  <Controls />

                  <MiniMap
                    nodeColor="#162238"
                    maskColor="rgba(9, 11, 16, 0.75)"
                  />
                </ReactFlow>
                {settingsNodeId && (() => {
                  const selectedNode = nodes.find((node) => node.id === settingsNodeId);
                  if (!selectedNode) return null;
                  const selectedId = selectedNode.id;
                  const data = selectedNode.data;
                  const lockedDefinition = data.kind === "function" && Boolean(data.definitionId && data.definitionId !== "builtin-function");
                  const canDefine = data.kind === "function" && (!data.definitionId || data.definitionId === "builtin-function");
                  const editability = data.editableParameters ?? DEFAULT_NODE_PARAMETER_EDITABILITY;
                  const minimumInputs = lockedDefinition ? Math.max(0, editability.minInputCount ?? data.inputs.length) : 0;
                  const minimumOutputs = lockedDefinition ? Math.max(0, editability.minOutputCount ?? data.outputs.length) : 0;
                  const update = (patch: Partial<FunctionNodeData>) => {
                    const independent = new Set(["label", "value", "inputs", "outputs", "template", "outputTemplates", "valueParameters", "compositeParameters"]);
                    const patchKeys = Object.keys(patch);
                    const shareAcrossSelection = patchKeys.every((key) => !independent.has(key));
                    const selectedIds = shareAcrossSelection
                      ? new Set(nodes.filter((node) => node.selected || node.id === selectedId).map((node) => node.id))
                      : new Set([selectedId]);
                    setNodes((current) => current.map((node) => selectedIds.has(node.id)
                      ? { ...node, data: { ...node.data, ...patch } }
                      : node));
                    setIsDirty(true);
                  };
                  const resizePorts = (direction: "inputs" | "outputs", count: number) => {
                    const ports = data[direction] ?? [];
                    const minimum = direction === "inputs" ? minimumInputs : minimumOutputs;
                    const safeCount = Math.max(minimum, Math.min(16, Math.floor(Number(count) || 0)));
                    const prefix = direction === "inputs" ? "input" : "output";
                    const label = direction === "inputs" ? "Input" : "Output";
                    const next = Array.from({ length: safeCount }, (_, index) => ports[index] ?? {
                      id: prefix + (index + 1), label: label + " " + (index + 1), type: "text" as const,
                    });
                    const patch: Partial<FunctionNodeData> = { [direction]: next };
                    if (direction === "inputs") {
                      const valid = new Set(next.map((port) => port.id));
                      patch.outputTemplates = (data.outputTemplates ?? []).map((mapping) =>
                        mapping === "Logic" || valid.has(mapping) ? mapping : "",
                      );
                    } else {
                      patch.outputTemplates = next.map((_port, index) => data.outputTemplates?.[index] ?? "");
                    }
                    update(patch);
                    const handlePrefix = direction === "inputs" ? "in:" : "out:";
                    const keep = new Set(next.map((port) => handlePrefix + port.id));
                    setEdges((current) => current.filter((edge) => direction === "inputs"
                      ? edge.target !== selectedId || keep.has(edge.targetHandle ?? "")
                      : edge.source !== selectedId || keep.has(edge.sourceHandle ?? "")));
                  };
                  const canEditInputs = data.kind === "function" && (!lockedDefinition || editability.inputCount);
                  const canEditOutputs = data.kind === "function" && (!lockedDefinition || editability.outputCount);
                  return <div key={selectedNode.id} className="node-instance-settings">
                    <header>
                      <strong>Node settings</strong>
                      {canDefine && <button className="define-node-button" onClick={() => beginFunctionDefinition(selectedId)}>{lockedDefinition ? "Edit definition" : "Define"}</button>}
                      <button onClick={() => setSettingsNodeId("")}>×</button>
                    </header>
                    {(!lockedDefinition || editability.name) && <label>Name<input value={data.label} onChange={(event) => update({ label: event.target.value })} /></label>}
                    {lockedDefinition && editability.description && <label>Description<input value={data.description} onChange={(event) => update({ description: event.target.value })} /></label>}
                    {data.kind === "value" && <label>Value<input value={nodeValueOverrides[selectedId] ?? data.value ?? ""} onChange={(event) => updateNodeValue(selectedId, event.target.value)} /></label>}
                    {data.kind === "function" && (data.valueParameters ?? []).filter((parameter) =>
                      parameter.editable && !edges.some((edge) => edge.target === selectedId && edge.targetHandle === `in:${parameter.inputId}`),
                    ).map((parameter) => <label key={parameter.inputId}>{parameter.name}
                      <input value={parameter.value} onChange={(event) => {
                        const value = event.target.value;
                        setNodes((current) => current.map((node) => node.id === selectedId
                          ? { ...node, data: { ...node.data, valueParameters: (node.data.valueParameters ?? []).map((item) => item.inputId === parameter.inputId ? { ...item, value } : item) } }
                          : node));
                        setIsDirty(true);
                      }} />
                    </label>)}
                    {data.kind === "composite" && (data.compositeParameters ?? []).filter((parameter) => parameter.editable && !edges.some((edge) => {
                      const outerInput = edge.target === selectedId ? edge.targetHandle?.replace(/^in:/, "") : "";
                      return data.compositeInputMappings?.some((mapping) => mapping.inputId === outerInput && mapping.nodeId === parameter.targetNodeId && mapping.nodeInputId === parameter.inputId) ?? false;
                    })).map((parameter) => <label key={parameter.id}>{parameter.name}<input value={parameter.value} onChange={(event) => {
                      const value = event.target.value;
                      setNodes((current) => current.map((node) => node.id === selectedId
                        ? { ...node, data: { ...node.data, compositeParameters: (node.data.compositeParameters ?? []).map((item) => item.id === parameter.id ? { ...item, value } : item) } }
                        : node));
                      setIsDirty(true);
                    }} /></label>)}
                    <label>Color<input type="color" value={data.color ?? "#24344c"} onChange={(event) => update({ color: event.target.value })} /></label>
                    {canEditInputs && <label>Inputs<input type="number" min={minimumInputs} max="16" value={data.inputs.length} onChange={(event) => resizePorts("inputs", Number(event.target.value))} /></label>}
                    {canEditOutputs && <label>Outputs<input type="number" min={minimumOutputs} max="16" value={data.outputs.length} onChange={(event) => resizePorts("outputs", Number(event.target.value))} /></label>}
                    {lockedDefinition && editability.logic && <label>Logic<textarea value={data.template} onChange={(event) => update({ template: event.target.value })} /></label>}
                    {lockedDefinition && editability.outputMappings && data.outputs.map((output, index) => (
                      <label key={output.id}>Output {index + 1}
                        <select value={data.outputTemplates?.[index] ?? ""} onChange={(event) => {
                          const mappings = Array.from({ length: data.outputs.length }, (_item, mappingIndex) => data.outputTemplates?.[mappingIndex] ?? "");
                          mappings[index] = event.target.value;
                          update({ outputTemplates: mappings });
                        }}>
                          <option value="">No mapping</option>
                          <option value="Logic">Logic</option>
                          {data.inputs.map((input) => <option key={input.id} value={input.id}>{input.id}</option>)}
                        </select>
                      </label>
                    ))}
                  </div>;
                })()}
              </div>
            </>
            )
          ) : editorKind === "text" ? (
            <div className="text-editor-panel">
              <div className="text-editor-notice">
                Plain-text editor · {currentFile}
              </div>

              <textarea
                className="source-textarea"
                value={textContents}
                spellCheck={false}
                onChange={(event) => {
                  setTextContents(event.target.value);
                  setIsDirty(true);
                }}
                aria-label={`Contents of ${currentFile}`}
              />
            </div>
          ) : (
            <div className="welcome-panel">
              <div className="welcome-symbol">V</div>
              <h2>Visual Code</h2>

              <p>
                Select a file from the Explorer, or create a new
                visual graph.
              </p>

              <button
                className="save-button"
                onClick={startNewGraph}
                disabled={!projectFolder}
              >
                + Create a graph
              </button>
            </div>
          )}

          <footer className="statusbar">
            <span>{notice}</span>

            <span>
              {editorKind === "graph"
                ? normalizeExtension(targetExtension)
                : editorKind === "text"
                  ? "TEXT"
                  : ""}
            </span>
          </footer>
        </section>
      </div>

      {createDialogOpen && (
        <div
          className="settings-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setCreateDialogOpen(false);
            }
          }}
        >
          <section
            className="settings-dialog create-graph-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-graph-title"
          >
            <div className="settings-dialog-header">
              <div>
                <h2 id="create-graph-title">
                  Create a visual graph
                </h2>
                <p>
                  Create the graph and establish its source-file
                  association.
                </p>
              </div>

              <button
                className="close-button"
                aria-label="Close"
                onClick={() => setCreateDialogOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="folder-setting">
              <label htmlFor="new-graph-name">
                Graph name
              </label>

              <input
                id="new-graph-name"
                value={newGraphName}
                onChange={(event) =>
                  setNewGraphName(event.target.value)
                }
                placeholder="main"
              />

              <p>
                The graph will be saved as{" "}
                {safeGraphFileName(newGraphName) || "name"}.graph
              </p>
            </div>

            <div className="folder-setting">
              <label htmlFor="new-graph-extension">
                Source-file extension
              </label>

              <div className="extension-input settings-extension">
                <span>.</span>

                <input
                  id="new-graph-extension"
                  value={newGraphExtension.replace(/^\./, "")}
                  onChange={(event) =>
                    setNewGraphExtension(
                      event.target.value.replace(/^\./, ""),
                    )
                  }
                  placeholder="js"
                />
              </div>
            </div>

            <div className="folder-setting">
              <label htmlFor="existing-source">
                Associate an existing source file (optional)
              </label>

              <select
                id="existing-source"
                value={existingSourceChoice}
                onChange={(event) =>
                  setExistingSourceChoice(event.target.value)
                }
              >
                <option value="">
                  Create a new matching source file
                </option>

                {sourceCandidates.map((entry) => (
                  <option
                    value={entry.path}
                    key={entry.path}
                  >
                    {entry.path}
                  </option>
                ))}
              </select>

              <p>
                If you select an existing file, its contents are
                preserved. Otherwise, a new empty source file is
                created.
              </p>
            </div>

            <div className="settings-dialog-footer">
              <button
                className="cancel-button"
                onClick={() => setCreateDialogOpen(false)}
                disabled={creatingGraph}
              >
                Cancel
              </button>

              <button
                className="save-button"
                onClick={() => void createGraph()}
                disabled={creatingGraph}
              >
                {creatingGraph ? "Creating…" : "Create graph"}
              </button>
            </div>
          </section>
        </div>
      )}

      {entryDialogKind && (
        <div className="settings-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setEntryDialogKind(""); }}>
          <section className="settings-dialog create-graph-dialog" role="dialog" aria-modal="true" aria-labelledby="create-entry-title">
            <div className="settings-dialog-header">
              <div>
                <h2 id="create-entry-title">Create {entryDialogKind === "file" ? "file" : "folder"}</h2>
                <p>{entryDialogKind === "file" ? "Enter a file name with its extension." : "Create a folder in the selected location."}</p>
              </div>
              <button className="close-button" aria-label="Close" onClick={() => setEntryDialogKind("")}>×</button>
            </div>
            <div className="folder-setting">
              <label htmlFor="new-entry-name">{entryDialogKind === "file" ? "File name and extension" : "Folder name"}</label>
              <input id="new-entry-name" autoFocus value={newEntryName} onChange={(event) => setNewEntryName(event.target.value)} placeholder={entryDialogKind === "file" ? "script.py" : "src"} />
            </div>
            <div className="folder-setting">
              <label htmlFor="new-entry-parent">Parent folder</label>
              <select id="new-entry-parent" value={newEntryParent} onChange={(event) => setNewEntryParent(event.target.value)}>
                <option value="">Project root</option>
                {entries.filter((entry) => entry.isDir).map((entry) => <option value={entry.path} key={entry.path}>{entry.path}</option>)}
              </select>
            </div>
            <div className="settings-dialog-footer">
              <button className="cancel-button" onClick={() => setEntryDialogKind("")}>Cancel</button>
              <button className="save-button" onClick={() => void createProjectEntry()}>Create {entryDialogKind}</button>
            </div>
          </section>
        </div>
      )}

      {moveEntry && (
        <div className="settings-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setMoveEntry(null); }}>
          <section className="settings-dialog create-graph-dialog" role="dialog" aria-modal="true" aria-labelledby="move-entry-title">
            <div className="settings-dialog-header">
              <div>
                <h2 id="move-entry-title">Move {moveEntry.isDir ? "folder" : "file"}</h2>
                <p>Choose a new parent folder for {moveEntry.name}.</p>
              </div>
              <button className="close-button" aria-label="Close" onClick={() => setMoveEntry(null)}>×</button>
            </div>
            <div className="folder-setting">
              <label htmlFor="move-entry-parent">New parent folder</label>
              <select id="move-entry-parent" value={moveParent} onChange={(event) => setMoveParent(event.target.value)}>
                <option value="">Project root</option>
                {entries.filter((entry) => entry.isDir && entry.path !== moveEntry.path && !(moveEntry.isDir && entry.path.startsWith(`${moveEntry.path}/`))).map((entry) => <option value={entry.path} key={entry.path}>{entry.path}</option>)}
              </select>
            </div>
            <div className="settings-dialog-footer">
              <button className="cancel-button" onClick={() => setMoveEntry(null)}>Cancel</button>
              <button className="save-button" onClick={() => void moveEntryToSelectedParent()}>Move here</button>
            </div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div
          className="settings-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSettingsOpen(false);
            }
          }}
        >
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="settings-dialog-header">
              <div>
                <h2 id="settings-title">
                  Visual Code Settings
                </h2>
                <p>
                  Configure your reusable node library and default
                  extension.
                </p>
              </div>

              <button
                className="close-button"
                aria-label="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </div>

            {settingsLoading ? (
              <p>Loading settings…</p>
            ) : (
              <>
                <div className="folder-setting">
                  <label htmlFor="node-library-folder">
                    Node saves folder
                  </label>

                  <p>
                    The folder where reusable node definitions will
                    be stored.
                  </p>

                  <div className="folder-picker-row">
                    <input
                      id="node-library-folder"
                      value={nodeLibraryFolder}
                      readOnly
                      placeholder="No node library folder selected"
                    />

                    <button
                      onClick={() =>
                        void chooseNodeLibraryFolder()
                      }
                    >
                      Browse…
                    </button>
                  </div>
                </div>

                <div className="folder-setting">
                  <label htmlFor="default-extension">
                    Default source extension
                  </label>

                  <p>Used when creating a new graph.</p>

                  <div className="extension-input settings-extension">
                    <span>.</span>

                    <input
                      id="default-extension"
                      value={preferredExtension.replace(/^\./, "")}
                      onChange={(event) =>
                        setPreferredExtension(
                          event.target.value.replace(/^\./, ""),
                        )
                      }
                      placeholder="js"
                    />
                  </div>
                </div>

                {settingsNotice && (
                  <p className="settings-notice">
                    {settingsNotice}
                  </p>
                )}

                <div className="settings-dialog-footer">
                  <button
                    className="cancel-button"
                    onClick={() => setSettingsOpen(false)}
                  >
                    Close
                  </button>

                  <button
                    className="save-button"
                    disabled={settingsSaving}
                    onClick={() => void saveGlobalSettings()}
                  >
                    {settingsSaving
                      ? "Saving…"
                      : "Save settings"}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
