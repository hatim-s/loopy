import { parseDu as run } from "../../shell/parse/fs.js";

export default (...args: Parameters<typeof run>) => run(...args);
