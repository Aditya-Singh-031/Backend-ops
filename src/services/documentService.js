const { createReport } = require('docx-templates');
const fs = require('fs');
const path = require('path');

/**
 * Generates a DOCX file from a template by replacing placeholders with data.
 */
const generateDocument = async (templateName, data) => {
  try {
    const templatePath = path.join(__dirname, '..', 'assets', 'word docs', templateName);

    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template file not found: ${templatePath}`);
    }

    const templateBuffer = fs.readFileSync(templatePath);

    const buffer = await createReport({
      template: templateBuffer,
      data: data,
      cmdDelimiter: ['{', '}'],
      noSandbox: true
    });

    return Buffer.from(buffer);
  } catch (error) {
    console.error("Error in generateDocument:", error);
    throw error;
  }
};

module.exports = { generateDocument };
