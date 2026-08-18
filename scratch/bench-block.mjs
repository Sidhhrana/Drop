import { performance } from 'perf_hooks';

// Benchmark: 11,000 individual 64KB slices vs 45 x 16MB block reads
const FILE_SIZE = 726 * 1024 * 1024; // 726 MB
const CHUNK_SIZE = 64 * 1024;
const BLOCK_SIZE = 16 * 1024 * 1024; // 16 MB block in RAM

console.log('Testing in-memory block slicing vs individual slicing...');

const bigBuffer = new Uint8Array(BLOCK_SIZE);
bigBuffer.fill(42);

const t0 = performance.now();
let count = 0;
for (let offset = 0; offset < BLOCK_SIZE; offset += CHUNK_SIZE) {
  const slice = bigBuffer.subarray(offset, offset + CHUNK_SIZE);
  count++;
}
const t1 = performance.now();

console.log(`Sliced ${count} chunks in ${(t1 - t0).toFixed(3)}ms (RAM speed: ${((BLOCK_SIZE / (1024*1024)) / ((t1-t0)/1000)).toFixed(1)} MB/s)`);
