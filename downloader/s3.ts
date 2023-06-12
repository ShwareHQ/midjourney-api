import 'dotenv/config';
import axios from 'axios';
import { PassThrough } from 'stream';
import { Upload } from "@aws-sdk/lib-storage";
import { S3Client } from "@aws-sdk/client-s3";

const client = new S3Client({ region: <string>process.env.AWS_REGION });

export async function uploadUrl(key: string, url: string) {
  const stream = await axios.get(url, { responseType: 'stream' });
  const passThrough = new PassThrough();
  const upload = new Upload({
    client,
    params: {
      Key: `midjourney/${key}`,
      Bucket: 'pipencil-content',
      CacheControl: 'max-age=31536000',
      ContentType: 'image/png',
      Body: passThrough,
    },
    queueSize: 4, // optional concurrency configuration
    partSize: 1024 * 1024 * 5, // optional size of each part, in bytes, at least 5MB
    leavePartsOnError: false, // optional manually handle dropped parts
  });

  upload.on('httpUploadProgress', (progress) => {
    console.log(`Uploading ${key} part: ${progress.part}`);
  });

  stream.data.pipe(passThrough);
  await upload.done();
}
