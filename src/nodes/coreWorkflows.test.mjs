import test from "node:test";
import assert from "node:assert/strict";
import { retainValidSinglePortConnections } from "./nodeDefinitions.ts";
import { generateSource } from "./codeGeneration.ts";

const value = (id, contents) => ({ id, type: "function", position: { x: 0, y: 0 }, data: { label: id, kind: "value", inputs: [], outputs: [{ id: "output1", type: "text" }], template: "", outputTemplates: ["value"], value: contents } });
const fn = (id, template, inputs, outputs, outputTemplates, extra = {}) => ({ id, type: "function", position: { x: 0, y: 0 }, data: { label: id, kind: "function", inputs: inputs.map((name) => ({ id: name, type: "text" })), outputs: outputs.map((name) => ({ id: name, type: "text" })), template, outputTemplates, ...extra } });
const edge = (id, source, output, target, input) => ({ id, source, sourceHandle: `out:${output}`, target, targetHandle: `in:${input}` });

test("single-port sanitizer rejects fan-out, occupied inputs, duplicates, and invalid handles", () => {
  const nodes = [value("source", "x"), value("other-source", "y"), fn("one", "", ["input1"], ["output1"], [""]), fn("two", "", ["input1"], ["output1"], [""])];
  const edges = [edge("keep", "source", "output1", "one", "input1"), edge("fanout", "source", "output1", "two", "input1"), edge("occupied-input", "other-source", "output1", "one", "input1"), edge("duplicate", "source", "output1", "one", "input1"), { ...edge("bad", "missing", "output1", "two", "input1") }];
  assert.deepEqual(retainValidSinglePortConnections(nodes, edges).map((item) => item.id), ["keep"]);
});

test("per-output mappings expose individual inputs and substituted Logic with precedence-safe expressions", () => {
  const nodes = [value("three", "3"), value("five", "5"), fn("sum", "input1 + input2", ["input1", "input2"], ["output1", "output2"], ["input1", "Logic"]), fn("input-use", "print(input1)", ["input1"], [], []), fn("logic-use", "input1 * 2", ["input1"], [], [])];
  const edges = [edge("a", "three", "output1", "sum", "input1"), edge("b", "five", "output1", "sum", "input2"), edge("c", "sum", "output1", "input-use", "input1"), edge("d", "sum", "output2", "logic-use", "input1")];
  assert.equal(generateSource(nodes, edges), "3 + 5\nprint(3)\n(3 + 5) * 2\n");
});

test("external input overrides a Function Node's exposed Value parameter", () => {
  const nodes = [value("external", "5"), fn("parameterized", "input1", ["input1"], ["output1"], ["Logic"], { valueParameters: [{ inputId: "input1", name: "value1", value: "10", editable: true }] })];
  assert.equal(generateSource(nodes, []), "10\n");
  assert.equal(generateSource(nodes, [edge("override", "external", "output1", "parameterized", "input1")]), "5\n");
});

test("Composite Node expansion preserves inner code and forwards mapped output", () => {
  const inner = fn("inner-var", "input1 = input2", ["input1", "input2"], ["output1"], ["input1"]);
  const composite = { id: "composite", type: "function", position: { x: 0, y: 0 }, data: { label: "Define", kind: "composite", inputs: [{ id: "input1", type: "text" }, { id: "input2", type: "text" }], outputs: [{ id: "output1", type: "text" }], template: "", outputTemplates: [""], definitionGraph: { nodes: [inner], edges: [] }, compositeInputMappings: [{ inputId: "input1", nodeId: "inner-var", nodeInputId: "input1" }, { inputId: "input2", nodeId: "inner-var", nodeInputId: "input2" }], compositeOutputMappings: [{ outputId: "output1", nodeId: "inner-var", nodeOutputId: "output1" }] } };
  const downstream = fn("print", "print(input1)", ["input1"], [], []);
  const nodes = [value("name", "name"), value("person", "David"), composite, downstream];
  const edges = [edge("in-name", "name", "output1", "composite", "input1"), edge("in-value", "person", "output1", "composite", "input2"), edge("out", "composite", "output1", "print", "input1")];
  assert.equal(generateSource(nodes, edges), "name = David\nprint(name)\n");
});

test("Composite parameters configure internal Value Nodes and external inputs take precedence", () => {
  const innerValue = value("inner-value", "default");
  const innerPrint = fn("inner-print", "print(input1)", ["input1"], [], []);
  const composite = { id: "composite", type: "function", position: { x: 0, y: 0 }, data: { label: "Parameterized", kind: "composite", inputs: [{ id: "input1", type: "text" }], outputs: [], template: "", outputTemplates: [], definitionGraph: { nodes: [innerValue, innerPrint], edges: [edge("inside", "inner-value", "output1", "inner-print", "input1")] }, compositeInputMappings: [{ inputId: "input1", nodeId: "inner-print", nodeInputId: "input1" }], compositeOutputMappings: [], compositeParameters: [{ id: "p", name: "message", sourceNodeId: "inner-value", targetNodeId: "inner-print", inputId: "input1", value: "configured", editable: true, sourceKind: "value" }] } };
  assert.equal(generateSource([composite], []), "print(configured)\n");
  const external = value("external", "external_value");
  assert.equal(generateSource([external, composite], [edge("override", "external", "output1", "composite", "input1")]), "print(external_value)\n");
});
