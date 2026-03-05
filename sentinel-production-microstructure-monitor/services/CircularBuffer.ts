export class CircularBuffer<T> {
  private buffer: T[];
  private maxSize: number;
  private head: number = 0;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
    this.buffer  = [];
  }

  push(item: T): void {
    if (this.buffer.length < this.maxSize) {
      this.buffer.push(item);
    } else {
      this.buffer[this.head] = item;
      this.head = (this.head + 1) % this.maxSize;
    }
  }

  getLast(n: number): T[] {
    const size = this.buffer.length;
    if (n >= size) return [...this.buffer];
    const results: T[] = [];
    for (let i = 0; i < n; i++) {
      const idx = (this.head - 1 - i + size) % size;
      results.unshift(this.buffer[idx]);
    }
    return results;
  }

  getAll(): T[] {
    const size    = this.buffer.length;
    const results: T[] = [];
    for (let i = 0; i < size; i++) {
      results.push(this.buffer[(this.head + i) % size]);
    }
    return results;
  }

  mean(): number {
    if (this.buffer.length === 0) return 0;
    const sum = this.buffer.reduce(
      (acc, val) => acc + (typeof val === 'number' ? (val as unknown as number) : 0), 0
    );
    return sum / this.buffer.length;
  }

  // Returns the value at the given percentile (0.0–1.0).
  // p=0.90 → 90th percentile: 90% of values are ≤ this value.
  // Returns fallback if buffer is empty.
  percentile(p: number, fallback = 0): number {
    if (this.buffer.length === 0) return fallback;
    const sorted = [...this.buffer]
      .map(v => (typeof v === 'number' ? (v as unknown as number) : 0))
      .sort((a, b) => a - b);
    const idx = Math.min(
      Math.floor(sorted.length * p),
      sorted.length - 1
    );
    return sorted[idx] ?? fallback;
  }

  standardDeviation(): number {
    const size = this.buffer.length;
    if (size < 2) return 0;
    const m = this.mean();
    const squaredDiffs = this.buffer.reduce((acc, val) => {
      const num = typeof val === 'number' ? (val as unknown as number) : 0;
      return acc + Math.pow(num - m, 2);
    }, 0);
    return Math.sqrt(squaredDiffs / size);
  }

  size(): number { return this.buffer.length; }

  clear(): void {
    this.buffer = [];
    this.head   = 0;
  }
}
