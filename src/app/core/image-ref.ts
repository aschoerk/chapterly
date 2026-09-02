/** True when the stored avatar/icon is a raster image rather than an emoji/text. */
export function isImageRef(value: string | null | undefined): boolean {
  if (!value) return false;
  return (
    value.startsWith('data:image/') ||
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('blob:')
  );
}
