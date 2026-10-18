const FORBIDDEN_SYMBOL_NAME = "shape";
function containsForbiddenSymbolName(name) {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME) && !/^[A-Z][A-Z0-9_]*_SHAPES$/.test(name);
}
function isStructuralDeclaration(node) {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case "VariableDeclarator":
      return parent.id === node;
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return parent.id === node;
    case "TSTypeAliasDeclaration":
      return parent.id === node && parent.typeAnnotation.type === "TSTypeLiteral";
    case "TSPropertySignature":
    case "PropertyDefinition":
      return parent.key === node && !parent.computed;
    default:
      return false;
  }
}
export const noForbiddenTermInSymbolNamesRule = {
  meta: {
    type: "problem",
    docs: {
      description: 'Disallow vague structural declaration names; grammar vocabularies and their categories are allowed.'
    },
    messages: {
      forbiddenSymbolName: 'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.'
    }
  },
  create(context) {
    const reportForbiddenSymbolName = (node) => {
      if (!containsForbiddenSymbolName(node.name) || !isStructuralDeclaration(node))
        return;
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name }
      });
    };
    return {
      Identifier: reportForbiddenSymbolName,
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier: reportForbiddenSymbolName
    };
  }
};
