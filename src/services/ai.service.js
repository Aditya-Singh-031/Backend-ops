const fs = require("fs");
const rawPdfParse = require("pdf-parse");
const { OpenAI } = require("openai");
const { z } = require("zod");
const { zodResponseFormat } = require("openai/helpers/zod");

// ─── BULLETPROOF PDF PARSER WRAPPER ───
// Safely hunts down the correct function no matter how npm installed the module
async function extractPdfText(buffer) {
  if (typeof rawPdfParse === "function") {
    return (await rawPdfParse(buffer)).text;
  } else if (rawPdfParse && typeof rawPdfParse.default === "function") {
    return (await rawPdfParse.default(buffer)).text;
  } else {
    console.error("Unrecognized pdf-parse export:", rawPdfParse);
    throw new Error("PDF Library failed to load as a function. Format unrecognized.");
  }
}

// ─── OPENAI INIT ───
const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY || "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" 
});

// ─── ZOD SCHEMAS ───
const LineItemSchema = z.object({
  description: z.string().nullable(),
  hsn_code: z.string().nullable(),
  part_number: z.string().nullable().describe("CRITICAL: Must be the actual part number (e.g. 6RG807421AGRU). Do NOT use Invoice Numbers or Order IDs (like IFY26...)."),
  quantity: z.number().nullable(),
  unit_price: z.number().nullable(),
  discount_percent: z.number().nullable(),
  base_amount: z.number().nullable(),
  cgst_rate: z.number().nullable(),
  sgst_rate: z.number().nullable(),
  igst_rate: z.number().nullable(),
  total_gst: z.number().nullable(),
  amount_incl_gst: z.number().nullable()
});

const InvoiceSchema = z.object({
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable(),
  vendor_name: z.string().nullable(),
  vendor_gstin: z.string().nullable(),
  invoice_amount: z.number().nullable(),
  line_items: z.array(LineItemSchema)
});

// ─── EXTRACTION LOGIC ───
exports.parseInvoiceFile = async (filePath) => {
  // 1. Read and extract raw text safely
  const dataBuffer = fs.readFileSync(filePath);
  const text = await extractPdfText(dataBuffer);

  // 2. Pass to OpenAI
  const completion = await openai.beta.chat.completions.parse({
    model: "gpt-4o-2024-08-06",
    temperature: 0,
    response_format: zodResponseFormat(InvoiceSchema, "invoice_extraction"),
    messages: [
      {
        role: "system",
        content: `You are an expert invoice data extraction agent specialized in Indian supply chain invoices.
CRITICAL RULES:
1. Extract ALL information exactly as written.
2. Convert dates to YYYY-MM-DD.
3. Convert amounts to numbers (remove ₹, Rs, commas).
4. Extract EVERY single line item.
5. CRITICAL FIX: Part Numbers are usually alphanumeric strings (e.g. 6RG807421AGRU). Do NOT mistake the Invoice Number, Order Number, or HSN code for the Part Number. Ensure you capture the exact Part Number.`
      },
      { role: "user", content: `INVOICE CONTENT:\n${text}` }
    ]
  });

  return completion.choices[0].message.parsed;
};