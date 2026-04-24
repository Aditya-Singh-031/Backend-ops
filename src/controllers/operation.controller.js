const { getDb } = require("../config/db");
const ExcelJS = require("exceljs");
const { sendSuccess, sendError } = require("../utils/response");

exports.getList = async (req, res) => {
  try {
    const db = await getDb();
    const combinedList = [];

    // Fetch invoices from MongoDB (Matching Python's limit and sort)
    const invoices = await db.collection("invoices")
      .find()
      .sort({ created_at: -1 })
      .limit(200)
      .toArray();

    for (const doc of invoices) {
      const invoiceIdStr = String(doc.invoice_id);
      
      const lineItems = await db.collection("invoice_line_items")
        .find({ invoice_id: invoiceIdStr })
        .toArray();

      let calcTotalMrp = 0.0;
      let calcTotalCost = 0.0;

      for (const item of lineItems) {
        const qty = parseFloat(item.quantity) || 0;
        const price = parseFloat(item.unit_price) || 0;
        const discPct = parseFloat(item.discount_percent) || 0;

        const baseLineCost = price * qty;
        const discountedRate = price * (1 - (discPct / 100));
        const finalLineCost = discountedRate * qty;

        calcTotalMrp += baseLineCost;
        calcTotalCost += finalLineCost;
      }

      const totalDiscount = calcTotalMrp - calcTotalCost;
      const finalTotalWithGst = calcTotalCost + totalDiscount;

      // Safely parse timestamps just like Python
      let safeTimestamp = doc.created_at;
      if (safeTimestamp instanceof Date) {
        safeTimestamp = safeTimestamp.toISOString();
      } else {
        safeTimestamp = String(safeTimestamp);
      }

      // 💥 THE FIX: Map the deep nested JSON schema fields to the flat keys expected by the frontend table
      const vendorName = doc.seller?.name || doc.vendor_name || "Unknown";
      const invoiceNumber = doc.invoice_metadata?.invoice_number || doc.invoice_number || "N/A";
      const invoiceDate = doc.invoice_metadata?.invoice_date || doc.invoice_date || "N/A";

      // If the schema parsed total_parts_amount and invoice_amount correctly, use them. Else fallback to calculated.
      const totalAmount = doc.totals?.total_parts_amount || calcTotalMrp;
      const totalCost = doc.totals?.total_taxable_value || calcTotalCost;
      const totalWithGst = doc.totals?.invoice_amount || finalTotalWithGst;

      combinedList.push({
        id: invoiceIdStr,
        invoice_id: invoiceIdStr,
        filename: doc.pdf_url ? doc.pdf_url.split('/').pop() : "Unknown",
        vendor_name: vendorName,
        invoice_number: invoiceNumber,
        invoice_date: invoiceDate,
        total_amount: totalAmount,
        total_cost: totalCost,
        total_discount: totalDiscount,
        total_with_gst: totalWithGst,
        status: "completed",
        upload_timestamp: safeTimestamp,
        pdf_url: doc.pdf_url,
        is_temp: false,
        po_id: doc.po_id ? String(doc.po_id) : null
      });
    }

    // 💥 CRITICAL: Return RAW array using res.json() to prevent the .filter crash in React
    return sendSuccess(res, combinedList);
  } catch (error) {
    console.error("Operations List Error:", error);
    return sendError(res, "Failed to fetch operations list");
  }
};

// ─── DELETE SELECTED INVOICES ───
exports.deleteSelected = async (req, res) => {
  try {
    const { invoice_ids } = req.body;
    if (!invoice_ids || !Array.isArray(invoice_ids) || invoice_ids.length === 0) {
      return sendError(res, "No invoice_ids provided", 400);
    }

    const db = await getDb();

    // Delete invoices and their line items
    await db.collection("invoices").deleteMany({ invoice_id: { $in: invoice_ids } });
    await db.collection("invoice_line_items").deleteMany({ invoice_id: { $in: invoice_ids } });

    return sendSuccess(res, { deleted: invoice_ids.length });
  } catch (error) {
    console.error("Delete Selected Error:", error);
    return sendError(res, "Failed to delete invoices");
  }
};

// ─── EXPORT SELECTED INVOICES TO EXCEL ───
exports.exportSelected = async (req, res) => {
  try {
    const { invoice_ids } = req.body;
    if (!invoice_ids || !Array.isArray(invoice_ids) || invoice_ids.length === 0) {
      return sendError(res, "No invoice_ids provided", 400);
    }

    const db = await getDb();
    const invoices = await db.collection("invoices").find({ invoice_id: { $in: invoice_ids } }).toArray();
    const lineItems = await db.collection("invoice_line_items").find({ invoice_id: { $in: invoice_ids } }).toArray();

    const rows = [];
    invoices.forEach(inv => {
      const invItems = lineItems.filter(item => item.invoice_id === inv.invoice_id);
      const invMeta = inv.invoice_metadata || {};
      const seller = inv.seller || {};
      const buyer = inv.buyer || {};
      const totals = inv.totals || {};

      if (invItems.length === 0) invItems.push({});

      invItems.forEach((item, idx) => {
        rows.push({
          Invoice_Number: invMeta.invoice_number,
          Invoice_Date: invMeta.invoice_date,
          Seller_Name: seller.name,
          Seller_GSTIN: seller.gstin,
          Buyer_Name: buyer.name,
          Buyer_GSTIN: buyer.gstin,
          Line_Number: item.line_number || (idx + 1),
          Description: item.description,
          Part_Code: item.part_number,
          HSN_Code: item.hsn_code,
          Quantity: item.quantity,
          Unit: item.unit,
          Unit_Price: item.unit_price,
          Discount_Percent: item.discount_percent,
          Base_Amount: item.base_amount,
          CGST_Amount: item.cgst,
          SGST_Amount: item.sgst,
          IGST_Amount: item.igst,
          Total_GST: item.total_gst,
          Amount_Incl_GST: item.amount_incl_gst,
          Invoice_Grand_Total: totals.invoice_amount,
        });
      });
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Invoices");

    worksheet.columns = Object.keys(rows[0] || {}).map(key => ({
      header: key, key, width: 20
    }));
    worksheet.addRows(rows);

    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD3D3D3" } };

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=export_${timestamp}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Export Selected Error:", error);
    return sendError(res, "Failed to export invoices");
  }
};