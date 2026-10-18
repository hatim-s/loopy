import type { Store } from "../core/index.js";
import { MemorySchedules } from "./memory-schedules.js";

export class MemoryStore extends MemorySchedules implements Store {}
