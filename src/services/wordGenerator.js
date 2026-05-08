const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, VerticalAlign, BorderStyle, ShadingType,
  Header, Footer, TableLayoutType, ImageRun, PageOrientation
} = require('docx');
const fs = require('fs');
const path = require('path');

// --- HELPER FUNCTIONS ---

function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return `${d.getDate()}-${d.toLocaleString('en-US', { month: 'short' })}-${d.getFullYear()}`;
}

const DEFAULT_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 2, color: "000000" },
  bottom: { style: BorderStyle.SINGLE, size: 2, color: "000000" },
  left: { style: BorderStyle.SINGLE, size: 2, color: "000000" },
  right: { style: BorderStyle.SINGLE, size: 2, color: "000000" },
};

function cell(
  text,
  align = AlignmentType.CENTER,
  span = 1,
  bold = false,
  fontSize = 14,
  shading = null,
  color = "000000",
  width = null
) {
  const cellProps = {
    children: [
      new Paragraph({
        alignment: align,
        spacing: { before: 0, after: 0 },
        children: [new TextRun({ text: safeText(text, '-'), size: fontSize, bold, color })]
      })
    ],
    columnSpan: span,
    verticalAlign: VerticalAlign.CENTER,
    borders: DEFAULT_BORDERS
  };

  if (width) {
    cellProps.width = { size: width, type: WidthType.DXA };
  }

  if (shading) {
    cellProps.shading = { fill: shading, type: ShadingType.SOLID };
  }

  return new TableCell(cellProps);
}

function safeText(value, fallback = '-') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function optionalLabelValueParagraphs(pairs, options) {
  return pairs
    .filter((pair) => hasValue(pair.value))
    .map((pair) => labelValueParagraph(`${pair.label}: `, pair.value, options));
}

function pickCompanyField(company, keys) {
  if (!company) return '';
  for (const key of keys) {
    if (company[key]) return company[key];
  }
  return '';
}

function formatDateDisplay(date) {
  if (!date) return '-';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDeliveryTerms(value) {
  const deliveryTermsMap = {
    FOB: 'FOB (Free on Board)',
    EXW: 'EXW (Ex Works)',
    CFR: 'CFR (Cost and Freight)',
    CIF: 'CIF (Cost, Insurance & Freight)'
  };
  if (!value) return '-';
  return deliveryTermsMap[value] || value;
}

function getDispatchAddress(invoiceData) {
  const dispatchMap = {
    MUMBAI: "Ground Floor, Godown No. 25/B, Survey No.25/B, 26/1A1, 26/1A2, 25/1A & 26/1B, BLR Logistiks (I) Limited C/O M/S Forefront Logistics Pvt Ltd, Post Mothi Jui Uran, Taki Gaon Bus Stop, Dighode Chirner Road, Bhom, Raigad, Maharashtra 410206",
    SOLAPUR: "A/21/1, MIDC Chincholi, Solapur, Maharashtra - 413255"
  };
  const dispatchKey = String(invoiceData?.dispatchLocation || '').trim().toUpperCase();
  return safeText(
    invoiceData?.dispatchAddress || dispatchMap[dispatchKey] || invoiceData?.dispatchLocation,
    '-'
  );
}

function currencySymbol(label) {
  if (!label) return '';
  const normalized = String(label).toUpperCase();
  if (normalized.includes('₹') || normalized === 'INR') return '₹';
  if (normalized.includes('$') || normalized === 'USD') return '$';
  if (normalized === 'EUR') return '€';
  if (normalized === 'GBP') return '£';
  return '';
}

function formatMoney(value, currencyLabel) {
  const num = Number(value);
  const amount = Number.isFinite(num) ? num : 0;
  const formatted = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = currencySymbol(currencyLabel);
  return symbol ? `${symbol}${formatted}` : formatted;
}

function makeParagraph(text, { bold = false, size = 20, align = AlignmentType.LEFT, color = "000000" } = {}) {
  return new Paragraph({
    alignment: align,
    spacing: { before: 0, after: 0 },
    children: [new TextRun({ text: String(text || ''), bold, size, color })]
  });
}

function labelValueParagraph(label, value, { labelSize = 20, valueSize = 18 } = {}) {
  return new Paragraph({
    spacing: { before: 0, after: 0 },
    children: [
      new TextRun({ text: String(label || ''), bold: true, size: labelSize }),
      new TextRun({ text: safeText(value, '-'), size: valueSize })
    ]
  });
}

function labelValueRow(label, value, { labelSize = 20, valueSize = 20 } = {}) {
  return new TableRow({
    children: [
      new TableCell({
        children: [makeParagraph(label, { bold: true, size: labelSize })],
        width: { size: 2000, type: WidthType.DXA },
        verticalAlign: VerticalAlign.TOP,
        borders: DEFAULT_BORDERS
      }),
      new TableCell({
        children: [makeParagraph(safeText(value, '-'), { size: valueSize })],
        width: { size: 3000, type: WidthType.DXA },
        verticalAlign: VerticalAlign.TOP,
        borders: DEFAULT_BORDERS
      })
    ]
  });
}

// Helper to get company logo image buffer safely
function getImageBuffer() {
  try {
    const logoPath = path.join(__dirname, '..', 'assets', 'logo.png');
    if (fs.existsSync(logoPath)) {
      return fs.readFileSync(logoPath);
    }
  } catch (e) {
    // Logo not available — headers will be text-only
  }
  return null;
}

function getImageDimensions(buffer) {
  try {
    if (buffer[1] === 0x50 && buffer[2] === 0x4E) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }
  } catch(e) {}
  return { width: 200, height: 60 };
}

// =========================================================================
// 1. COMMERCIAL INVOICE GENERATOR (Standard)
// =========================================================================
async function generateWordInvoice(invoiceData, lineItems, currencyLabel = 'USD') {

  const headerChildren = [];
  const imgBuffer = getImageBuffer();
  if (imgBuffer) {
    headerChildren.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new ImageRun({ data: imgBuffer, transformation: { width: 173, height: 60 } })]
    }));
  }
  const header = new Header({ children: headerChildren });

  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: 'Morsebiz Technology Services Pvt Ltd', bold: true, size: 16 })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          text: 'Regd. Office: 20th Floor, Building No/Flat No – CTS No 95 4 B 3&4, 590 Oberoi Garden City, Goregaon East, Mumbai 400063 | CIN: U72900MH2021PTC362935',
          size: 14
        })]
      }),
    ]
  });

  const sectionChildren = [];

  sectionChildren.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 200 },
      children: [new TextRun({ text: 'COMMERCIAL INVOICE', bold: true, size: 24, underline: {} })]
    })
  );

  const exporter = invoiceData.exporter || {};
  const buyer = invoiceData.buyer || {};
  const consignee = invoiceData.consignee || {};

  const exporterGst = pickCompanyField(exporter, ['gstNo', 'gst_number', 'gstNumber', 'gstin', 'gstIn', 'gst']);
  const exporterPan = pickCompanyField(exporter, ['panNo', 'pan_no', 'panNumber', 'pan']);
  const exporterIec = pickCompanyField(exporter, ['iecCode', 'iec_code', 'iec']);

  const buyerIec = pickCompanyField(buyer, ['iecCode', 'iec_code', 'iec']);

  const consigneeGst = pickCompanyField(consignee, ['gstNo', 'gst_number', 'gstNumber', 'gstin', 'gstIn', 'gst']);
  const consigneePan = pickCompanyField(consignee, ['panNo', 'pan_no', 'panNumber', 'pan']);
  const consigneeIec = pickCompanyField(consignee, ['iecCode', 'iec_code', 'iec']);

  const dispatchFrom = getDispatchAddress(invoiceData);

  const exporterIdRows = optionalLabelValueParagraphs(
    [
      { label: 'GST', value: exporterGst },
      { label: 'PAN', value: exporterPan },
      { label: 'IEC', value: exporterIec }
    ],
    { labelSize: 18, valueSize: 18 }
  );

  const buyerIdRows = optionalLabelValueParagraphs(
    [{ label: 'IEC', value: buyerIec }],
    { labelSize: 18, valueSize: 18 }
  );

  const consigneeIdRows = optionalLabelValueParagraphs(
    [
      { label: 'GST', value: consigneeGst },
      { label: 'PAN', value: consigneePan },
      { label: 'IEC', value: consigneeIec }
    ],
    { labelSize: 18, valueSize: 18 }
  );

  const exporterInfoCell = new TableCell({
    children: [
      makeParagraph('Exporter / Shipper', { bold: true, size: 22 }),
      makeParagraph(safeText(exporter.name, ''), { bold: true, size: 20 }),
      ...(exporter.address ? [makeParagraph(exporter.address, { size: 18 })] : []),
      ...exporterIdRows
    ],
    verticalAlign: VerticalAlign.TOP,
    borders: DEFAULT_BORDERS
  });

  const dispatchCell = new TableCell({
    children: [labelValueParagraph('Dispatch From: ', dispatchFrom, { labelSize: 20, valueSize: 18 })],
    verticalAlign: VerticalAlign.TOP,
    borders: DEFAULT_BORDERS
  });

  const exporterTable = new Table({
    rows: [
      new TableRow({ children: [exporterInfoCell] }),
      new TableRow({ children: [dispatchCell] })
    ],
    width: { size: 5040, type: WidthType.DXA }
  });

  const invoiceInfoTable = new Table({
    rows: [
      labelValueRow('Invoice No.:', invoiceData.invoiceNumber),
      ...(invoiceData.replacementTo ? [labelValueRow('In Replacement of:', invoiceData.replacementTo)] : []),
      labelValueRow('Invoice Date:', formatDateDisplay(invoiceData.invoiceDate)),
      labelValueRow('Expiry Date:', formatDateDisplay(invoiceData.invoiceExpiryDate)),
      labelValueRow('Terms of Payment:', invoiceData.termsOfPayment || '-'),
      labelValueRow('Terms of Delivery:', formatDeliveryTerms(invoiceData.termsOfDelivery))
    ],
    width: { size: 5000, type: WidthType.DXA }
  });

  const shippingTable = new Table({
    rows: [
      labelValueRow('Pre-Carriage By:', invoiceData.preCarriageBy || '-'),
      labelValueRow('Place of Receipt:', invoiceData.placeOfReceipt || '-'),
      labelValueRow('Port of Loading:', invoiceData.portOfLoading || '-'),
      labelValueRow('Port of Discharge:', invoiceData.portOfDischarge || '-'),
      labelValueRow('Total Net Weight:', invoiceData.totalNetWeight ? `${invoiceData.totalNetWeight} KGS` : '-'),
      labelValueRow('Total Gross Weight:', invoiceData.totalGrossWeight ? `${invoiceData.totalGrossWeight} KGS` : '-'),
      labelValueRow('Total Packages:', invoiceData.numberOfPackages || '-')
    ],
    width: { size: 5000, type: WidthType.DXA }
  });

  const rightCellChildren = [
    invoiceInfoTable,
    new Paragraph({ text: '' }),
    makeParagraph('Shipping & Logistics', { bold: true, size: 22 }),
    shippingTable
  ];

  const topTable = new Table({
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [exporterTable],
            width: { size: 5040, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            borders: DEFAULT_BORDERS
          }),
          new TableCell({
            children: rightCellChildren,
            width: { size: 5040, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            borders: DEFAULT_BORDERS
          })
        ]
      })
    ],
    width: { size: 10080, type: WidthType.DXA }
  });

  sectionChildren.push(topTable);
  sectionChildren.push(new Paragraph({ text: '' }));

  const consigneeCellChildren = [
    makeParagraph('Consignee', { bold: true, size: 22 }),
    makeParagraph(safeText(consignee.name, ''), { bold: true, size: 20 }),
    ...(consignee.address ? [makeParagraph(consignee.address, { size: 18 })] : []),
    ...consigneeIdRows
  ];

  const buyerCellChildren = [
    makeParagraph('Buyer', { bold: true, size: 22 }),
    makeParagraph(safeText(buyer.name, ''), { bold: true, size: 20 }),
    ...(buyer.address ? [makeParagraph(buyer.address, { size: 18 })] : []),
    ...buyerIdRows
  ];

  const partiesTable = new Table({
    rows: [
      new TableRow({
        children: [
          new TableCell({ children: consigneeCellChildren, width: { size: 5040, type: WidthType.DXA }, verticalAlign: VerticalAlign.TOP, borders: DEFAULT_BORDERS }),
          new TableCell({ children: buyerCellChildren, width: { size: 5040, type: WidthType.DXA }, verticalAlign: VerticalAlign.TOP, borders: DEFAULT_BORDERS })
        ]
      })
    ],
    width: { size: 10080, type: WidthType.DXA }
  });

  sectionChildren.push(partiesTable);
  sectionChildren.push(new Paragraph({ text: '' }));

  // Items Table
  const headers = ['Sr', 'Ref No', 'Part No', 'Description of Goods', 'HSN/SAC', 'Qty', 'Rate', 'Amount'];
  const colWidths = [600, 2100, 1200, 2400, 1000, 700, 900, 1200];
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, idx) => cell(h, AlignmentType.CENTER, 1, true, 20, 'E0E0E0', '000000', colWidths[idx]))
  });

  const rows = [headerRow];
  let subtotalAmount = 0;

  const splitFobFreight = Boolean(invoiceData.splitFobFreight);
  const baseFreightCharges = Number(invoiceData.freightCharges) || 0;
  const baseInsuranceCharges = Number(invoiceData.insuranceCharges) || 0;
  const splitExtraVal = splitFobFreight ? (baseFreightCharges + baseInsuranceCharges) : 0;
  const baseTotal = lineItems.reduce((sum, item) => {
    const qty = Number(item.qty) || 0;
    const rate = Number(item.rate) || 0;
    const baseAmount = Number(item.amount);
    const amount = Number.isFinite(baseAmount) && baseAmount !== 0 ? baseAmount : qty * rate;
    return sum + amount;
  }, 0);

  const adjustedItems = lineItems.map((item) => {
    const qty = Number(item.qty) || 0;
    const rate = Number(item.rate) || 0;
    const baseAmount = Number(item.amount);
    const amount = Number.isFinite(baseAmount) && baseAmount !== 0 ? baseAmount : qty * rate;

    if (splitFobFreight && baseTotal > 0 && splitExtraVal > 0) {
      const extraShare = (amount / baseTotal) * splitExtraVal;
      const splitAmount = amount + extraShare;
      const splitRate = qty > 0 ? splitAmount / qty : rate;
      return { ...item, amount: splitAmount, rate: splitRate };
    }
    return { ...item, amount };
  });

  adjustedItems.forEach((item, i) => {
    const amount = Number(item.amount) || 0;
    subtotalAmount += amount;
    const rowShade = i % 2 === 1 ? 'F8F9FA' : null;
    rows.push(new TableRow({
      children: [
        cell(String(i + 1), AlignmentType.CENTER, 1, false, 18, rowShade, "000000", colWidths[0]),
        cell(item.refNo || '', AlignmentType.CENTER, 1, false, 15, rowShade, "000000", colWidths[1]),
        cell(item.partNo || '', AlignmentType.CENTER, 1, false, 18, rowShade, "000000", colWidths[2]),
        cell(item.description, AlignmentType.LEFT, 1, false, 14, rowShade, "000000", colWidths[3]),
        cell(item.hsn, AlignmentType.CENTER, 1, false, 18, rowShade, "000000", colWidths[4]),
        cell(item.qty !== undefined && item.qty !== null ? String(item.qty) : '', AlignmentType.CENTER, 1, false, 18, rowShade, "000000", colWidths[5]),
        cell(formatMoney(item.rate, currencyLabel), AlignmentType.CENTER, 1, false, 18, rowShade, "000000", colWidths[6]),
        cell(formatMoney(amount, currencyLabel), AlignmentType.CENTER, 1, false, 18, rowShade, "000000", colWidths[7]),
      ]
    }));
  });

  sectionChildren.push(new Table({
    rows,
    width: { size: 10080, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: colWidths
  }));

  sectionChildren.push(new Paragraph({ text: '' }));

  const freightCharges = splitFobFreight ? 0 : baseFreightCharges;
  const insuranceCharges = splitFobFreight ? 0 : baseInsuranceCharges;
  const deliveryTerms = String(invoiceData.termsOfDelivery || '').toUpperCase();
  const grandTotal = subtotalAmount + freightCharges + insuranceCharges;

  const totalsRows = [
    new TableRow({ children: [
      cell('Subtotal', AlignmentType.RIGHT, 1, false, 18),
      cell(formatMoney(subtotalAmount, currencyLabel), AlignmentType.CENTER, 1, false, 18)
    ]})
  ];

  if (!splitFobFreight && deliveryTerms !== 'EXW') {
    totalsRows.push(new TableRow({ children: [
      cell('FOB Value', AlignmentType.RIGHT, 1, false, 18),
      cell(formatMoney(freightCharges, currencyLabel), AlignmentType.CENTER, 1, false, 18)
    ]}));

    if (deliveryTerms === 'CFR' || deliveryTerms === 'CIF') {
      totalsRows.push(new TableRow({ children: [
        cell('Freight', AlignmentType.RIGHT, 1, false, 18),
        cell(formatMoney(freightCharges, currencyLabel), AlignmentType.CENTER, 1, false, 18)
      ]}));
    }

    if (deliveryTerms === 'CIF') {
      totalsRows.push(new TableRow({ children: [
        cell('Insurance', AlignmentType.RIGHT, 1, false, 18),
        cell(formatMoney(insuranceCharges, currencyLabel), AlignmentType.CENTER, 1, false, 18)
      ]}));
    }
  }

  totalsRows.push(new TableRow({ children: [
    cell('TOTAL', AlignmentType.RIGHT, 1, true, 20),
    cell(formatMoney(grandTotal, currencyLabel), AlignmentType.CENTER, 1, true, 20)
  ]}));

  const totalsTable = new Table({
    rows: totalsRows,
    width: { size: 4896, type: WidthType.DXA },
    alignment: AlignmentType.RIGHT
  });

  sectionChildren.push(totalsTable);

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 500, bottom: 500, left: 500, right: 500 } } },
      headers: { default: header },
      footers: { default: footer },
      children: sectionChildren
    }]
  });

  return await Packer.toBuffer(doc);
}

// =========================================================================
// 2. TAX INVOICE GENERATOR (Indian Govt Format)
// =========================================================================
async function generateTaxInvoiceWord(invoiceData, lineItems, exchangeRate) {
  const exRate = parseFloat(exchangeRate) || 1;

  const headerChildren = [];
  const imgBuffer = getImageBuffer();
  if (imgBuffer) {
    headerChildren.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new ImageRun({
        data: imgBuffer,
        transformation: { width: 200, height: 60 },
        altText: { description: 'Morsebiz Logo' }
      })]
    }));
  }
  const header = new Header({ children: headerChildren });

  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: 'Morsebiz Technology Services Pvt Ltd', bold: true, size: 16 })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          text: 'Regd. Office: 20th Floor, Building No/Flat No – CTS No 95 4 B 3&4, 590 Oberoi Garden City, Goregaon East, Mumbai 400063 | CIN: U72900MH2021PTC362935',
          size: 14
        })]
      }),
    ]
  });

  const sectionChildren = [];

  sectionChildren.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 100, after: 100 },
      children: [new TextRun({ text: 'TAX INVOICE', bold: true, size: 28, underline: {} })]
    })
  );

  const exporter = invoiceData.exporter || {};
  const buyer = invoiceData.buyer || {};
  const consignee = invoiceData.consignee || {};

  const exporterGst = pickCompanyField(exporter, ['gstNo', 'gst_number', 'gstNumber', 'gstin', 'gstIn', 'gst']);
  const exporterPan = pickCompanyField(exporter, ['panNo', 'pan_no', 'panNumber', 'pan']);
  const exporterIec = pickCompanyField(exporter, ['iecCode', 'iec_code', 'iec']);

  const buyerIec = pickCompanyField(buyer, ['iecCode', 'iec_code', 'iec']);

  const consigneeGst = pickCompanyField(consignee, ['gstNo', 'gst_number', 'gstNumber', 'gstin', 'gstIn', 'gst']);
  const consigneePan = pickCompanyField(consignee, ['panNo', 'pan_no', 'panNumber', 'pan']);
  const consigneeIec = pickCompanyField(consignee, ['iecCode', 'iec_code', 'iec']);

  const dispatchFrom = getDispatchAddress(invoiceData);

  const exporterIdRows = optionalLabelValueParagraphs(
    [
      { label: 'GST', value: exporterGst },
      { label: 'PAN', value: exporterPan },
      { label: 'IEC', value: exporterIec }
    ],
    { labelSize: 18, valueSize: 18 }
  );

  const buyerIdRows = optionalLabelValueParagraphs(
    [{ label: 'IEC', value: buyerIec }],
    { labelSize: 18, valueSize: 18 }
  );

  const consigneeIdRows = optionalLabelValueParagraphs(
    [
      { label: 'GST', value: consigneeGst },
      { label: 'PAN', value: consigneePan },
      { label: 'IEC', value: consigneeIec }
    ],
    { labelSize: 18, valueSize: 18 }
  );

  const exporterInfoCell = new TableCell({
    children: [
      makeParagraph('Exporter / Shipper', { bold: true, size: 22 }),
      makeParagraph(safeText(exporter.name, ''), { bold: true, size: 20 }),
      ...(exporter.address ? [makeParagraph(exporter.address, { size: 18 })] : []),
      ...exporterIdRows
    ],
    verticalAlign: VerticalAlign.TOP,
    borders: DEFAULT_BORDERS
  });

  const dispatchCell = new TableCell({
    children: [labelValueParagraph('Dispatch From: ', dispatchFrom, { labelSize: 20, valueSize: 18 })],
    verticalAlign: VerticalAlign.TOP,
    borders: DEFAULT_BORDERS
  });

  const exporterTable = new Table({
    rows: [
      new TableRow({ children: [exporterInfoCell] }),
      new TableRow({ children: [dispatchCell] })
    ],
    width: { size: 5040, type: WidthType.DXA }
  });

  const invoiceInfoTable = new Table({
    rows: [
      labelValueRow('Invoice No.:', invoiceData.invoiceNumber),
      labelValueRow('Invoice Date:', formatDateDisplay(invoiceData.invoiceDate)),
      labelValueRow('Exchange Rate:', `₹${exRate.toFixed(2)}`),
      labelValueRow('Terms of Payment:', invoiceData.termsOfPayment || '-'),
      labelValueRow('Terms of Delivery:', formatDeliveryTerms(invoiceData.termsOfDelivery))
    ],
    width: { size: 5000, type: WidthType.DXA }
  });

  const shippingTable = new Table({
    rows: [
      labelValueRow('Pre-Carriage By:', invoiceData.preCarriageBy || '-'),
      labelValueRow('Place of Receipt:', invoiceData.placeOfReceipt || '-'),
      labelValueRow('Port of Loading:', invoiceData.portOfLoading || '-'),
      labelValueRow('Port of Discharge:', invoiceData.portOfDischarge || '-'),
      labelValueRow('Total Net Weight:', invoiceData.totalNetWeight ? `${invoiceData.totalNetWeight} KGS` : '-'),
      labelValueRow('Total Gross Weight:', invoiceData.totalGrossWeight ? `${invoiceData.totalGrossWeight} KGS` : '-'),
      labelValueRow('Total Packages:', invoiceData.numberOfPackages || '-')
    ],
    width: { size: 5000, type: WidthType.DXA }
  });

  const rightCellChildren = [
    invoiceInfoTable,
    new Paragraph({ text: '' }),
    makeParagraph('Shipping & Logistics', { bold: true, size: 22 }),
    shippingTable
  ];

  const topTable = new Table({
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [exporterTable],
            width: { size: 5040, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            borders: DEFAULT_BORDERS
          }),
          new TableCell({
            children: rightCellChildren,
            width: { size: 5040, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            borders: DEFAULT_BORDERS
          })
        ]
      })
    ],
    width: { size: 10080, type: WidthType.DXA }
  });

  sectionChildren.push(topTable);
  sectionChildren.push(new Paragraph({ text: '' }));

  const consigneeCellChildren = [
    makeParagraph('Consignee (Ship To)', { bold: true, size: 22 }),
    makeParagraph(safeText(consignee.name, ''), { bold: true, size: 20 }),
    ...(consignee.address ? [makeParagraph(consignee.address, { size: 18 })] : []),
    ...consigneeIdRows
  ];

  const buyerCellChildren = [
    makeParagraph('Buyer (Bill To)', { bold: true, size: 22 }),
    makeParagraph(safeText(buyer.name, ''), { bold: true, size: 20 }),
    ...(buyer.address ? [makeParagraph(buyer.address, { size: 18 })] : []),
    ...buyerIdRows
  ];

  const partiesTable = new Table({
    rows: [
      new TableRow({
        children: [
          new TableCell({ children: consigneeCellChildren, width: { size: 5040, type: WidthType.DXA }, verticalAlign: VerticalAlign.TOP, borders: DEFAULT_BORDERS }),
          new TableCell({ children: buyerCellChildren, width: { size: 5040, type: WidthType.DXA }, verticalAlign: VerticalAlign.TOP, borders: DEFAULT_BORDERS })
        ]
      })
    ],
    width: { size: 10080, type: WidthType.DXA }
  });

  sectionChildren.push(partiesTable);
  sectionChildren.push(new Paragraph({ text: '' }));

  const symbol = currencySymbol(invoiceData.currency || 'USD');
  const headers = ['Sr', 'Description', 'HSN', 'Qty', 'Unit', `Rate(${symbol})`, 'Rate(₹)', 'Amount(₹)'];
  const taxColWidths = [600, 2980, 1000, 700, 800, 1300, 1300, 1400];
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, idx) => cell(h, AlignmentType.CENTER, 1, true, 14, 'E0E0E0', '000000', taxColWidths[idx]))
  });

  const rows = [headerRow];
  let totalTaxable = 0;
  let grandTotalINR = 0;

  lineItems.forEach((item, idx) => {
    const qty = parseFloat(item.qty) || 0;
    const rateUSD = parseFloat(item.rate) || 0;
    const rateINR = rateUSD * exRate;
    const taxableValue = qty * rateINR;
    const totalRowINR = taxableValue;

    totalTaxable += taxableValue;
    grandTotalINR += totalRowINR;

    rows.push(new TableRow({
      children: [
        cell(String(idx + 1), AlignmentType.CENTER, 1, false, 14, null, "000000", taxColWidths[0]),
        cell(item.description, AlignmentType.LEFT, 1, false, 14, null, "000000", taxColWidths[1]),
        cell(item.hsn, AlignmentType.CENTER, 1, false, 14, null, "000000", taxColWidths[2]),
        cell(String(qty), AlignmentType.CENTER, 1, false, 14, null, "000000", taxColWidths[3]),
        cell(item.unit || 'NOS', AlignmentType.CENTER, 1, false, 14, null, "000000", taxColWidths[4]),
        cell(rateUSD.toFixed(2), AlignmentType.CENTER, 1, false, 14, null, "000000", taxColWidths[5]),
        cell(rateINR.toFixed(2), AlignmentType.CENTER, 1, false, 14, null, "000000", taxColWidths[6]),
        cell(totalRowINR.toFixed(2), AlignmentType.CENTER, 1, false, 14, null, "000000", taxColWidths[7]),
      ]
    }));
  });

  rows.push(new TableRow({
    children: [
      cell('Total', AlignmentType.RIGHT, 7, true),
      cell(grandTotalINR.toFixed(2), AlignmentType.CENTER, 1, true),
    ]
  }));

  const itemsTable = new Table({
    rows: rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    columnWidths: taxColWidths
  });

  sectionChildren.push(itemsTable);

  sectionChildren.push(new Paragraph({ text: '' }));
  sectionChildren.push(new Paragraph({
    children: [
      new TextRun({ text: 'Total Invoice Amount in INR: ', bold: true, size: 16 }),
      new TextRun({ text: `₹ ${grandTotalINR.toFixed(2)}`, size: 16 })
    ]
  }));

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: { top: 500, bottom: 500, left: 500, right: 500 },
          orientation: PageOrientation.LANDSCAPE
        }
      },
      headers: { default: header },
      footers: { default: footer },
      children: sectionChildren
    }]
  });

  return await Packer.toBuffer(doc);
}

// =========================================================================
// 3. PROFORMA INVOICE GENERATOR
// =========================================================================
async function generatePIWord(piData, lineItems, currencyLabel = 'INR') {
  const headerChildren = [];
  const imgBuffer = getImageBuffer();
  if (imgBuffer) {
    headerChildren.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new ImageRun({ data: imgBuffer, transformation: { width: 173, height: 60 } })]
    }));
  }
  const header = new Header({ children: headerChildren });

  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: 'Morsebiz Technology Services Pvt Ltd', bold: true, size: 16 })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          text: 'Regd. Office: 20th Floor, Building No/Flat No – CTS No 95 4 B 3&4, 590 Oberoi Garden City, Goregaon East, Mumbai 400063 | CIN: U72900MH2021PTC362935',
          size: 14
        })]
      }),
    ]
  });

  const sectionChildren = [];

  sectionChildren.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 200 },
      children: [new TextRun({ text: 'PROFORMA INVOICE', bold: true, size: 24, underline: {} })]
    })
  );

  const exporter = piData.exporter || {
    name: "Morsebiz Technology Services Pvt Ltd",
    address: "20th Floor, Building No/Flat No – CTS No 95 4 B 3&4, 590 Oberoi Garden City, Goregaon East, Mumbai, Mumbai Suburban, Maharashtra 400063",
    gstNo: "27AAPCM5559A1Z9"
  };
  const buyer = piData.buyer || {};
  const consignee = piData.consignee || buyer;

  const exporterIdRows = optionalLabelValueParagraphs(
    [{ label: 'GST', value: exporter.gstNo }],
    { labelSize: 18, valueSize: 18 }
  );

  const exporterInfoCell = new TableCell({
    children: [
      makeParagraph('Exporter / Shipper', { bold: true, size: 22 }),
      makeParagraph(safeText(exporter.name, ''), { bold: true, size: 20 }),
      ...(exporter.address ? [makeParagraph(exporter.address, { size: 18 })] : []),
      ...exporterIdRows
    ],
    verticalAlign: VerticalAlign.TOP,
    borders: DEFAULT_BORDERS
  });

  const invoiceInfoTable = new Table({
    rows: [
      labelValueRow('PI No.:', piData.piNumber),
      labelValueRow('PI Date:', formatDateDisplay(piData.piDate)),
      labelValueRow('Terms of Payment:', piData.termsOfPayment || '-'),
      labelValueRow('Terms of Delivery:', formatDeliveryTerms(piData.termsOfDelivery)),
      labelValueRow('Currency:', currencyLabel)
    ],
    width: { size: 5000, type: WidthType.DXA }
  });

  const mainTable = new Table({
    rows: [
      new TableRow({
        children: [
          exporterInfoCell,
          new TableCell({
            children: [invoiceInfoTable],
            width: { size: 5040, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            borders: DEFAULT_BORDERS
          })
        ]
      })
    ],
    width: { size: 10080, type: WidthType.DXA }
  });

  sectionChildren.push(mainTable);
  sectionChildren.push(new Paragraph({ text: '' }));

  const partiesTable = new Table({
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [
              makeParagraph('Consignee', { bold: true, size: 22 }),
              makeParagraph(safeText(consignee.name || consignee.cust_name, ''), { bold: true, size: 20 }),
              ...(consignee.address?.address_lines ? [makeParagraph(consignee.address.address_lines, { size: 18 })] : []),
              ...(consignee.address?.city ? [makeParagraph(`${consignee.address.city}, ${consignee.address.country || ''}`, { size: 18 })] : [])
            ],
            width: { size: 5040, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            borders: DEFAULT_BORDERS
          }),
          new TableCell({
            children: [
              makeParagraph('Buyer', { bold: true, size: 22 }),
              makeParagraph(safeText(buyer.name || buyer.cust_name, ''), { bold: true, size: 20 }),
              ...(buyer.address?.address_lines ? [makeParagraph(buyer.address.address_lines, { size: 18 })] : []),
              ...(buyer.address?.city ? [makeParagraph(`${buyer.address.city}, ${buyer.address.country || ''}`, { size: 18 })] : [])
            ],
            width: { size: 5040, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            borders: DEFAULT_BORDERS
          })
        ]
      })
    ],
    width: { size: 10080, type: WidthType.DXA }
  });

  sectionChildren.push(partiesTable);
  sectionChildren.push(new Paragraph({ text: '' }));

  // Items Table
  const headers = ['Sr', 'Brand', 'Part No', 'Description', 'Qty', 'Rate', 'Amount'];
  const colWidths = [900, 1500, 1800, 2780, 800, 1100, 1200];
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, idx) => cell(h, AlignmentType.CENTER, 1, true, 20, 'E0E0E0', '000000', colWidths[idx]))
  });

  const rows = [headerRow];
  lineItems.forEach((item, i) => {
    const qty = Number(item.quantity) || 0;
    const rate = Number(item.rate) || 0;
    const amount = qty * rate;
    rows.push(new TableRow({
      children: [
        cell(String(i + 1), AlignmentType.CENTER, 1, false, 18, null, "000000", colWidths[0]),
        cell(item.brand || '', AlignmentType.CENTER, 1, false, 18, null, "000000", colWidths[1]),
        cell(item.part_number || '', AlignmentType.CENTER, 1, false, 18, null, "000000", colWidths[2]),
        cell(item.description || '-', AlignmentType.LEFT, 1, false, 14, null, "000000", colWidths[3]),
        cell(String(qty), AlignmentType.CENTER, 1, false, 18, null, "000000", colWidths[4]),
        cell(formatMoney(rate, currencyLabel), AlignmentType.CENTER, 1, false, 18, null, "000000", colWidths[5]),
        cell(formatMoney(amount, currencyLabel), AlignmentType.CENTER, 1, false, 18, null, "000000", colWidths[6]),
      ]
    }));
  });

  sectionChildren.push(new Table({
    rows,
    width: { size: 10080, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: colWidths
  }));

  sectionChildren.push(new Paragraph({ text: '' }));

  const subtotal = lineItems.reduce((acc, item) => acc + (Number(item.quantity) * Number(item.rate)), 0);
  const grandTotal = subtotal;

  const summaryRows = [
    new TableRow({
      children: [
        cell('Subtotal', AlignmentType.RIGHT, 1, false, 18),
        cell(formatMoney(subtotal, currencyLabel), AlignmentType.CENTER, 1, false, 18)
      ]
    }),
    new TableRow({
      children: [
        cell('GRAND TOTAL', AlignmentType.RIGHT, 1, true, 20),
        cell(formatMoney(grandTotal, currencyLabel), AlignmentType.CENTER, 1, true, 20)
      ]
    })
  ];

  const summaryTable = new Table({
    rows: summaryRows,
    width: { size: 4000, type: WidthType.DXA },
    alignment: AlignmentType.RIGHT
  });

  sectionChildren.push(summaryTable);
  sectionChildren.push(new Paragraph({ text: '' }));

  // Bank Details
  if (piData.bank_account_info) {
    const bank = piData.bank_account_info;
    sectionChildren.push(makeParagraph('Bank Account Details:', { bold: true, size: 20 }));
    sectionChildren.push(makeParagraph(`Bank Name: ${bank.bank_name}`, { size: 18 }));
    sectionChildren.push(makeParagraph(`Account Name: ${bank.account_name}`, { size: 18 }));
    sectionChildren.push(makeParagraph(`Account Number: ${bank.account_number}`, { size: 18 }));
    sectionChildren.push(makeParagraph(`IFSC Code: ${bank.ifsc_code}`, { size: 18 }));
    if (bank.swift_code) sectionChildren.push(makeParagraph(`SWIFT Code: ${bank.swift_code}`, { size: 18 }));
  }

  const finalDoc = new Document({
    sections: [{
      properties: { page: { margin: { top: 500, bottom: 500, left: 500, right: 500 } } },
      headers: { default: header },
      footers: { default: footer },
      children: sectionChildren
    }]
  });

  return await Packer.toBuffer(finalDoc);
}

module.exports = {
  generateWordInvoice,
  generateTaxInvoiceWord,
  generatePIWord
};
