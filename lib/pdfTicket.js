const PDFDocument = require('pdfkit');

// Renders a fake, per-artist concert ticket PDF for a Music Lovers caller
// who ordered tickets on an inbound voice call (Sept 2026, Henry's request:
// "generate a fake ticket that relates to the selected artist"). Served by
// the /music-lovers/ticket/:ticketKey.pdf route in server.js. Same
// pattern/library as pdfSummary.js's renderSummaryPdf — a small branded
// single-page document, not a real ticketing-system PDF (no barcode/QR —
// nothing here is a genuine admission credential, this is a demo prop).
// Kept to simple top-down flow (moveDown between blocks) rather than
// absolute-positioned boxes, same layout style as pdfSummary.js, so this
// stays reliable across different name/artist/venue lengths without any
// manual coordinate math to get wrong.
function renderTicketPdf({ name, artist, venue, date, orderNumber }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).fillColor('#1a3d7c').text('Vonage Music Lovers — Your Ticket', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#666666').text(`Order ${orderNumber} — issued ${new Date().toLocaleString('en-GB')}`);
    doc.moveDown(1.2);

    doc.fontSize(24).fillColor('#000000').text(artist);
    doc.moveDown(0.6);
    doc.fontSize(13).fillColor('#333333').text(`Venue: ${venue}`);
    doc.moveDown(0.2);
    doc.fontSize(13).fillColor('#333333').text(`Date: ${date}`);
    doc.moveDown(0.2);
    doc.fontSize(13).fillColor('#333333').text(`Ticket holder: ${name}`);

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#999999').text(
      'This is a demo ticket generated for the Vonage Music Lovers showcase and is not a valid admission credential.',
      { lineGap: 3 }
    );

    doc.end();
  });
}

module.exports = { renderTicketPdf };
