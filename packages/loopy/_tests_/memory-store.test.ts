import { MemoryStore } from "../src/store";
import { storeContract } from "./store-contract";

storeContract("memory", (options) => new MemoryStore(options?.now, options?.leaseMs));
