const { v4: uuidv4 } = require("uuid");
const { getDb } = require("../config/db");
const aiService = require("../services/ai.service");
const fs = require("fs");

// In-memory job tracker (replaces Redis for immediate frontend feedback)
const activeJobs = new Map();

exports.uploadInvoices = async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) return res.status(400).json({ error: "No files uploaded" });

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
  
  // Respond instantly so UI shows "Processing..."
  res.json({ job_id: jobId, message: "Processing started", total_files: files.length });

  // Process in background
  processJobBackground(jobId, files).catch(console.error);
};

async function processJobBackground(jobId, files) {
  const job = activeJobs.get(jobId);
  const db = await getDb();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const pdfEntry = job.pdfs[String(i)];
    
    pdfEntry.status = "parsing";
    pdfEntry.message = "AI Extracting data...";
    activeJobs.set(jobId, job);

    try {
      // 1. Extract via OpenAI
      const parsedData = await aiService.parseInvoiceFile(file.path);
      
      // 2. Save Invoice to DB
      const invoiceIdStr = uuidv4(); 
      const invoiceDoc = {
        invoice_id: invoiceIdStr,
        pdf_url: `/uploads/${file.filename}`, 
        vendor_name: parsedData.vendor_name || "Unknown",
        invoice_number: parsedData.invoice_number || "N/A",
        invoice_date: parsedData.invoice_date || "N/A",
        po_id: null,
        created_at: new Date()
      };
      await db.collection("invoices").insertOne(invoiceDoc);

      // 3. Save Line Items to DB
      if (parsedData.line_items && parsedData.line_items.length > 0) {
        const itemsToInsert = parsedData.line_items.map(item => ({
          invoice_id: invoiceIdStr,
          ...item
        }));
        await db.collection("invoice_line_items").insertMany(itemsToInsert);
      }

      // 4. Update Status
      pdfEntry.status = "completed";
      pdfEntry.message = "Successfully parsed";
      pdfEntry.line_items = parsedData.line_items?.length || 0;
      pdfEntry.total_amount = parsedData.invoice_amount || 0;
      job.completed_files += 1;

    } catch (error) {
      console.error(`File parsing error:`, error);
      pdfEntry.status = "failed";
      pdfEntry.error = error.message;
      job.failed_files += 1;
    }

    job.progress = Math.round(((i + 1) / files.length) * 100);
    activeJobs.set(jobId, job);
  }

  job.status = "completed";
  activeJobs.set(jobId, job);
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

// Placeholder for Step 2: Will build full Excel logic next
exports.downloadExcel = async (req, res) => {
  res.status(400).json({ error: "Excel export migrating to Node.js next." });
};