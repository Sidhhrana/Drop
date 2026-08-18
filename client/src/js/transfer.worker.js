// Background Web Worker for Zero-Copy Chunk Slicing and Packaging
// Runs on a separate CPU core to eliminate main-thread Garbage Collection and UI lag

self.onmessage = async (e) => {
  const { file, chunkSize, fileId } = e.data;
  if (!file) return;

  try {
    let offset = 0;
    let chunkIndex = 0;
    const totalChunks = Math.ceil(file.size / chunkSize);

    while (offset < file.size) {
      const length = Math.min(chunkSize, file.size - offset);
      const rawBuffer = await file.slice(offset, offset + length).arrayBuffer();

      // Pack 4-byte chunk index prefix + binary payload
      const packet = new Uint8Array(4 + rawBuffer.byteLength);
      new DataView(packet.buffer).setUint32(0, chunkIndex, false);
      packet.set(new Uint8Array(rawBuffer), 4);

      // Transfer ownership of ArrayBuffer to the main thread with ZERO COPY!
      self.postMessage({
        type: 'chunk',
        fileId,
        chunkIndex,
        payloadLength: rawBuffer.byteLength,
        buffer: packet.buffer
      }, [packet.buffer]);

      offset += length;
      chunkIndex++;
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
