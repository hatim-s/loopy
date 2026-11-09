import { RuleTester } from "eslint";
import { parser } from "typescript-eslint";

class AntiSlopRuleTester extends RuleTester {
  constructor() {
    super({ languageOptions: { parser, parserOptions: { ecmaVersion: 2022, sourceType: "module" } } });
  }
}

export { AntiSlopRuleTester as RuleTester };
