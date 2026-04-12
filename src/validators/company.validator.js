const { z } = require("zod");

const createCompanySchema = z.object({
  name: z.string().min(1, "Company name is required").trim(),
  cust_name: z.string().optional(),
  address: z.string().optional().default(""),
  country: z.string().optional().default(""),
  gstNo: z.string().optional().default(""),
  panNo: z.string().optional().default(""),
  iecCode: z.string().optional().default(""),
}).passthrough();

module.exports = { createCompanySchema };
