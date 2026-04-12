const { z } = require("zod");

const createWhInwardSchema = z.object({
  vendor_name: z.string().optional().default(""),
  created_by: z.string().optional().default("system"),
  notes: z.string().optional().default(""),
}).passthrough();

const updateWhInwardSchema = z.object({
  vendor_name: z.string().optional(),
  notes: z.string().optional(),
  status: z.string().optional(),
}).passthrough();

module.exports = { createWhInwardSchema, updateWhInwardSchema };
