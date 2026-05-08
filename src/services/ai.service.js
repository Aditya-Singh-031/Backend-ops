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
  } else if (rawPdfParse && typeof rawPdfParse.PDFParse === "function") {
    const parser = new rawPdfParse.PDFParse({ data: buffer });
    await parser.load();
    return await parser.getText();
  } else {
    console.error("Unrecognized pdf-parse export:", rawPdfParse);
    throw new Error("PDF Library failed to load as a function. Format unrecognized.");
  }
}

// ─── OPENAI INIT ───
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ─── ZOD SCHEMAS ───
const InvoiceMetadataSchema = z.object({
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable(),
  irn_number: z.string().nullable(),
  acknowledgement_number: z.string().nullable(),
  acknowledgement_date: z.string().nullable(),
  sale_order_number: z.string().nullable(),
  sale_order_date: z.string().nullable()
});

const PartySchema = z.object({
  name: z.string().nullable(),
  trade_name: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  state_code: z.string().nullable(),
  pincode: z.string().nullable(),
  country: z.string().nullable(),
  gstin: z.string().nullable(),
  pan: z.string().nullable(),
  cin: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  fax: z.string().nullable()
});

const ConsigneeSchema = z.object({
  name: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  pincode: z.string().nullable(),
  country: z.string().nullable(),
  gstin: z.string().nullable()
});

const GSTDetailsSchema = z.object({
  gst_customer_type: z.string().nullable(),
  place_of_supply: z.string().nullable(),
  reverse_charge_applicable: z.string().nullable()
});

const TotalsSchema = z.object({
  total_line_items_count: z.number().nullable(),
  total_parts_amount: z.number().nullable(),
  total_discount_amount: z.number().nullable(),
  total_taxable_value: z.number().nullable(),
  cgst_total: z.number().nullable(),
  sgst_total: z.number().nullable(),
  igst_total: z.number().nullable(),
  total_gst: z.number().nullable(),
  other_charges: z.number().nullable(),
  invoice_amount: z.number().nullable(),
  invoice_amount_words: z.string().nullable(),
  rounding_off_amount: z.number().nullable()
});

const LineItemSchema = z.object({
  s_no: z.string().nullable(),
  description: z.string().nullable(),
  part_number: z.string().nullable().describe("CRITICAL: Must be the actual part number (e.g. 6RG807421AGRU). Do NOT use Invoice Numbers or Order IDs (like IFY26...)."),
  hsn_code: z.string().nullable().describe("HSN or SAC code"),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  unit_price: z.number().nullable(),
  discount_percent: z.number().nullable(),
  discount_amount: z.number().nullable(),
  base_amount: z.number().nullable(),
  cgst_rate: z.number().nullable(),
  sgst_rate: z.number().nullable(),
  igst_rate: z.number().nullable(),
  cgst: z.number().nullable(),
  sgst: z.number().nullable(),
  igst: z.number().nullable(),
  total_gst: z.number().nullable(),
  amount_incl_gst: z.number().nullable()
});

const PaymentSchema = z.object({
  date: z.string().nullable(),
  amount: z.number().nullable(),
  transaction_id: z.string().nullable(),
  payer: z.string().nullable(),
  mode: z.string().nullable()
});

const ShippingSchema = z.object({
  mode_of_transport: z.string().nullable(),
  vehicle_no: z.string().nullable(),
  lr_gr_no: z.string().nullable(),
  lr_gr_date: z.string().nullable(),
  carrier_name: z.string().nullable()
});

const DocumentInfoSchema = z.object({
  document_type: z.string().nullable(),
  delivery_note_no: z.string().nullable(),
  delivery_note_date: z.string().nullable(),
  dispatch_date: z.string().nullable(),
  due_date: z.string().nullable(),
  payment_terms: z.string().nullable()
});

const InvoiceSchema = z.object({
  invoice_metadata: InvoiceMetadataSchema,
  seller: PartySchema,
  buyer: PartySchema,
  consignee: ConsigneeSchema,
  gst_details: GSTDetailsSchema,
  line_items: z.array(LineItemSchema),
  totals: TotalsSchema,
  payments: z.array(PaymentSchema).nullable(),
  shipping: ShippingSchema,
  document_info: DocumentInfoSchema
});

const PartInfoSchema = z.object({
  parts: z.array(z.object({
    part_number: z.string(),
    part_net_wt: z.number().nullable().describe("Net weight of the part in kg. Provide a realistic estimate if exact is unknown."),
    country_of_origin: z.string().nullable().describe("Country of origin, e.g. 'India' or 'Germany'")
  }))
});

// ─── EXTRACTION LOGIC ───
exports.parseInvoiceFile = async (filePath) => {
  // 1. Read and extract raw text safely
  const dataBuffer = fs.readFileSync(filePath);
  const text = await extractPdfText(dataBuffer);

  console.log(`[PDF Parser] Extracted ${text.length} characters from PDF`);
  if (text.length < 100) {
    console.warn(`[PDF Parser] WARNING: Very short text extracted (${text.length} chars). PDF may be image-based/scanned.`);
  }

  // 2. Pass to OpenAI
  const completion = await openai.chat.completions.parse({
    model: "gpt-4o-2024-08-06",
    temperature: 0,
    response_format: zodResponseFormat(InvoiceSchema, "invoice_extraction"),
    messages: [
      {
        role: "system",
        content: `You are an expert invoice data extraction agent specialized in Indian automotive supply chain invoices (e.g. VW, Skoda, Mahindra, Tata supplier invoices / Tax Invoices / Supply Bills).

CRITICAL EXTRACTION RULES:
1. Extract ALL information exactly as written in the document. Do NOT infer or guess.
2. Convert ALL dates to YYYY-MM-DD format (e.g. 15/03/2024 → 2024-03-15).
3. Convert ALL monetary amounts to plain numbers — remove ₹, Rs., commas (e.g. ₹1,23,456.78 → 123456.78).
4. Extract EVERY SINGLE line item from the table. Do not skip any row.

PART NUMBER RULES (CRITICAL):
- Part numbers are alphanumeric strings like: 6RG807421AGRU, 5QM945207B, 6Y0145117B, etc.
- Part numbers are NEVER the Invoice Number, Order ID, PO Number, or HSN/SAC code.
- Part numbers are typically listed in a "Part No.", "Item Code", "Material No.", or "Description" column.
- If unsure, prefer the shorter alphanumeric code that is NOT a date, NOT a number-only string, and NOT a GST/IRN number.

LINE ITEM TABLE RULES:
- S.No / Sr.No → s_no
- Description / Item Name → description  
- Part No. / Item Code / Material No. → part_number
- HSN / SAC / HSN Code → hsn_code
- Qty / Quantity → quantity (number only)
- UOM / Unit → unit
- Rate / Unit Price / MRP → unit_price (number)
- Disc % / Discount → discount_percent (number)
- Disc Amount / Discount Value → discount_amount (number)
- Taxable Value / Base Amount / Assessable Value → base_amount (number)
- CGST Rate % → cgst_rate (number, e.g. 9 for 9%)
- CGST Amount → cgst (number)
- SGST Rate % → sgst_rate (number)
- SGST Amount → sgst (number)
- IGST Rate % → igst_rate (number)
- IGST Amount → igst (number)
- Total Tax → total_gst (number)
- Amount with Tax / Total / Grand Total per line → amount_incl_gst (number)

TOTALS RULES:
- Count total number of line item rows → total_line_items_count
- Total before discount → total_parts_amount
- Total Taxable Value / Total Assessable Value → total_taxable_value
- Invoice Total / Grand Total / Net Payable → invoice_amount
- Amount in words (if present) → invoice_amount_words
- Round off amount (if present) → rounding_off_amount

SELLER / BUYER / CONSIGNEE:
- Seller = the party ISSUING the invoice (Supplier / From)
- Buyer = the party RECEIVING the goods (Bill To / Sold To)
- Consignee = party receiving delivery (Ship To / Deliver To) — may be same as buyer
- Extract GSTIN, PAN, phone, email exactly as shown.

METADATA:
- Invoice No / Bill No → invoice_number
- Invoice Date / Bill Date → invoice_date
- IRN / IRN Number → irn_number
- Ack. No / Acknowledgement No → acknowledgement_number
- Ack. Date → acknowledgement_date
- PO No / Purchase Order No / Sale Order No → sale_order_number
- PO Date / Order Date → sale_order_date

GST:
- Registered / Unregistered / Consumer → gst_customer_type
- Place of Supply / State of Supply → place_of_supply
- Reverse Charge (Y/N) → reverse_charge_applicable

SHIPPING:
- Mode of Transport / By Road / By Air → mode_of_transport
- Vehicle No / LR No / Transporter ID → vehicle_no / lr_gr_no
- Carrier / Transporter Name → carrier_name

If any field is not present in the document, return null for that field.`
      },
      { role: "user", content: `INVOICE CONTENT:\n${text}` }
    ]
  });

  const invoice = completion.choices[0].message.parsed;
  return invoice;
};

// ─── FETCH MISSING PART METADATA USING AI ───
exports.fetchPartsInfoAI = async (partNumbers) => {
  if (!partNumbers || partNumbers.length === 0) return [];
  
  const CHUNK_SIZE = 30;
  const allResults = [];

  try {
    for (let i = 0; i < partNumbers.length; i += CHUNK_SIZE) {
      const chunk = partNumbers.slice(i, i + CHUNK_SIZE);
      const prompt = `Provide the estimated net weight (in kg) and likely country of origin for the following automotive part numbers:\n${chunk.join("\n")}`;

      const completion = await openai.chat.completions.parse({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are an automotive parts expert. Return the net weight in kg and the likely country of origin. If you are unsure about the weight, give a realistic estimate. Ensure the response matches the schema. You MUST return data for EVERY SINGLE part number requested." },
          { role: "user", content: prompt }
        ],
        response_format: zodResponseFormat(PartInfoSchema, "parts_info")
      });

      if (completion.choices[0]?.message?.parsed?.parts) {
        allResults.push(...completion.choices[0].message.parsed.parts);
      }
    }

    return allResults;
  } catch (err) {
    console.error("AI fetchPartsInfoAI error:", err);
    return allResults; // Return whatever was successfully processed before the error
  }
};