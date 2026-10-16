export type FlagDefinition = {
  readonly cli: string;
  readonly kind: "boolean" | "string" | "number";
  readonly repeatable?: boolean;
  readonly optionalValue?: boolean;
  readonly choices?: readonly string[];
};

export type PositionalDefinition = {
  readonly name: string;
  readonly optional?: boolean;
  readonly variadic?: boolean;
};
