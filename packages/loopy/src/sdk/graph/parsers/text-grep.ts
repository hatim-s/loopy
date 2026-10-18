import { parseGrep as run } from "../../shell/parse/text.js";

export default (...args: Parameters<typeof run>) => run(...args);
