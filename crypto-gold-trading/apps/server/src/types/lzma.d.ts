declare module "lzma" {
  export function decompress(data: Buffer | Uint8Array | number[], onFinish: (result: number[] | string, error?: Error) => void, onProgress?: (p: number) => void): void;
  export function compress(data: Buffer | Uint8Array | number[] | string, mode: number, onFinish: (result: number[], error?: Error) => void, onProgress?: (p: number) => void): void;
}
