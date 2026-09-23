/**
 * Image preprocessing for vision inference.
 *
 * On a 2-core ARM box the dominant cost of a vision model is prefill, which
 * scales with the number of image tokens -- i.e. with resolution. But the real
 * inputs here are photographs of dense Excel grids and printed schedules where
 * the names are already near the limit of legibility, so downscaling too far
 * destroys exactly the text we need.
 *
 * Hence: keep colour (red annotations and pink handwriting carry meaning),
 * respect EXIF rotation, and cap the long edge at a configurable size.
 */

import sharp from 'sharp';

const MAX_EDGE = parseInt(process.env.IMAGE_MAX_EDGE || '1536', 10);
const JPEG_QUALITY = parseInt(process.env.IMAGE_JPEG_QUALITY || '85', 10);

/**
 * @param {Buffer} buffer raw image as uploaded to LINE
 * @returns {Promise<{buffer: Buffer, width: number, height: number, originalWidth: number, originalHeight: number}>}
 */
export async function prepareForInference(buffer) {
  const image = sharp(buffer, { failOn: 'none' }).rotate(); // rotate() applies EXIF orientation
  const metadata = await image.metadata();

  const longestEdge = Math.max(metadata.width || 0, metadata.height || 0);
  const pipeline = longestEdge > MAX_EDGE
    ? image.resize({
        width: metadata.width >= metadata.height ? MAX_EDGE : null,
        height: metadata.height > metadata.width ? MAX_EDGE : null,
        fit: 'inside',
        withoutEnlargement: true,
        kernel: 'lanczos3'
      })
    : image;

  const output = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer({ resolveWithObject: true });

  return {
    buffer: output.data,
    width: output.info.width,
    height: output.info.height,
    originalWidth: metadata.width || 0,
    originalHeight: metadata.height || 0
  };
}

/** data: URI form expected by both llama-server and Gemini's inlineData. */
export function toBase64(buffer) {
  return buffer.toString('base64');
}
