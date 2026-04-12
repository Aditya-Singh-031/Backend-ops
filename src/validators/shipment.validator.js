const { z } = require("zod");

const shipmentLineItemSchema = z.object({
  refNo: z.string().optional().default(""),
  partNo: z.string().optional().default(""),
  description: z.string().optional().default(""),
  hsn: z.string().optional().default(""),
  qty: z.union([z.string(), z.number()]).optional(),
  rate: z.union([z.string(), z.number()]).optional(),
  unit: z.string().optional().default("NOS"),
  igst: z.string().optional().default("18"),
  amount: z.union([z.string(), z.number()]).optional(),
}).passthrough();

const saveShipmentSchema = z.object({
  invoiceNumber: z.string().min(1, "Invoice number is required"),
  invoiceDate: z.string().optional(),
  buyer: z.any(),
  consignee: z.any().optional(),
  consigneeSameAsBuyer: z.boolean().optional(),
  chaAgent: z.string().optional().default(""),
  replacementTo: z.string().optional().default(""),
  dispatchLocation: z.string().optional(),
  preCarriageBy: z.string().optional(),
  placeOfReceipt: z.string().optional(),
  portOfLoading: z.string().optional(),
  portOfDischarge: z.string().optional(),
  termsOfDelivery: z.string().optional().default("FOB"),
  termsOfPayment: z.string().optional(),
  numberOfPackages: z.union([z.string(), z.number()]).optional(),
  totalNetWeight: z.union([z.string(), z.number()]).optional(),
  totalGrossWeight: z.union([z.string(), z.number()]).optional(),
  freightCharges: z.union([z.string(), z.number()]).optional(),
  insuranceCharges: z.union([z.string(), z.number()]).optional(),
  fobValue: z.union([z.string(), z.number()]).optional(),
  splitFobFreight: z.any().optional(),
  exchangeRate: z.union([z.string(), z.number()]).optional(),
  currencyLabel: z.string().optional().default("USD"),
  status: z.string().optional().default("Draft"),
  lineItems: z.array(shipmentLineItemSchema).optional().default([]),
}).passthrough();

const quickCreateShipmentSchema = z.object({
  invoice_number: z.string().min(1, "Invoice number is required"),
  invoice_date: z.string().optional(),
  buyer_id: z.string().optional(),
  consignee_id: z.string().optional(),
  discharge_port: z.string().optional().default(""),
  delivery_terms: z.string().optional().default("FOB"),
  payment_terms: z.string().optional().default(""),
  currency: z.string().optional().default("USD"),
  dispatch_location: z.string().optional().default("MUMBAI"),
  loading_port: z.string().optional().default("Nhava Sheva, India"),
  cha_details: z.string().optional().default(""),
}).passthrough();

const generateInvoiceSchema = z.object({
  downloadVariant: z.string().optional().default("commercial_invoice"),
  invoiceNumber: z.string().optional(),
  invoiceDate: z.string().optional(),
  buyer: z.any().optional(),
  consignee: z.any().optional(),
  consigneeSameAsBuyer: z.boolean().optional(),
  lineItems: z.array(z.any()).optional().default([]),
  outputFormat: z.string().optional().default("pdf"),
}).passthrough();

module.exports = {
  saveShipmentSchema,
  quickCreateShipmentSchema,
  generateInvoiceSchema,
  shipmentLineItemSchema,
};
