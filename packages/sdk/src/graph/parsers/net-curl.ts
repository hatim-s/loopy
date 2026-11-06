import { parseCurl as run } from "../../shell/parse/net";

export default (...args: Parameters<typeof run>) => run(...args);
