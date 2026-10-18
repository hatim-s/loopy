import { parseSha256 as run } from "../../shell/parse/text.js";

export default (...args: Parameters<typeof run>) => run(...args);
