// 确定性伪随机数发生器：mulberry32
// 版本标识：mulberry32@1 —— 同版本同种子产生完全相同的序列。
export const RNG_VERSION = "mulberry32@1";

export type Rng = () => number; // 返回 [0, 1)

export function createRng(seed: number): Rng {
  // 将种子规范化为 32 位无符号整数
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
