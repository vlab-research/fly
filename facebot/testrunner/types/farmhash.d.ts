declare module 'farmhash' {
  export function hash32(data: string): number;
  export function hash64(data: string): string;
  export function fingerprint32(data: string): number;
  export function fingerprint64(data: string): string;
  export function hash32WithSeed(data: string, seed: number): number;
  export function hash64WithSeed(data: string, seed: number): string;
  export function hash32WithSeeds(data: string, seed1: number, seed2: number): number;
  export function hash64WithSeeds(data: string, seed1: number, seed2: number): string;
} 