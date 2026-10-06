import { accessSync, constants, statSync } from 'node:fs';

/** llama.cpp's conventional split GGUF naming; the first shard is the launch path. */
export function ggufArtifactPaths(path: string): string[] {
  const split = path.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
  if (!split) return [path];
  const count = Number(split[3]);
  if (split[2] !== '00001' || count < 1 || count > 1_024) throw new Error('Некорректный первый файл split GGUF.');
  return Array.from({ length: count }, (_, index) => `${split[1]}-${String(index + 1).padStart(5, '0')}-of-${split[3]}.gguf`);
}

export function verifyGgufArtifacts(path: string): void {
  for (const artifact of ggufArtifactPaths(path)) {
    if (!statSync(artifact).isFile()) throw new Error(`GGUF не является файлом: ${artifact}.`);
    accessSync(artifact, constants.R_OK);
  }
}

/** Preserve single-file keys exactly; a split model's key includes every required shard. */
export function ggufArtifactFingerprint(path: string, live = false): string {
  const parts = ggufArtifactPaths(path).map((artifact) => {
    const file = statSync(artifact);
    if (!file.isFile()) throw new Error(`GGUF не является файлом: ${artifact}.`);
    return `${live ? `${file.dev}:${file.ino}:` : ''}${file.size}:${file.mtimeMs}`;
  });
  return parts.length === 1 ? parts[0] : JSON.stringify(parts);
}
