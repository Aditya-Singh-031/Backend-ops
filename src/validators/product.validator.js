const { z } = require("zod");

const createProductSchema = z.object({
  part_number: z.string().min(1, "Part number is required").trim(),
  brand: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  hsn_code: z.string().nullable().optional(),
  igst_rate: z.number({ required_error: "IGST rate is required" }).min(0),
  qty_per_pack: z.number().nullable().optional(),
  net_weight: z.number().nullable().optional(),
  gross_weight: z.number().nullable().optional(),
  rate: z.number({ required_error: "Rate is required" }).min(0),
  mrp: z.number().nullable().optional(),
  alternates: z.array(z.string()).default([]),
});

const updateProductSchema = z.object({
  part_number: z.string().trim().optional(),
  brand: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  hsn_code: z.string().nullable().optional(),
  igst_rate: z.number().min(0).optional(),
  qty_per_pack: z.number().nullable().optional(),
  net_weight: z.number().nullable().optional(),
  gross_weight: z.number().nullable().optional(),
  rate: z.number().min(0).optional(),
  mrp: z.number().nullable().optional(),
  alternates: z.array(z.string()).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

module.exports = { createProductSchema, updateProductSchema };
