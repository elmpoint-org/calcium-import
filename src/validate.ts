import { z } from 'zod';

export const validate = <T>(inp: unknown, schema: z.ZodSchema<T>) => {
  let out;
  try {
    out = { data: schema.parse(inp) };
  } catch (error) {
    out = { error: (error as z.ZodError).issues };
  }

  return out as { error?: z.ZodError; data?: T };
};
