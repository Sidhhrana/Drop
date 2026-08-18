// High-Throughput Background Web Worker: 16 MB Block-Buffered Fast Disk Slicer
// Slices in 16MB RAM blocks to eliminate disk IPC latency bottlenecks

self.onmessage = async (e) => {
  const { file, chunkSize, fileId } = e.data;
  if (!file) return;

  try {
    const BLOCK_SIZE = 16 * 1024 * 1024; // 16 MB block read from disk
    const totalChunks = Math.ceil(file.size / chunkSize);
    let chunkIndex = 0;
    let fileOffset = 0;

    while (fileOffset < file.size) {
      // 1. Read 16 MB block from disk into RAM in a single fast I/O operation
      const blockLength = Math.min(BLOCK_SIZE, file.size - fileOffset);
      const blockBuffer = await file.slice(fileOffset, fileOffset + blockLength).arrayBuffer();
      const blockBytes = new Uint8Array(blockBuffer);

      let blockOffset = 0;
      while (blockOffset < blockLength) {
        const payloadLength = Math.min(chunkSize, blockLength - blockOffset);
        
        // Pack 4-byte chunk index prefix + binary payload
        const packet = new Uint8Array(4 + payloadLength);
        new DataView(packet.buffer).setUint32(0, chunkIndex, false);
        packet.set(blockBytes.subarray(blockOffset, blockOffset + payloadLength), 4);

        // Transfer ownership of ArrayBuffer to the main thread with ZERO COPY!
        self.postMessage({
          type: 'chunk',
          fileId,
          chunkIndex,
          payloadLength,
          buffer: packet.buffer
        }, [packet.buffer]);

        blockOffset += payloadLength;
        chunkIndex++;
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
