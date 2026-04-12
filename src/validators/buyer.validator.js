const { z } = require("zod");

const addressSchema = z.object({
  address_lines: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().min(1, "Country is required").trim(),
  pincode: z.string().nullable().optional(),
});

const contactSchema = z.object({
  name: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
});

const createBuyerSchema = z.object({
  cust_name: z.string().min(1, "Customer name is required").trim(),
  cust_id: z.string().nullable().optional(),
  address: addressSchema,
  contact: contactSchema.optional(),
  payment_terms: z.string().nullable().optional(),
  currency: z.enum(["INR", "USD", "EUR", "GBP"]).optional(),
});

const updateBuyerSchema = z.object({
  cust_name: z.string().trim().optional(),
  cust_id: z.string().nullable().optional(),
  address: addressSchema.optional(),
  contact: contactSchema.optional(),
  payment_terms: z.string().nullable().optional(),
  currency: z.enum(["INR", "USD", "EUR", "GBP"]).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

module.exports = { createBuyerSchema, updateBuyerSchema };
