import { MemoryStore } from "../src/store/index.js";
import { storeContract } from "./store-contract.js";

storeContract("memory", (options) => new MemoryStore(options?.now, options?.leaseMs));
