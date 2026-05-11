"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { OpenAI } = require("openai");
const { z } = require("zod");
const { zodResponseFormat } = require("openai/helpers/zod");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── CONFIG ───────────────────────────────────────────────────────
const TEXT_CHUNK_CHARS   = 60_000; // ~15K tokens per chunk — safe for GPT-4o
const PAGES_PER_BATCH    = 8;      // pages per file-upload batch
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// ZOD SCHEMA — Supply Bill / Tax Invoice
// ─────────────────────────────────────────────────────────────────
const LineItemSchema = z.object({
  s_no:             z.string().nullable(),
  description:      z.string().nullable(),
  part_number:      z.string().nullable(),
  hsn_code:         z.string().nullable(),
  quantity:         z.number().nullable(),
  unit:             z.string().nullable(),
  unit_price:       z.number().nullable(),
  discount_percent: z.number().nullable(),
  discount_amount:  z.number().nullable(),
  base_amount:      z.number().nullable(),
  cgst_rate:        z.number().nullable(),
  cgst:             z.number().nullable(),
  sgst_rate:        z.number().nullable(),
  sgst:             z.number().nullable(),
  igst_rate:        z.number().nullable(),
  igst:             z.number().nullable(),
  total_gst:        z.number().nullable(),
  amount_incl_gst:  z.number().nullable(),
});

const PartySchema = z.object({
  name:       z.string().nullable(),
  trade_name: z.string().nullable(),
  address:    z.string().nullable(),
  city:       z.string().nullable(),
  state:      z.string().nullable(),
  state_code: z.string().nullable(),
  pincode:    z.string().nullable(),
  country:    z.string().nullable(),
  gstin:      z.string().nullable(),
  pan:        z.string().nullable(),
  email:      z.string().nullable(),
  phone:      z.string().nullable(),
});

const SupplyBillSchema = z.object({
  invoice_metadata: z.object({
    invoice_number:         z.string().nullable(),
    invoice_date:           z.string().nullable(),
    irn_number:             z.string().nullable(),
    acknowledgement_number: z.string().nullable(),
    acknowledgement_date:   z.string().nullable(),
    sale_order_number:      z.string().nullable(),
    sale_order_date:        z.string().nullable(),
    eway_bill_number:       z.string().nullable(),
    document_type:          z.string().nullable(),
  }),
  seller: PartySchema,
  buyer:  PartySchema,
  consignee: z.object({
    name:    z.string().nullable(),
    address: z.string().nullable(),
    city:    z.string().nullable(),
    state:   z.string().nullable(),
    pincode: z.string().nullable(),
    gstin:   z.string().nullable(),
  }),
  gst_details: z.object({
    gst_customer_type:         z.string().nullable(),
    place_of_supply:           z.string().nullable(),
    reverse_charge_applicable: z.string().nullable(),
  }),
  line_items: z.array(LineItemSchema),
  totals: z.object({
    total_line_items_count: z.number().nullable(),
    total_parts_amount:     z.number().nullable(),
    total_discount_amount:  z.number().nullable(),
    total_taxable_value:    z.number().nullable(),
    cgst_total:             z.number().nullable(),
    sgst_total:             z.number().nullable(),
    igst_total:             z.number().nullable(),
    total_gst:              z.number().nullable(),
    other_charges:          z.number().nullable(),
    invoice_amount:         z.number().nullable(),
    invoice_amount_words:   z.string().nullable(),
    rounding_off_amount:    z.number().nullable(),
  }),
  shipping: z.object({
    mode_of_transport: z.string().nullable(),
    vehicle_no:        z.string().nullable(),
    lr_gr_no:          z.string().nullable(),
    lr_gr_date:        z.string().nullable(),
    carrier_name:      z.string().nullable(),
  }),
});

// ─────────────────────────────────────────────────────────────────
// EXTRACTION PROMPT
// ─────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert data extraction agent for Indian automotive supply chain documents.
You will receive Tax Invoices, Supply Bills, or Delivery Challans from any supplier (e.g. Koovers, VW, Skoda, Mahindra, Tata, Bosch, etc.).

CRITICAL RULES:
1. Extract ALL data exactly as written. Never infer or guess.
2. Dates → YYYY-MM-DD (e.g. 15/03/2024 → 2024-03-15).
3. Amounts → plain numbers, strip ₹ Rs. commas (e.g. ₹1,23,456.78 → 123456.78).
4. Extract EVERY line item row — do not skip any.
5. Missing fields → null.

PART NUMBER (CRITICAL):
- Part numbers are alphanumeric codes: 6RG807421AGRU, CS-12345, 5QM945207B, etc.
- NEVER use Invoice No, PO No, Order ID, or HSN code as the part number.
- Find in columns: "Part No.", "Part Code", "Item Code", "Article No.", "Material No.", "SKU"

LINE ITEM COLUMNS:
  S.No / Sr.                                → s_no
  Description / Item / Part Name            → description
  Part No. / Code / Material / SKU          → part_number
  HSN / SAC Code                            → hsn_code
  Qty / Quantity / Nos / Pcs               → quantity (number)
  UOM / Unit / Per                          → unit
  Rate / Unit Price / MRP                   → unit_price (number)
  Disc % / Discount Rate                    → discount_percent (number)
  Disc Amt / Discount Amount                → discount_amount (number)
  Taxable Value / Assessable / Basic Amt    → base_amount (number)
  CGST %                                    → cgst_rate (e.g. 9 for 9%)
  CGST Amount                               → cgst (number)
  SGST %                                    → sgst_rate (number)
  SGST Amount                               → sgst (number)
  IGST %                                    → igst_rate (number)
  IGST Amount                               → igst (number)
  Total Tax                                 → total_gst (number)
  Total / Amount Incl. Tax                  → amount_incl_gst (number)

TOTALS:
  Count of line item rows                   → total_line_items_count
  Sub Total / Total before discount         → total_parts_amount
  Total Taxable / Assessable Value          → total_taxable_value
  Grand Total / Net Payable                 → invoice_amount
  Amount in Words                           → invoice_amount_words
  Round Off                                 → rounding_off_amount

PARTIES:
  Seller / Supplier / From / Billed By     → seller
  Buyer / Bill To / Sold To                → buyer
  Ship To / Deliver To / Consignee         → consignee

METADATA:
  Invoice No / Bill No                     → invoice_number
  Invoice Date / Bill Date                 → invoice_date
  IRN Number                               → irn_number
  Ack No / Acknowledgement No              → acknowledgement_number
  PO No / Purchase Order / Order No        → sale_order_number
  E-Way Bill No / EWB No                   → eway_bill_number`;

// ─────────────────────────────────────────────────────────────────
// UTILITY: Merge multiple partial extraction results into one
// Header/metadata taken from first chunk; line_items merged from all
// ─────────────────────────────────────────────────────────────────
function mergeResults(results) {
  if (results.length === 1) return results[0];

  const base = results[0]; // metadata from first chunk (has header info)
  const allLineItems = results.flatMap(r => r.line_items ?? []);

  // Totals: take the last non-null value (usually in the last chunk/page)
  const lastTotals = [...results].reverse().find(r => r.totals?.invoice_amount != null)?.totals
    ?? base.totals;

  return {
    ...base,
    line_items: allLineItems,
    totals: {
      ...lastTotals,
      total_line_items_count: allLineItems.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// UTILITY: Split text into safe-size chunks
// Splits on line boundaries to avoid cutting mid-row
// ─────────────────────────────────────────────────────────────────
function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    if ((current + line).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += line + "\n";
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ─────────────────────────────────────────────────────────────────
// UTILITY: Split PDF buffer into page-batches using pdf-lib
// Returns array of Buffers, each containing PAGES_PER_BATCH pages
// ─────────────────────────────────────────────────────────────────
async function splitPdfIntoBatches(pdfBuffer) {
  const { PDFDocument } = require("pdf-lib");

  const srcDoc = await PDFDocument.load(pdfBuffer);
  const totalPages = srcDoc.getPageCount();

  console.log(`[SupplyBill] PDF has ${totalPages} pages — batching ${PAGES_PER_BATCH} per call`);

  const batches = [];

  for (let start = 0; start < totalPages; start += PAGES_PER_BATCH) {
    const end = Math.min(start + PAGES_PER_BATCH, totalPages);
    const batchDoc = await PDFDocument.create();
    const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);
    const copiedPages = await batchDoc.copyPages(srcDoc, pageIndices);
    copiedPages.forEach(p => batchDoc.addPage(p));
    const batchBytes = await batchDoc.save();
    batches.push(Buffer.from(batchBytes));
    console.log(`[SupplyBill] Batch ${batches.length}: pages ${start + 1}–${end}`);
  }

  return batches;
}

// ─────────────────────────────────────────────────────────────────
// STEP 1: Try fast text extraction
// ─────────────────────────────────────────────────────────────────
async function tryTextExtraction(filePath) {
  try {
    const rawPdfParse = require("pdf-parse");
    const buffer = fs.readFileSync(filePath);
    
    let text = "";
    if (typeof rawPdfParse === "function") {
      const result = await rawPdfParse(buffer);
      text = result && result.text ? result.text.trim() : "";
    } else if (rawPdfParse && typeof rawPdfParse.default === "function") {
      const result = await rawPdfParse.default(buffer);
      text = result && result.text ? result.text.trim() : "";
    } else if (rawPdfParse && typeof rawPdfParse.PDFParse === "function") {
      const parser = new rawPdfParse.PDFParse({ data: buffer });
      await parser.load();
      const textResult = await parser.getText();
      if (typeof textResult === "string") {
        text = textResult.trim();
      } else if (typeof textResult === "object" && textResult !== null) {
        // pdf-parse v2 returns an object { '1': 'page 1 text', '2': '...', total: 21 }
        text = Object.keys(textResult)
          .filter(key => !isNaN(key))
          .sort((a, b) => Number(a) - Number(b))
          .map(key => textResult[key])
          .join("\n")
          .trim();
      }
    } else {
      console.error("[SupplyBill] Unrecognized pdf-parse export:", rawPdfParse);
      return null;
    }

    console.log(`[SupplyBill] pdf-parse: ${text.length} chars extracted`);
    return text.length >= 200 ? text : null;
  } catch (err) {
    console.error("[SupplyBill] pdf-parse error:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// STEP 2A: Text mode — with auto-chunking for large PDFs
// ─────────────────────────────────────────────────────────────────
async function extractFromText(fullText) {
  const chunks = chunkText(fullText, TEXT_CHUNK_CHARS);
  console.log(`[SupplyBill] Text mode: ${chunks.length} chunk(s) to process`);

  const results = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(`[SupplyBill] Processing text chunk ${i + 1}/${chunks.length}...`);

    const completion = await openai.chat.completions.parse({
      model: "gpt-4o-2024-08-06",
      temperature: 0,
      response_format: zodResponseFormat(SupplyBillSchema, "supply_bill"),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: chunks.length > 1
            ? `SUPPLY BILL CONTENT (part ${i + 1} of ${chunks.length}):\n\n${chunks[i]}`
            : `SUPPLY BILL CONTENT:\n\n${chunks[i]}`,
        },
      ],
    });

    results.push(completion.choices[0].message.parsed);
  }

  return mergeResults(results);
}

// ─────────────────────────────────────────────────────────────────
// STEP 2B: File Upload mode — with page batching for large PDFs
// Uploads each batch to OpenAI Files API, cleans up after
// ─────────────────────────────────────────────────────────────────
async function extractFromFileUpload(filePath) {
  const pdfBuffer = fs.readFileSync(filePath);
  const batches = await splitPdfIntoBatches(pdfBuffer);

  const results = [];

  for (let i = 0; i < batches.length; i++) {
    const batchLabel = `batch-${i + 1}-of-${batches.length}`;
    console.log(`[SupplyBill] Uploading ${batchLabel} to OpenAI...`);

    // Write batch to temp file (OpenAI SDK needs a stream/path)
    const tmpPath = path.join(os.tmpdir(), `sb_${Date.now()}_${i}.pdf`);
    fs.writeFileSync(tmpPath, batches[i]);

    let fileId = null;
    try {
      const upload = await openai.files.create({
        file: fs.createReadStream(tmpPath),
        purpose: "user_data",
      });
      fileId = upload.id;
      console.log(`[SupplyBill] Uploaded ${batchLabel} → file_id: ${fileId}`);

      const completion = await openai.chat.completions.parse({
        model: "gpt-4o-2024-08-06",
        temperature: 0,
        response_format: zodResponseFormat(SupplyBillSchema, "supply_bill"),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: batches.length > 1
                  ? `Extract all data from this supply bill (part ${i + 1} of ${batches.length}). Read every table row carefully.`
                  : `Extract all data from this supply bill. Read every table row carefully.`,
              },
              {
                type: "file",
                file: { file_id: fileId },
              },
            ],
          },
        ],
      });

      results.push(completion.choices[0].message.parsed);

    } finally {
      // Cleanup temp file
      try { fs.unlinkSync(tmpPath); } catch {}

      // Cleanup OpenAI uploaded file
      if (fileId) {
        try {
          await openai.files.delete(fileId);
          console.log(`[SupplyBill] Cleaned up file_id: ${fileId}`);
        } catch (e) {
          console.warn(`[SupplyBill] Cleanup warning (non-critical): ${e.message}`);
        }
      }
    }
  }

  return mergeResults(results);
}

// ─────────────────────────────────────────────────────────────────
// MAIN EXPORT: parseSupplyBill
//
// Decision flow:
//   pdf-parse extracts text
//     ├─ text >= 200 chars → TEXT mode  (chunks if > 60K chars)
//     └─ text < 200 chars  → FILE UPLOAD mode  (batches of 8 pages)
//
// Handles: small/large PDFs, digital/scanned, any supplier
// ─────────────────────────────────────────────────────────────────
exports.parseSupplyBill = async (filePath) => {
  const filename = path.basename(filePath);
  const fileSizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
  console.log(`\n[SupplyBill] ─── Parsing: ${filename} (${fileSizeMB} MB) ───`);

  const text = await tryTextExtraction(filePath);

  if (text) {
    console.log(`[SupplyBill] Mode: TEXT${text.length > TEXT_CHUNK_CHARS ? " (chunked)" : ""}`);
    const data = await extractFromText(text);
    console.log(`[SupplyBill] ✅ Done — ${data.line_items?.length ?? 0} line items`);
    return { ...data, _extraction_method: text.length > TEXT_CHUNK_CHARS ? "text_chunked" : "text" };
  }

  console.log(`[SupplyBill] Mode: FILE UPLOAD (scanned PDF, page batching)`);
  const data = await extractFromFileUpload(filePath);
  console.log(`[SupplyBill] ✅ Done — ${data.line_items?.length ?? 0} line items`);
  return { ...data, _extraction_method: "file_upload_batched" };
};
