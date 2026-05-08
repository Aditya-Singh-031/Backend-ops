const { v4: uuidv4 } = require("uuid");
const { getDb } = require("../config/db");
const supplyBillService = require("../services/supplyBill.service");
const fs = require("fs");
const ExcelJS = require("exceljs");
const { sendSuccess, sendError } = require("../utils/response");

// In-memory job tracker (replaces Redis for immediate frontend feedback)
const activeJobs = new Map();

exports.uploadInvoices = async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) return sendError(res, "No files uploaded", 400);

  const jobId = uuidv4();
  const jobData = {
    job_id: jobId,
    status: "processing",
    total_files: files.length,
    completed_files: 0,
    failed_files: 0,
    progress: 0,
    pdfs: {},
    started_at: new Date().toISOString()
  };

  files.forEach((file, idx) => {
    jobData.pdfs[String(idx)] = { filename: file.originalname, status: "queued", progress: 0, message: "In queue..." };
  });

  activeJobs.set(jobId, jobData);
  
  // Process in background
  processJobBackground(jobId, files).catch(err => {
    console.error(`[Job ${jobId}] Critical background error:`, err);
  });

  // Respond instantly so UI shows "Processing..."
  return sendSuccess(res, { job_id: jobId, message: "Processing started", total_files: files.length });
};

async function processJobBackground(jobId, files) {
  console.log(`\n[Job ${jobId}] 🚀 BACKGROUND PROCESSING STARTED (${files.length} files)`);
  const job = activeJobs.get(jobId);
  const db = await getDb();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const pdfEntry = job.pdfs[String(i)];
    
    console.log(`[Job ${jobId}] 📄 [${i + 1}/${files.length}] Processing: ${file.originalname}`);

    // Stage 1: Reading PDF
    pdfEntry.status = "parsing";
    pdfEntry.message = "Reading PDF...";
    pdfEntry.progress = 20;
    activeJobs.set(jobId, job);

    try {
      // Stage 2: AI Extracting
      console.log(`[Job ${jobId}] 🤖 [${i + 1}/${files.length}] AI Extracting...`);
      pdfEntry.status = "extracting";
      pdfEntry.message = "AI Extracting data...";
      pdfEntry.progress = 50;
      activeJobs.set(jobId, job);

      const parsedData = await supplyBillService.parseSupplyBill(file.path);
      console.log(`[Job ${jobId}] ✅ [${i + 1}/${files.length}] Parsed via: ${parsedData._extraction_method ?? "unknown"}`);
      delete parsedData._extraction_method; // don't persist internal flag to DB

      // Stage 3: Saving to DB
      console.log(`[Job ${jobId}] 💾 [${i + 1}/${files.length}] Saving to DB...`);
      pdfEntry.status = "saving";
      pdfEntry.message = "Saving to database...";
      pdfEntry.progress = 80;
      activeJobs.set(jobId, job);

      const invoiceIdStr = uuidv4();
      const invoiceDoc = {
        job_id: jobId,
        invoice_id: invoiceIdStr,
        pdf_url: `/api/uploads/${file.filename}`, // served as static by Express at /api/uploads
        invoice_metadata: parsedData.invoice_metadata || {},
        seller: parsedData.seller || {},
        buyer: parsedData.buyer || {},
        consignee: parsedData.consignee || {},
        gst_details: parsedData.gst_details || {},
        totals: parsedData.totals || {},
        payments: parsedData.payments || [],
        shipping: parsedData.shipping || {},
        document_info: parsedData.document_info || {},
        po_id: null,
        created_at: new Date()
      };
      await db.collection("invoices").insertOne(invoiceDoc);

      if (parsedData.line_items && parsedData.line_items.length > 0) {
        const itemsToInsert = parsedData.line_items.map((item, index) => ({
          ...item,
          line_item_id: uuidv4(),
          invoice_id: invoiceIdStr,
          job_id: jobId,
          line_number: index + 1
        }));
        await db.collection("invoice_line_items").insertMany(itemsToInsert);
        console.log(`[Job ${jobId}] 📦 [${i + 1}/${files.length}] Saved ${itemsToInsert.length} line items`);
      }

      // Stage 4: Done
      pdfEntry.status = "completed";
      pdfEntry.message = "Successfully parsed";
      pdfEntry.progress = 100;
      pdfEntry.invoice_id = invoiceIdStr;
      pdfEntry.line_items = parsedData.line_items?.length || 0;
      pdfEntry.total_amount = parsedData.totals?.invoice_amount || 0;
      job.completed_files += 1;
      
      console.log(`[Job ${jobId}] ✨ [${i + 1}/${files.length}] COMPLETED: ${invoiceIdStr}`);

    } catch (error) {
      console.error(`[Job ${jobId}] ❌ [${i + 1}/${files.length}] FAILED:`, error);
      pdfEntry.status = "failed";
      pdfEntry.message = error.message;
      pdfEntry.progress = 100;
      job.failed_files += 1;
    }

    job.progress = Math.round(((i + 1) / files.length) * 100);
    activeJobs.set(jobId, job);
  }

  job.status = "completed";
  activeJobs.set(jobId, job);
  console.log(`[Job ${jobId}] 🏁 ALL FILES PROCESSED. Success: ${job.completed_files}, Failed: ${job.failed_files}\n`);
}

exports.getJobStatus = (req, res) => {
  const jobId = req.params.job_id;
  
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const flushPadding = " ".repeat(4096); // Forces Nginx to push stream instantly

  const interval = setInterval(() => {
    const job = activeJobs.get(jobId);
    if (!job) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Job not found" })}\n\n`);
      return res.end();
    }

    res.write(`event: progress\ndata: ${JSON.stringify(job)}\n:${flushPadding}\n\n`);

    if (job.status === "completed" || job.status === "failed") {
      res.write(`event: complete\ndata: ${JSON.stringify(job)}\n:${flushPadding}\n\n`);
      clearInterval(interval);
      return res.end();
    }
  }, 1000);

  req.on("close", () => clearInterval(interval));
};

// Simple JSON polling endpoint — no SSE, just returns current job state
exports.getJobStatusJson = (req, res) => {
  const jobId = req.params.job_id;
  const job = activeJobs.get(jobId);
  if (!job) return sendError(res, "Job not found", 404);
  return sendSuccess(res, job);
};

// ─── GET PARSED DATA for a single invoice (by invoice_id UUID) ───
// Used by ParsedDataModal on the supply-bill page
exports.getParsedData = async (req, res) => {
  try {
    const { invoice_id } = req.params;
    const db = await getDb();

    const invoice = await db.collection("invoices").findOne({ invoice_id });
    if (!invoice) return sendError(res, "Invoice not found", 404);

    const lineItems = await db.collection("invoice_line_items")
      .find({ invoice_id })
      .sort({ line_number: 1 })
      .toArray();

    return sendSuccess(res, {
      invoice_metadata: invoice.invoice_metadata || {},
      seller:           invoice.seller || {},
      buyer:            invoice.buyer || {},
      consignee:        invoice.consignee || {},
      gst_details:      invoice.gst_details || {},
      totals:           invoice.totals || {},
      shipping:         invoice.shipping || {},
      document_info:    invoice.document_info || {},
      pdf_url:          invoice.pdf_url || null,
      line_items:       lineItems,
    });
  } catch (err) {
    console.error("getParsedData error:", err);
    return sendError(res, "Failed to fetch parsed data");
  }
};

// ─── LINK / UNLINK invoice to a Purchase Order ───
exports.linkToPO = async (req, res) => {
  try {
    const { id } = req.params;        // invoice_id UUID
    const { po_id } = req.body;       // null to unlink

    const db = await getDb();
    const result = await db.collection("invoices").updateOne(
      { invoice_id: id },
      { $set: { po_id: po_id || null } }
    );

    if (result.matchedCount === 0) return sendError(res, "Invoice not found", 404);
    return sendSuccess(res, { invoice_id: id, po_id: po_id || null });
  } catch (err) {
    console.error("linkToPO error:", err);
    return sendError(res, "Failed to update PO link");
  }
};



exports.downloadExcel = async (req, res) => {
  try {
    const jobId = req.params.job_id;
    const db = await getDb();
    
    // Fetch all invoices for this job
    const invoices = await db.collection("invoices").find({ job_id: jobId }).toArray();
    
    if (!invoices || invoices.length === 0) {
      return sendError(res, "No invoices found for this job.", 404);
    }
    
    const lineItems = await db.collection("invoice_line_items").find({ job_id: jobId }).toArray();
    
    // Flatten data
    const rows = [];
    
    invoices.forEach(inv => {
      const invItems = lineItems.filter(item => item.invoice_id === inv.invoice_id);
      
      const invMeta = inv.invoice_metadata || {};
      const seller = inv.seller || {};
      const buyer = inv.buyer || {};
      const totals = inv.totals || {};
      
      if (invItems.length === 0) {
        invItems.push({});
      }
      
      invItems.forEach((item, idx) => {
        rows.push({
          Invoice_Number: invMeta.invoice_number,
          Invoice_Date: invMeta.invoice_date,
          IRN_Number: invMeta.irn_number,
          Acknowledgement_Number: invMeta.acknowledgement_number,
          Acknowledgement_Date: invMeta.acknowledgement_date,
          
          Seller_Name: seller.name,
          Seller_Trade_Name: seller.trade_name,
          Seller_City: seller.city,
          Seller_State: seller.state,
          Seller_GSTIN: seller.gstin,
          Seller_PAN: seller.pan,
          
          Buyer_Name: buyer.name,
          Buyer_Trade_Name: buyer.trade_name,
          Buyer_City: buyer.city,
          Buyer_State: buyer.state,
          Buyer_GSTIN: buyer.gstin,
          Buyer_PAN: buyer.pan,
          
          Line_Number: item.line_number || (idx + 1),
          Description: item.description,
          Part_Code: item.part_number,
          HSN_Code: item.hsn_code,
          Quantity: item.quantity,
          Unit: item.unit,
          Unit_Price: item.unit_price,
          Discount_Percent: item.discount_percent,
          Base_Amount: item.base_amount,
          
          CGST_Rate: item.cgst_rate,
          CGST_Amount: item.cgst,
          SGST_Rate: item.sgst_rate,
          SGST_Amount: item.sgst,
          IGST_Rate: item.igst_rate,
          IGST_Amount: item.igst,
          Total_GST: item.total_gst,
          
          Amount_Incl_GST: item.amount_incl_gst,
          
          Invoice_Taxable_Value: totals.total_taxable_value,
          Invoice_Total_CGST: totals.cgst_total,
          Invoice_Total_SGST: totals.sgst_total,
          Invoice_Total_IGST: totals.igst_total,
          Invoice_Total_GST: totals.total_gst,
          Invoice_Grand_Total: totals.invoice_amount,
          Invoice_Item_Count: totals.total_line_items_count
        });
      });
    });
    
    // Create workbook and worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Invoices');
    
    // Define columns
    const columns = [
      { header: 'Invoice_Number', key: 'Invoice_Number', width: 20 },
      { header: 'Invoice_Date', key: 'Invoice_Date', width: 15 },
      { header: 'IRN_Number', key: 'IRN_Number', width: 25 },
      { header: 'Acknowledgement_Number', key: 'Acknowledgement_Number', width: 25 },
      { header: 'Acknowledgement_Date', key: 'Acknowledgement_Date', width: 20 },
      { header: 'Seller_Name', key: 'Seller_Name', width: 30 },
      { header: 'Seller_Trade_Name', key: 'Seller_Trade_Name', width: 30 },
      { header: 'Seller_City', key: 'Seller_City', width: 20 },
      { header: 'Seller_State', key: 'Seller_State', width: 20 },
      { header: 'Seller_GSTIN', key: 'Seller_GSTIN', width: 20 },
      { header: 'Seller_PAN', key: 'Seller_PAN', width: 15 },
      { header: 'Buyer_Name', key: 'Buyer_Name', width: 30 },
      { header: 'Buyer_Trade_Name', key: 'Buyer_Trade_Name', width: 30 },
      { header: 'Buyer_City', key: 'Buyer_City', width: 20 },
      { header: 'Buyer_State', key: 'Buyer_State', width: 20 },
      { header: 'Buyer_GSTIN', key: 'Buyer_GSTIN', width: 20 },
      { header: 'Buyer_PAN', key: 'Buyer_PAN', width: 15 },
      { header: 'Line_Number', key: 'Line_Number', width: 15 },
      { header: 'Description', key: 'Description', width: 40 },
      { header: 'Part_Code', key: 'Part_Code', width: 20 },
      { header: 'HSN_Code', key: 'HSN_Code', width: 15 },
      { header: 'Quantity', key: 'Quantity', width: 10 },
      { header: 'Unit', key: 'Unit', width: 10 },
      { header: 'Unit_Price', key: 'Unit_Price', width: 15 },
      { header: 'Discount_Percent', key: 'Discount_Percent', width: 15 },
      { header: 'Base_Amount', key: 'Base_Amount', width: 15 },
      { header: 'CGST_Rate', key: 'CGST_Rate', width: 15 },
      { header: 'CGST_Amount', key: 'CGST_Amount', width: 15 },
      { header: 'SGST_Rate', key: 'SGST_Rate', width: 15 },
      { header: 'SGST_Amount', key: 'SGST_Amount', width: 15 },
      { header: 'IGST_Rate', key: 'IGST_Rate', width: 15 },
      { header: 'IGST_Amount', key: 'IGST_Amount', width: 15 },
      { header: 'Total_GST', key: 'Total_GST', width: 15 },
      { header: 'Amount_Incl_GST', key: 'Amount_Incl_GST', width: 15 },
      { header: 'Invoice_Taxable_Value', key: 'Invoice_Taxable_Value', width: 20 },
      { header: 'Invoice_Total_CGST', key: 'Invoice_Total_CGST', width: 20 },
      { header: 'Invoice_Total_SGST', key: 'Invoice_Total_SGST', width: 20 },
      { header: 'Invoice_Total_IGST', key: 'Invoice_Total_IGST', width: 20 },
      { header: 'Invoice_Total_GST', key: 'Invoice_Total_GST', width: 20 },
      { header: 'Invoice_Grand_Total', key: 'Invoice_Grand_Total', width: 20 },
      { header: 'Invoice_Item_Count', key: 'Invoice_Item_Count', width: 15 }
    ];
    worksheet.columns = columns;
    
    // Add rows
    worksheet.addRows(rows);
    
    // Format headers
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD3D3D3' }
    };
    headerRow.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    
    // Number formats
    const currencyFormat = '₹#,##0.00';
    const percentFormat = '0.00%';
    
    const currencyCols = [
      'Unit_Price', 'Base_Amount', 'CGST_Amount', 'SGST_Amount', 'IGST_Amount', 'Total_GST', 'Amount_Incl_GST',
      'Invoice_Taxable_Value', 'Invoice_Total_CGST', 'Invoice_Total_SGST', 'Invoice_Total_IGST', 'Invoice_Total_GST', 'Invoice_Grand_Total'
    ];
    
    const percentCols = ['Discount_Percent', 'CGST_Rate', 'SGST_Rate', 'IGST_Rate'];
    
    columns.forEach((col, idx) => {
      if (currencyCols.includes(col.key)) {
        worksheet.getColumn(idx + 1).numFmt = currencyFormat;
      } else if (percentCols.includes(col.key)) {
        worksheet.getColumn(idx + 1).numFmt = percentFormat;
      }
    });
    
    // Send to client
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=consolidated_invoices_${timestamp}.xlsx`);
    
    await workbook.xlsx.write(res);
    res.end();
    
  } catch (err) {
    console.error("Error generating Excel:", err);
    return sendError(res, "Failed to generate Excel file");
  }
};