import { parseSync } from "oxc-parser";

export async function checkCodeModule(path: string) {
  const source = await Bun.file(path).text();
  const { program, errors } = parseSync(path, source, { sourceType: "module" });

  if (errors.length > 0) {
    throw new Error(errors.map((error) => error.message).join("\n"));
  }

  const exported = program.body.find((node) => node.type === "ExportDefaultDeclaration");

  if (exported?.type !== "ExportDefaultDeclaration") {
    throw new Error("Code modules must default-export one function.");
  }

  let declaration = exported.declaration;

  if (declaration.type === "Identifier") {
    const identifier = declaration.name;

    const named = program.body
      .flatMap((node) => (node.type === "VariableDeclaration" ? node.declarations : []))
      .find((node) => node.id.type === "Identifier" && node.id.name === identifier);

    const fn = program.body.find(
      (node) => node.type === "FunctionDeclaration" && node.id?.name === identifier,
    );

    if (fn?.type === "FunctionDeclaration") {
      declaration = fn;
    } else if (
      named?.init?.type === "ArrowFunctionExpression" ||
      named?.init?.type === "FunctionExpression"
    ) {
      declaration = named.init;
    }
  }

  if (
    !["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
      declaration.type,
    )
  ) {
    throw new Error("Code modules must default-export one function.");
  }
}
