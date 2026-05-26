// modules/qris_emv.js
// Generate QRIS dynamic (set amount) from BASE QR string (EMVCo) + recompute CRC (Tag 63)

function crc16ccittFalse(str) {
  // CRC16-CCITT-FALSE: poly 0x1021, init 0xFFFF, xorout 0x0000, refin=false, refout=false
  let crc = 0xffff;
  const bytes = Buffer.from(str, 'utf8');

  for (const b of bytes) {
    crc ^= (b << 8);
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function parseTLV(payload) {
  // Parse top-level EMV TLV: ID(2) + LEN(2) + VALUE(LEN)
  const items = [];
  let i = 0;

  while (i + 4 <= payload.length) {
    const id = payload.slice(i, i + 2);
    const lenStr = payload.slice(i + 2, i + 4);
    const len = parseInt(lenStr, 10);

    if (Number.isNaN(len) || len < 0) break;

    const valueStart = i + 4;
    const valueEnd = valueStart + len;

    if (valueEnd > payload.length) break;

    const value = payload.slice(valueStart, valueEnd);
    items.push({ id, lenStr, value });

    i = valueEnd;
  }

  return items;
}

function buildTLV(items) {
  return items
    .map(({ id, value }) => {
      const len = String(value.length).padStart(2, '0');
      return `${id}${len}${value}`;
    })
    .join('');
}

function upsertTag(items, id, value, { afterId = null } = {}) {
  const idx = items.findIndex(x => x.id === id);
  if (idx !== -1) {
    items[idx].value = value;
    return;
  }

  const newItem = { id, value };

  if (afterId) {
    const afterIdx = items.findIndex(x => x.id === afterId);
    if (afterIdx !== -1) {
      items.splice(afterIdx + 1, 0, newItem);
      return;
    }
  }

  items.push(newItem);
}

function removeTag(items, id) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].id === id) items.splice(i, 1);
  }
}

/**
 * Build QRIS dynamic string with amount.
 * - Sets Tag 01 -> "12" (dynamic) (kalau ada)
 * - Upserts Tag 54 (transaction amount)
 * - Recomputes Tag 63 CRC
 */
function buildQrisWithAmount(baseQris, amount) {
  if (!baseQris || typeof baseQris !== 'string') {
    throw new Error('BASE QRIS kosong / bukan string');
  }

  // Trim spaces/newlines
  let base = baseQris.trim();

  // Remove existing CRC tag 63 if present (we will rebuild)
  // Safer: parse, remove tag 63 explicitly
  let items = parseTLV(base);

  // If parsing fails badly, still try to strip trailing 6304XXXX pattern
  if (!items.length) {
    // fallback: remove last 8 chars after "6304" if exists
    const p = base.lastIndexOf('6304');
    if (p !== -1 && p + 8 <= base.length) base = base.slice(0, p);
    items = parseTLV(base);
  }

  // Remove Tag 63 (CRC)
  removeTag(items, '63');

  // Set dynamic indicator if tag 01 exists
  if (items.some(x => x.id === '01')) {
    upsertTag(items, '01', '12');
  }

  // Amount as string (integer is OK; if you want decimals: "1006.00")
  const amtStr = String(amount);

  // Upsert Tag 54 (amount). Recommended placement: after 53 (currency) if exists.
  if (items.some(x => x.id === '53')) upsertTag(items, '54', amtStr, { afterId: '53' });
  else upsertTag(items, '54', amtStr);

  // Build without CRC first
  const withoutCrc = buildTLV(items);

  // Append CRC placeholder and compute
  const toCrc = `${withoutCrc}6304`;
  const crc = crc16ccittFalse(toCrc);

  // Final payload
  return `${withoutCrc}6304${crc}`;
}

module.exports = { buildQrisWithAmount };

