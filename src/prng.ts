/**
 * 确定性伪随机数发生器（PRNG）。
 *
 * 发生器版本: "mulberry32-v1"
 * - 算法: mulberry32（32 位状态，输出 [0,1) 的 double）
 * - 种子: 任意字符串先经 FNV-1a（32 位）散列成初始状态
 *
 * 同一版本字符串、同一种子与同一调用顺序，必定产生完全相同的序列。
 * 修改本文件算法时必须提升版本号（例如 mulberry32-v2）。
 */

export const PRNG_VERSION = "mulberry32-v1";

export interface Prng {
  /** 返回 [0, 1) 的浮点数 */
  next(): number;
}

/** FNV-1a 32 位字符串散列，用于把任意字符串种子映射为 32 位整数状态。 */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    // Math.imul 保证 32 位无符号乘法语义
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createPrng(seed: string): Prng {
  let state = hashSeed(seed);
  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      // 取高 32 位中的 24 位尾数映射到 [0,1)，与常见 mulberry32 实现一致
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
