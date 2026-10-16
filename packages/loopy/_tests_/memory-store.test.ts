import { MemoryRunStore } from "../src/runtime/index.js";
import { storeContract } from "./store-contract.js";

storeContract("MemoryRunStore", (options) => new MemoryRunStore(options?.now, options?.leaseMs));
