const fs = require("fs");
const pdfParse = require("pdf-parse");
const { OpenAI } = require("openai");
const { z } = require("zod");
const { zodResponseFormat } = require("openai/helpers/zod");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Define exact structured output schema
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

exports.parseInvoiceFile = async (filePath) => {
  // 1. Read and extract raw text from the uploaded PDF
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(dataBuffer);
  const text = data.text;

  // 2. Pass to OpenAI using strict JSON structured formats
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