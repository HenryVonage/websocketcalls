const PDFDocument = require('pdfkit');
const { fetchWithTimeout } = require('./httpClient');
const { getArtistImageUrl } = require('./spotifyApi');
const musicConfig = require('./musicLoversConfig');

// Renders a fake, per-artist concert ticket PDF for a Music Lovers caller
// who ordered tickets on an inbound voice call (Sept 2026, Henry's request:
// "generate a fake ticket that relates to the selected artist"). Served by
// the /music-lovers/ticket/:ticketKey.pdf route in server.js.
//
// Redesigned (Sept 2026, Henry: "the pdf generated is really basic, can you
// create a much cooler 1 page pdf") into an actual event-ticket layout —
// branded header band with the artist's own photo (same Spotify lookup used
// for henry_ticketing2's WhatsApp header, re-resolved here since the ticket
// record only stores the artist's name, not the image URL), a details grid,
// a dashed "tear-off" perforation with a decorative barcode stub, and a
// bottom brand band. Still a demo prop, not a real ticketing-system PDF —
// no genuine barcode/QR, no seat allocation system behind "Section"/"Gate".
const NAVY = '#12224f';
const ACCENT = '#6C4FF6';
const GOLD = '#F5B942';
const MUTED = '#8891a8';
const INK = '#1c2333';
const PAGE_BG = '#eef0f6';
const CARD_BG = '#ffffff';

// Best-effort image download into a Buffer pdfkit can embed. Returns null
// (never throws) on any failure — timeout, non-200, bad content — so a
// slow/broken image host degrades the ticket gracefully (no photo) instead
// of breaking the whole PDF, same fallback philosophy as the WhatsApp
// header's own lookup in voiceHandlers.js.
async function downloadImage(url) {
  if (!url) return null;
  try {
    const res = await fetchWithTimeout(url, {}, 8000);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error('Ticket PDF: artist image download failed (continuing without it):', err.message);
    return null;
  }
}

// Picks the largest font size (down to minSize) at which `text` still fits
// on a single line within maxWidth — used for the artist name so a long
// act name (a real risk: bands/collabs can run long) shrinks to fit
// instead of wrapping onto a second line and colliding with the
// "LIVE IN CONCERT" subtitle underneath it.
function fitFontSize(doc, text, maxWidth, startSize, minSize) {
  let size = startSize;
  doc.font('Helvetica-Bold');
  while (size > minSize) {
    doc.fontSize(size);
    if (doc.widthOfString(text) <= maxWidth) break;
    size -= 1;
  }
  return size;
}

// Purely decorative bar pattern — NOT a real, scannable barcode (see the
// file-level comment). Seeded from the order number so a given ticket
// always renders the same pattern rather than a new random one on every
// fetch, using a tiny linear-congruential PRNG (no crypto needed here).
function drawFakeBarcode(doc, x, y, width, height, seedText) {
  let seed = 0;
  for (const ch of String(seedText || 'ticket')) seed = (seed * 31 + ch.charCodeAt(0)) % 100000;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  let cursor = x;
  while (cursor < x + width - 2) {
    const barWidth = 1 + Math.floor(rand() * 3);
    if (rand() > 0.32) {
      doc.rect(cursor, y, barWidth, height).fill(INK);
    }
    cursor += barWidth + 1;
  }
}

async function renderTicketPdf({ name, artist, venue, date, orderNumber }) {
  let artistImageUrl = musicConfig.GENRE_PROMPT_HEADER_IMAGE_URL;
  try {
    artistImageUrl = (await getArtistImageUrl(artist)) || artistImageUrl;
  } catch (err) {
    console.error('Ticket PDF: artist-image lookup failed (using hero image instead):', err.message);
  }
  const artistImageBuffer = await downloadImage(artistImageUrl);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;

    // Full-page tint so the card reads as a designed layout rather than a
    // block of text floating on plain white.
    doc.rect(0, 0, pageWidth, pageHeight).fill(PAGE_BG);

    const marginX = 55;
    const cardX = marginX;
    const cardWidth = pageWidth - marginX * 2;
    const cardTop = 60;
    const cardHeight = 640;

    // Soft drop-shadow behind the card.
    doc.fillOpacity(0.12);
    doc.rect(cardX + 4, cardTop + 6, cardWidth, cardHeight).fill('#000000');
    doc.fillOpacity(1);

    doc.rect(cardX, cardTop, cardWidth, cardHeight).fill(CARD_BG);

    // --- Header band ---
    const headerHeight = 210;
    doc.rect(cardX, cardTop, cardWidth, headerHeight).fill(NAVY);
    doc.rect(cardX, cardTop, cardWidth, 5).fill(ACCENT);

    doc
      .fillColor('#ffffff')
      .font('Helvetica-Bold')
      .fontSize(10)
      .text('VONAGE MUSIC LOVERS', cardX + 34, cardTop + 28, { characterSpacing: 1.5 });

    const badgeText = 'ADMIT ONE';
    doc.font('Helvetica-Bold').fontSize(9);
    const badgeWidth = doc.widthOfString(badgeText) + 22;
    const badgeX = cardX + cardWidth - badgeWidth - 34;
    doc.roundedRect(badgeX, cardTop + 24, badgeWidth, 20, 10).fill(GOLD);
    doc.fillColor(NAVY).text(badgeText, badgeX, cardTop + 29, { width: badgeWidth, align: 'center' });

    const photoSize = 110;
    const photoX = cardX + cardWidth - photoSize - 34;
    const photoY = cardTop + 62;
    if (artistImageBuffer) {
      doc.save();
      doc.roundedRect(photoX, photoY, photoSize, photoSize, 10).clip();
      doc.image(artistImageBuffer, photoX, photoY, { cover: [photoSize, photoSize], align: 'center', valign: 'center' });
      doc.restore();
      doc.roundedRect(photoX, photoY, photoSize, photoSize, 10).lineWidth(2).stroke('#ffffff');
    }

    const nameMaxWidth = cardWidth - 68 - (artistImageBuffer ? photoSize + 24 : 0);
    const artistLabel = artist || 'Live in concert';
    const artistFontSize = fitFontSize(doc, artistLabel, nameMaxWidth, 29, 16);
    doc
      .fillColor('#ffffff')
      .font('Helvetica-Bold')
      .fontSize(artistFontSize)
      .text(artistLabel, cardX + 34, cardTop + 82, { width: nameMaxWidth, lineBreak: false, ellipsis: true });
    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor('#c7cef0')
      .text('LIVE IN CONCERT', cardX + 34, cardTop + 82 + 40, { width: nameMaxWidth, characterSpacing: 1.5 });

    // --- Info grid ---
    const infoTop = cardTop + headerHeight + 42;
    const colWidth = cardWidth / 2;
    const rows = [
      ['VENUE', venue || 'TBA'],
      ['DATE', date || 'TBA'],
      ['TICKET HOLDER', name || 'Guest'],
      ['ORDER NUMBER', orderNumber || '—'],
      ['SECTION', 'General Admission'],
      ['GATE', 'Gate A'],
    ];
    let rowY = infoTop;
    rows.forEach(([label, value], i) => {
      const col = i % 2;
      if (col === 0 && i > 0) rowY += 62;
      const x = cardX + 34 + col * colWidth;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(label, x, rowY, { characterSpacing: 1.2 });
      doc
        .font('Helvetica-Bold')
        .fontSize(14)
        .fillColor(INK)
        // lineBreak:false + ellipsis: an unusually long venue/holder name
        // truncates onto one line instead of wrapping into the next row's
        // fixed vertical slot (same reasoning as the artist name above).
        .text(value, x, rowY + 14, { width: colWidth - 55, lineBreak: false, ellipsis: true });
    });

    // --- Perforation ---
    const perfY = rowY + 62;
    doc.save();
    doc.dash(4, { space: 4 });
    doc.moveTo(cardX + 14, perfY).lineTo(cardX + cardWidth - 14, perfY).lineWidth(1.5).stroke('#d4d7e2');
    doc.undash();
    doc.restore();
    doc.circle(cardX, perfY, 11).fill(PAGE_BG);
    doc.circle(cardX + cardWidth, perfY, 11).fill(PAGE_BG);

    // --- Stub ---
    const stubTop = perfY + 28;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('ORDER', cardX + 34, stubTop, { characterSpacing: 1.2 });
    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(orderNumber || '—', cardX + 34, stubTop + 14);

    drawFakeBarcode(doc, cardX + cardWidth - 240, stubTop + 4, 206, 42, orderNumber || artist);

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        `This is a demo ticket generated for the Vonage Music Lovers showcase and is not a valid admission credential. Issued ${new Date().toLocaleString(
          'en-GB'
        )}.`,
        cardX + 34,
        stubTop + 66,
        { width: cardWidth - 68, lineGap: 3 }
      );

    // --- Bottom brand band ---
    doc.rect(cardX, cardTop + cardHeight - 34, cardWidth, 34).fill(NAVY);
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor('#c7cef0')
      .text('vonage.com  ·  Generated by the Vonage Music Lovers demo', cardX, cardTop + cardHeight - 34 + 11, {
        width: cardWidth,
        align: 'center',
        characterSpacing: 0.5,
      });

    doc.end();
  });
}

module.exports = { renderTicketPdf };
