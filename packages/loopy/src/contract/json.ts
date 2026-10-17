import { z } from "zod";

export const jsonSchema = z.json();

export type Json = z.infer<typeof jsonSchema>;
