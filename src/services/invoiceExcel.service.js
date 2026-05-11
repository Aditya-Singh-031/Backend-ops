const { getDb } = require("../config/db");
const ExcelJS = require("exceljs");

exports.generateJobExcel = async (jobId) => {
  const db = await getDb();
  
  const invoices = await db.collection("invoices").find({ job_id: jobId }).toArray();
  if (!invoices || invoices.length === 0) throw new Error("No invoices found for this job.");
  
  const lineItems = await db.collection("invoice_line_items").find({ job_id: jobId }).toArray();
  
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
  
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Invoices');
  
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
  worksheet.addRows(rows);
  
  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };
  headerRow.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  
  const currencyFormat = '₹#,##0.00';
  const percentFormat = '0.00%';
  const currencyCols = ['Unit_Price', 'Base_Amount', 'CGST_Amount', 'SGST_Amount', 'IGST_Amount', 'Total_GST', 'Amount_Incl_GST', 'Invoice_Taxable_Value', 'Invoice_Total_CGST', 'Invoice_Total_SGST', 'Invoice_Total_IGST', 'Invoice_Total_GST', 'Invoice_Grand_Total'];
  const percentCols = ['Discount_Percent', 'CGST_Rate', 'SGST_Rate', 'IGST_Rate'];
  
  columns.forEach((col, idx) => {
    if (currencyCols.includes(col.key)) worksheet.getColumn(idx + 1).numFmt = currencyFormat;
    else if (percentCols.includes(col.key)) worksheet.getColumn(idx + 1).numFmt = percentFormat;
  });
  
  return workbook;
};