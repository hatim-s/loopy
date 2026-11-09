import { principalToken, readLocalCredentials } from "./stack/credentials";
import { LOCAL_STACK } from "./stack/ports";

const token = principalToken(await readLocalCredentials(), "fixtures");

console.log(`${LOCAL_STACK.origin("dashboard")}/#token=${encodeURIComponent(token)}`);
