const { z } = require("zod");

const createInwardSchema = z.object({
  created_by: z.string().optional().default("system"),
  vendor_name: z.string().nullable().optional(),
});

const selectInvoicesSchema = z.object({
  invoice_ids: z.array(z.string()).min(1, "At least one invoice is required"),
});

const receiveSchema = z.object({
  receive_boxes: z.number().int().min(1).optional(),
  receive_images: z.array(z.string()).optional().default([]),
}).passthrough();

const exceptionsSchema = z.object({
  exceptions: z.any(),
});

const packSchema = z.object({
  packing_list: z.any(),
});

module.exports = {
  createInwardSchema,
  selectInvoicesSchema,
  receiveSchema,
  exceptionsSchema,
  packSchema,
};
