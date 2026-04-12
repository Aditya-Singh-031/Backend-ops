const { z } = require("zod");

const lineItemSchema = z.object({
  product_id: z.string().optional(),
  part_number: z.string().optional().default(""),
  brand: z.string().optional().default(""),
  description: z.string().optional().default(""),
  hsn_code: z.string().optional().default(""),
  quantity: z.number().min(0).default(0),
  rate: z.number().min(0).default(0),
  discount_percent: z.number().min(0).max(100).default(0),
  igst_rate: z.number().min(0).default(18),
}).passthrough();

const createOrderSchema = z.object({
  buyer_id: z.string().min(1, "Buyer is required"),
  pi_number: z.string().optional(),
  pi_date: z.string().optional(),
  delivery_date: z.string().optional(),
  currency: z.enum(["INR", "USD", "EUR", "GBP"]).default("INR"),
  payment_terms: z.string().optional().default(""),
  delivery_terms: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  bank_account: z.string().optional(),
  items: z.array(lineItemSchema).optional().default([]),
}).passthrough();

const updateOrderSchema = z.object({
  buyer_id: z.string().optional(),
  pi_number: z.string().optional(),
  pi_date: z.string().optional(),
  delivery_date: z.string().optional(),
  currency: z.enum(["INR", "USD", "EUR", "GBP"]).optional(),
  payment_terms: z.string().optional(),
  delivery_terms: z.string().optional(),
  notes: z.string().optional(),
  bank_account: z.string().optional(),
  items: z.array(lineItemSchema).optional(),
  status: z.string().optional(),
}).passthrough();

const updateStatusSchema = z.object({
  status: z.enum(["DRAFT", "CONFIRMED", "CANCELLED", "SHIPPED", "DELIVERED"]),
});

module.exports = { createOrderSchema, updateOrderSchema, updateStatusSchema, lineItemSchema };
