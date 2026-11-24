import axios from "axios";
import fs from "fs";
import path from "path";
import { tempDir } from "../../../../utils/io-json.js";

async function downloadMedia(url, filepath) {
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    },
  });
  const tempFilePath = filepath || path.join(tempDir, `fileDownload_${Date.now()}.mp4`);
  await fs.promises.mkdir(path.dirname(tempFilePath), { recursive: true });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(tempFilePath);
    response.data.on("error", (err) => {
      writer.destroy();
      reject(err);
    });
    response.data.pipe(writer);
    writer.on("finish", () => {
      resolve(tempFilePath);
    });
    writer.on("error", reject);
  });
}

export { downloadMedia };