/**
 * exporter.js — resolution picker, PNG/JPEG export, and EXIF passthrough
 */

// ── EXIF injection ────────────────────────────────────────────────────────
//
// Canvas.toBlob() strips all metadata. For JPEG exports we re-inject the
// source file's APP1 (EXIF) segment, with the orientation tag patched to 1
// (since createImageBitmap already applied the rotation to the pixel data).
// PNG export: no standard EXIF support in canvas blobs — metadata skipped.

function extractApp1(sourceBuffer) {
  const src = new Uint8Array(sourceBuffer);
  if (src[0] !== 0xFF || src[1] !== 0xD8) return null; // not a JPEG

  let i = 2;
  while (i < src.length - 3) {
    if (src[i] !== 0xFF) { i++; continue; }
    const marker = src[i + 1];
    const segLen = (src[i + 2] << 8) | src[i + 3]; // includes the 2-byte length field

    if (marker === 0xE1) {
      // Check for "Exif\x00\x00" signature at offset +4
      if (src[i+4] === 0x45 && src[i+5] === 0x78 && src[i+6] === 0x69 &&
          src[i+7] === 0x66 && src[i+8] === 0x00 && src[i+9] === 0x00) {
        return src.slice(i, i + 2 + segLen); // includes FF E1 + length
      }
    }
    if (marker === 0xDA || marker === 0xD9) break; // SOS or EOI — stop scanning
    i += 2 + segLen;
  }
  return null;
}

function patchOrientation(app1Bytes) {
  // app1Bytes: Uint8Array starting with FF E1
  // TIFF header starts at offset 10 (after FF E1 + 2-byte len + "Exif\x00\x00")
  const clone = app1Bytes.slice();
  const tiffStart = 10;
  const byteOrder = (clone[tiffStart] === 0x49 && clone[tiffStart+1] === 0x49)
    ? 'LE' : 'BE';

  const read16 = (off) => byteOrder === 'LE'
    ? (clone[off] | (clone[off+1] << 8))
    : ((clone[off] << 8) | clone[off+1]);
  const read32 = (off) => byteOrder === 'LE'
    ? (clone[off] | (clone[off+1]<<8) | (clone[off+2]<<16) | (clone[off+3]<<24))
    : ((clone[off]<<24) | (clone[off+1]<<16) | (clone[off+2]<<8) | clone[off+3]);
  const write16 = (off, val) => {
    if (byteOrder === 'LE') { clone[off] = val & 0xFF; clone[off+1] = (val>>8) & 0xFF; }
    else                    { clone[off] = (val>>8) & 0xFF; clone[off+1] = val & 0xFF; }
  };

  const ifd0Offset = tiffStart + read32(tiffStart + 4);
  const entryCount = read16(ifd0Offset);

  for (let e = 0; e < entryCount; e++) {
    const entryOff = ifd0Offset + 2 + e * 12;
    if (read16(entryOff) === 0x0112) { // Orientation tag
      write16(entryOff + 8, 1); // value offset field = 1 (upright, no rotation)
      break;
    }
  }
  return clone;
}

async function injectExifToJpeg(jpegBlob, sourceBuffer) {
  if (!sourceBuffer) return jpegBlob;
  const app1 = extractApp1(sourceBuffer);
  if (!app1) return jpegBlob; // no EXIF in source (PNG/WebP/JPEG without EXIF)

  const patched   = patchOrientation(app1);
  const exported  = new Uint8Array(await jpegBlob.arrayBuffer());

  // Insert patched APP1 after the SOI (first 2 bytes) of the exported JPEG
  const result = new Uint8Array(exported.length + patched.length);
  result.set(exported.slice(0, 2));                           // SOI
  result.set(patched, 2);                                     // APP1
  result.set(exported.slice(2), 2 + patched.length);         // rest of JPEG

  return new Blob([result], { type: 'image/jpeg' });
}

// ── Main export logic ─────────────────────────────────────────────────────

export function initExporter({ getCropState }) {
  const exportPngBtn   = document.getElementById('exportPng');
  const exportJpgBtn   = document.getElementById('exportJpg');
  const customResInput = document.getElementById('customRes');
  const customResWrap  = document.getElementById('customResWrap');

  // Show/hide custom resolution input
  document.querySelectorAll('input[name="resolution"]').forEach(r => {
    r.addEventListener('change', () => {
      customResWrap.style.display = r.value === 'custom' && r.checked ? 'flex' : 'none';
    });
  });

  async function doExport(format) {
    const { bitmap, crop, sourceBuffer } = getCropState();
    if (!bitmap || !crop.w || !crop.h) return;

    const resValue = document.querySelector('input[name="resolution"]:checked')?.value;
    let outW, outH;

    if (resValue === 'native') {
      outW = crop.w;
      outH = crop.h;
    } else {
      const longEdge = resValue === 'custom'
        ? Number(customResInput.value)
        : Number(resValue);
      if (!longEdge || longEdge <= 0) { alert('Enter a custom resolution first.'); return; }
      const ar = crop.w / crop.h;
      if (crop.w >= crop.h) { outW = longEdge; outH = Math.round(longEdge / ar); }
      else                  { outH = longEdge; outW = Math.round(longEdge * ar); }
    }

    const offscreen = document.createElement('canvas');
    offscreen.width  = outW;
    offscreen.height = outH;
    const ctx = offscreen.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (format === 'image/jpeg') {
      ctx.fillStyle = '#ffffff'; // composite over white for any transparency
      ctx.fillRect(0, 0, outW, outH);
    }

    ctx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH);

    const ext     = format === 'image/jpeg' ? 'jpg' : 'png';
    const quality = format === 'image/jpeg' ? 0.92 : undefined;
    const fname   = 'crop_' + outW + 'x' + outH + '.' + ext;

    let blob = await new Promise(res => offscreen.toBlob(res, format, quality));

    // Re-inject source EXIF for JPEG; PNG canvas blobs carry no metadata
    if (format === 'image/jpeg') {
      blob = await injectExifToJpeg(blob, sourceBuffer);
    }

    const url = URL.createObjectURL(blob);
    const a   = Object.assign(document.createElement('a'), { href: url, download: fname });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  exportPngBtn.addEventListener('click', () => doExport('image/png'));
  exportJpgBtn.addEventListener('click', () => doExport('image/jpeg'));

  function setEnabled(enabled) {
    exportPngBtn.disabled = !enabled;
    exportJpgBtn.disabled = !enabled;
  }

  return { setEnabled };
}
