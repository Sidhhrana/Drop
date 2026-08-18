// Benchmark direct in-memory 4MB block slicing without worker IPC
import { performance } from 'perf_hooks';

const sizeMB = 100;
const bytes = new Uint8Array(sizeMB * 1024 * 1024);
bytes.fill(0x55);
const blob = new Blob([bytes]);

async function bench() {
  const CHUNK_SIZE = 64 * 1024 - 4;
  const BLOCK_SIZE = 4 * 1024 * 1024;
  const t0 = performance.now();

  let fileOffset = 0;
  let chunkIndex = 0;
  let totalChunks = 0;

  while (fileOffset < blob.size) {
    const blockLength = Math.min(BLOCK_SIZE, blob.size - fileOffset);
    const blockBuffer = await blob.slice(fileOffset, fileOffset + blockLength).arrayBuffer();
    const blockBytes = new Uint8Array(blockBuffer);

    let blockOffset = 0;
    while (blockOffset < blockLength) {
      const payloadLength = Math.min(CHUNK_SIZE, blockLength - blockOffset);
      const packet = new Uint8Array(4 + payloadLength);
      new DataView(packet.buffer).setUint32(0, chunkIndex, false);
      packet.set(blockBytes.subarray(blockOffset, blockOffset + payloadLength), 4);

      totalChunks++;
      chunkIndex++;
      blockOffset += payloadLength;
    }
    fileOffset += blockLength;
  }

  const t1 = performance.now();
  const elapsed = (t1 - t0) / 1000;
  const speedMBps = sizeMB / elapsed;

  console.log(`⚡ Sliced ${sizeMB}MB into ${totalChunks} chunks in ${elapsed.toFixed(3)}s (${speedMBps.toFixed(2)} MB/s)!`);
}

bench().catch(console.error);
