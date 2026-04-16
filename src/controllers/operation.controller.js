const { getDb } = require("../config/db");

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

      combinedList.push({
        id: invoiceIdStr,
        invoice_id: invoiceIdStr,
        filename: doc.pdf_url ? doc.pdf_url.split('/').pop() : "Unknown",
        vendor_name: doc.vendor_name || "Unknown",
        invoice_number: doc.invoice_number || "N/A",
        invoice_date: doc.invoice_date || "N/A",
        total_amount: calcTotalMrp,
        total_cost: calcTotalCost,
        total_discount: totalDiscount,
        total_with_gst: finalTotalWithGst,
        status: "completed",
        upload_timestamp: safeTimestamp,
        pdf_url: doc.pdf_url,
        is_temp: false,
        po_id: doc.po_id ? String(doc.po_id) : null
      });
    }

    // 💥 CRITICAL: Return RAW array using res.json() to prevent the .filter crash in React
    return res.status(200).json(combinedList);
  } catch (error) {
    console.error("Operations List Error:", error);
    return res.status(500).json([]);
  }
};