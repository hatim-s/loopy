import { parseCurl as run } from "../../shell/parse/net.js";

export default (...args: Parameters<typeof run>) => run(...args);
