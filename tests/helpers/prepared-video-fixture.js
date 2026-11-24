import fs from 'node:fs';
export async function prepareVideoFixture(filePath) {
  const thumbnailPath = `${filePath}.jpg`;
  fs.writeFileSync(thumbnailPath, 'jpeg fixture');
  return { filePath, thumbnailPath, metadata: { duration: 400, width: 720, height: 1280, fileSize: fs.statSync(filePath).size } };
}
