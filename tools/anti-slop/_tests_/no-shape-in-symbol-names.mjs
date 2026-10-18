import { RuleTester } from "./runtime.mjs";
import { noForbiddenTermInSymbolNamesRule } from "../rules/no-shape-in-symbol-names.mjs";
const tester = new RuleTester();
const error = { messageId: "forbiddenSymbolName" };
tester.run("anti-slop/no-shape-in-symbol-names", noForbiddenTermInSymbolNamesRule, {
  valid: [
    "type PredicateShape = typeof PREDICATE_SHAPES[keyof typeof PREDICATE_SHAPES]; function matches(shape: PredicateShape) { return shape; }",
    "const PREDICATE_SHAPES = { eq: 'comparison' }; const grammar = PREDICATE_SHAPES;",
    "declare const schema: ExternalSchema; const field = schema.shape.id;",
    "declare const outer: External; const value = outer.inner.shape;",
    "declare const schema: ExternalSchema; schema.shape.id.parse('x');",
    "const owner = { id: 1 }; const value = owner.id;"
  ],
  invalid: [
    { code: "const shape = 1;", errors: [error] },
    { code: "function shapeOf() {}", errors: [error] },
    { code: "type PayloadShape = { id: string };", errors: [error] },
    { code: "type Payload = { shape: string };", errors: [error] },
    {
      code: "declare const owner: External; const shape = 'field'; const value = owner[shape];",
      errors: 1
    }
  ]
});
