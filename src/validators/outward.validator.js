const { z } = require("zod");

const createOutwardSchema = z.object({
  shipment_id: z.string().min(1, "Shipment is required"),
  selected_box_ids: z.array(z.string()).min(1, "Select at least one box"),
  custom_boxes: z.array(z.any()).optional(),
  notes: z.string().optional().default(""),
  created_by: z.string().optional().default("system"),
});

const updateOutwardSchema = z.object({
  shipment_id: z.string().optional(),
  selected_box_ids: z.array(z.string()).optional(),
  custom_boxes: z.array(z.any()).optional(),
  notes: z.string().optional(),
  status: z.string().optional(),
}).passthrough();

module.exports = { createOutwardSchema, updateOutwardSchema };
