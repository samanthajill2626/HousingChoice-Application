import { describe, it, expect } from 'vitest';
import { createSemaphore } from '../src/lib/semaphore.js';

describe('createSemaphore', () => {
  it('bounds concurrency to max', async () => {
    const sem = createSemaphore(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      const release = await sem.acquire(1000);
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--; release();
    };
    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBe(2);
  });

  it('times out when no slot frees in time', async () => {
    const sem = createSemaphore(1);
    const held = await sem.acquire(1000); // hold the only slot
    await expect(sem.acquire(30)).rejects.toThrow('semaphore_timeout');
    held();
  });

  it('a released slot lets a waiter proceed', async () => {
    const sem = createSemaphore(1);
    const first = await sem.acquire(1000);
    const p = sem.acquire(1000);
    setTimeout(() => first(), 10);
    const second = await p;
    expect(typeof second).toBe('function');
    second();
  });
});
