const PDFDocument = require('pdfkit');

// Renders the Claude-generated call recap text (see callSummary.js) into a
// small branded PDF, served by the /call-summary/:conversationUuid.pdf route
// in server.js and referenced as the document header of the approved
// henry_callrecap WhatsApp template.
function renderSummaryPdf(summaryText) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).fillColor('#1a3d7c').text('Vonage Estate — Call Summary', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#666666').text(new Date().toLocaleString('en-GB'));
    doc.moveDown(1.2);
    doc.fontSize(12).fillColor('#000000').text(summaryText, { align: 'left', lineGap: 4 });

    doc.end();
  });
}

module.exports = { renderSummaryPdf };
