// High-Throughput Batch Block Slicer Web Worker
// Slices 4MB disk blocks into arrays of 16 pre-indexed transferable packets

self.onmessage = async (e) => {
  const { file, chunkSize, fileId } = e.data;
  if (!file) return;

  try {
    const BLOCK_SIZE = 4 * 1024 * 1024; // 4 MB block read
    const totalChunks = Math.ceil(file.size / chunkSize);
    let chunkIndex = 0;
    let fileOffset = 0;

    while (fileOffset < file.size) {
      const blockLength = Math.min(BLOCK_SIZE, file.size - fileOffset);
      const blockBuffer = await file.slice(fileOffset, fileOffset + blockLength).arrayBuffer();
      const blockBytes = new Uint8Array(blockBuffer);

      let blockOffset = 0;
      const batch = [];
      const transferList = [];

      while (blockOffset < blockLength) {
        const payloadLength = Math.min(chunkSize, blockLength - blockOffset);
        
        // Pack 4-byte chunk index prefix + binary payload
        const packet = new Uint8Array(4 + payloadLength);
        new DataView(packet.buffer).setUint32(0, chunkIndex, false);
        packet.set(blockBytes.subarray(blockOffset, blockOffset + payloadLength), 4);

        batch.push({
          chunkIndex,
          payloadLength,
          buffer: packet.buffer
        });
        transferList.push(packet.buffer);

        blockOffset += payloadLength;
        chunkIndex++;

        // Send in batches of 16 chunks to eliminate postMessage IPC overhead
        if (batch.length >= 16 || blockOffset >= blockLength) {
          const toSend = batch.slice();
          const toTransfer = transferList.slice();
          batch.length = 0;
          transferList.length = 0;
          self.postMessage({
            type: 'chunk-batch',
            fileId,
            chunks: toSend
          }, toTransfer);
        }
      }

      fileOffset += blockLength;
    }

    self.postMessage({
      type: 'complete',
      fileId,
      totalChunks
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      fileId,
      error: err.message
    });
  }
};
