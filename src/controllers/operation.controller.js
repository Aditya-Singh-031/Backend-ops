const { getDb } = require("../config/db");
const ExcelJS = require("exceljs");
const { sendSuccess, sendError } = require("../utils/response");

exports.getList = async (req, res) => {
  try {
    const db = await getDb();
    const combinedList = [];

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
        const qty      = parseFloat(item.quantity)         || 0;
        const price    = parseFloat(item.unit_price)       || 0;
        const discPct  = parseFloat(item.discount_percent) || 0;

        const baseLineCost    = price * qty;
        const discountedRate  = price * (1 - discPct / 100);
        const finalLineCost   = discountedRate * qty;

        calcTotalMrp  += baseLineCost;
        calcTotalCost += finalLineCost;
      }

      const totalDiscount    = calcTotalMrp - calcTotalCost;
      const finalTotalWithGst = calcTotalCost + totalDiscount;

      let safeTimestamp = doc.created_at;
      if (safeTimestamp instanceof Date) {
        safeTimestamp = safeTimestamp.toISOString();
      } else {
        safeTimestamp = String(safeTimestamp);
      }

      const vendorName    = doc.seller?.name || doc.vendor_name || "Unknown";
      const invoiceNumber = doc.invoice_metadata?.invoice_number || doc.invoice_number || "N/A";
      const invoiceDate   = doc.invoice_metadata?.invoice_date   || doc.invoice_date   || "N/A";
      const totalAmount   = doc.totals?.total_parts_amount  || calcTotalMrp;
      const totalCost     = doc.totals?.total_taxable_value || calcTotalCost;
      const totalWithGst  = doc.totals?.invoice_amount      || finalTotalWithGst;

      combinedList.push({
        id:               invoiceIdStr,
        invoice_id:       invoiceIdStr,
        filename:         doc.pdf_url ? doc.pdf_url.split("/").pop() : "Unknown",
        vendor_name:      vendorName,
        invoice_number:   invoiceNumber,
        invoice_date:     invoiceDate,
        total_amount:     totalAmount,
        total_cost:       totalCost,
        total_discount:   totalDiscount,
        total_with_gst:   totalWithGst,
        status:           "completed",
        upload_timestamp: safeTimestamp,
        pdf_url:          doc.pdf_url,
        is_temp:          false,
        po_id:            doc.po_id ? String(doc.po_id) : null,
      });
    }

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

    const db        = await getDb();
    const invoices  = await db.collection("invoices").find({ invoice_id: { $in: invoice_ids } }).toArray();
    const lineItems = await db.collection("invoice_line_items").find({ invoice_id: { $in: invoice_ids } }).toArray();

    const workbook  = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Invoices");

    const COLUMNS = [
      { header: "#",            key: "Line_Number",      width: 5  },
      { header: "Qty",          key: "Quantity",         width: 10 },
      { header: "Unit Price",   key: "Unit_Price",       width: 13 },
      { header: "Disc%",        key: "Discount_Percent", width: 8  },
      { header: "Taxable",      key: "Taxable_Value",    width: 14 },
      { header: "CGST%",        key: "CGST_Rate",        width: 8  },
      { header: "SGST%",        key: "SGST_Rate",        width: 8  },
      { header: "Total w/ GST", key: "Amount_Incl_GST",  width: 15 },
    ];

    const NUMERIC_KEYS = [
      "Quantity", "Unit_Price", "Discount_Percent", "Taxable_Value",
      "CGST_Rate", "SGST_Rate", "Amount_Incl_GST",
    ];

    const fmtNum    = (n) => (n != null && n !== "" ? Number(n) : null);
    const fmtNoZero = (n) => (n != null && n !== "" && Number(n) !== 0 ? Number(n) : null);

    worksheet.columns = COLUMNS;

    const BORDER = { style: "thin", color: { argb: "FF000000" } }; 
    const BOX    = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };

    // ── Global Header Row ──
    const headerRow = worksheet.getRow(1);
    headerRow.values = COLUMNS.map(c => c.header);
    headerRow.height = 25;
    headerRow.eachCell((cell) => {
      cell.font      = { bold: true, size: 11, color: { argb: "FF000000" } };
      cell.border    = BOX;
      cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    const numCols = COLUMNS.length;

    invoices.forEach((inv) => {
      const invItems = lineItems.filter((item) => item.invoice_id === inv.invoice_id);
      if (invItems.length === 0) return;

      const invMeta = inv.invoice_metadata || {};
      const seller  = inv.seller           || {};
      const totals  = inv.totals           || {};

      const dispInvNum = invMeta.invoice_number || inv.invoice_number || "N/A";
      const dispSeller = seller.name            || inv.vendor_name    || "Unknown Vendor";

      // ── Invoice Section Title Row ──
      const titleRow = worksheet.addRow([`Invoice: ${dispInvNum} | Seller: ${dispSeller}`]);
      worksheet.mergeCells(titleRow.number, 1, titleRow.number, numCols);
      titleRow.getCell(1).font      = { bold: true, size: 11, color: { argb: "FF000000" } };
      titleRow.getCell(1).fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9F9F9" } };
      titleRow.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
      titleRow.getCell(1).border    = BOX;
      titleRow.height = 22;

      // Calculate totals fallback
      let calcSubTotal = 0, calcDiscount = 0, calcTaxable = 0;
      invItems.forEach(item => {
        const q = fmtNum(item.quantity) || 0, p = fmtNum(item.unit_price) || 0, d = fmtNum(item.discount_percent) || 0;
        calcSubTotal += (p * q);
        calcDiscount += (p * q * d / 100);
        calcTaxable  += (fmtNum(item.base_amount) || 0);
      });

      // Line items
      invItems.forEach((item, idx) => {
        const row = worksheet.addRow([
          item.line_number || (idx + 1),
          fmtNum(item.quantity),
          fmtNum(item.unit_price),
          fmtNoZero(item.discount_percent),
          fmtNum(item.base_amount),
          fmtNum(item.cgst_rate),
          fmtNum(item.sgst_rate),
          fmtNum(item.amount_incl_gst),
        ]);
        row.height = 20;
        row.eachCell({ includeEmpty: true }, (cell, colNum) => {
          cell.border = BOX;
          cell.alignment = { vertical: "middle" };
          const col = COLUMNS[colNum - 1];
          if (col && NUMERIC_KEYS.includes(col.key)) {
            cell.numFmt = (col.key === "Quantity") ? "#,##0" : "#,##0.00";
            cell.alignment.horizontal = "right";
          } else {
            cell.alignment.horizontal = (col && col.key === "Line_Number") ? "center" : "left";
          }
        });
      });

      // Summary
      const grandTotal = fmtNum(totals.invoice_amount) || fmtNum(inv.total_with_gst) || fmtNum(inv.total_amount);
      const calcTotalGst = (fmtNum(totals.cgst_total) || 0) + (fmtNum(totals.sgst_total) || 0) + (fmtNum(totals.igst_total) || 0);

      const totalsData = [
        { label: "Sub Total (MRP)",  value: fmtNum(totals.total_parts_amount)    || calcSubTotal },
        { label: "Total Discount",   value: fmtNum(totals.total_discount_amount) || calcDiscount },
        { label: "Taxable Value",    value: fmtNum(totals.total_taxable_value)   || calcTaxable  },
        { label: "CGST",             value: fmtNum(totals.cgst_total)            },
        { label: "SGST",             value: fmtNum(totals.sgst_total)            },
        { label: "Total GST",        value: fmtNum(totals.total_gst)             || calcTotalGst },
        { label: "Other Charges",    value: fmtNum(totals.other_charges)         },
        { label: "GRAND TOTAL",      value: grandTotal, isBold: true             },
      ];

      totalsData.forEach(({ label, value, isBold }) => {
        // Always show tax labels (CGST, SGST) even if 0. 
        // For others, hide if null or 0 (unless bold).
        const isTaxLabel = ["CGST", "SGST", "Total GST"].includes(label);
        if (!isBold && !isTaxLabel && (value == null || Number(value) === 0)) return;
        if (value == null && !isBold) return;

        const tRow = worksheet.addRow([]);
        const vals = new Array(numCols).fill(null);
        vals[0] = label; vals[numCols - 1] = value;
        tRow.values = vals;
        tRow.height = isBold ? 26 : 20;
        for (let c = 1; c <= numCols; c++) { tRow.getCell(c).border = BOX; tRow.getCell(c).alignment = { vertical: "middle" }; }
        worksheet.mergeCells(tRow.number, 1, tRow.number, numCols - 1);
        tRow.getCell(1).font = { bold: true, size: isBold ? 11 : 10, color: { argb: "FF000000" } };
        tRow.getCell(1).alignment = { horizontal: "right", vertical: "middle" };
        const vCell = tRow.getCell(numCols);
        vCell.numFmt = "#,##0.00";
        vCell.font = { bold: true, size: isBold ? 12 : 10, color: { argb: "FF000000" } };
        vCell.alignment = { horizontal: "right", vertical: "middle" };
        if (isBold) vCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
      });

      worksheet.addRow([]).height = 12; // Separator
    });

    worksheet.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];
    const timestamp = Date.now();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=Bulk_Export_${timestamp}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Export Selected Error:", error);
    return sendError(res, "Failed to export invoices");
  }
};