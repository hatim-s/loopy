import { MemoryStore } from "@loopy/runtime/store";
import { storeContract } from "./store-contract";

storeContract("memory", (options) => new MemoryStore(options?.now, options?.leaseMs));
