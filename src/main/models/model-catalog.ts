/** Built-in identities and proven capability defaults retained for migration. */
export type BuiltinModelProfile = {
  id: string;
  displayName: string;
  shortName: string;
  quantization: string;
  maxContext: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  modelPath: string;
  mmprojPath?: string;
};

export const builtinModelCatalog: readonly BuiltinModelProfile[] = [
  { id: 'qwen3.8:27b-q4_K_M', displayName: 'Qwen3.8-27B', shortName: 'Qwen3.8', quantization: 'Q4_K_M', maxContext: 262_144, supportsTools: true, supportsReasoning: true, modelPath: 'qwen3.8-27b-q4_K_M.gguf', mmprojPath: 'qwen3.8-27b-mmproj.gguf' },
  { id: 'qwen3.6:35b-a3b-ud-q4_k_m', displayName: 'Qwen3.6-35B-A3B', shortName: 'Qwen3.6', quantization: 'UD-Q4_K_M', maxContext: 262_144, supportsTools: true, supportsReasoning: true, modelPath: 'Qwen3.6-35B-A3B-Q4_K_M/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', mmprojPath: 'Qwen3.6-35B-A3B-Q4_K_M/mmproj-BF16.gguf' },
  { id: 'huihui-qwen3.8:27b-ud-dw-q4_k_m', displayName: 'Huihui Qwen3.8-27B (abliterated)', shortName: 'Huihui Qwen3.8', quantization: 'UD-DW-Q4_K_M', maxContext: 262_144, supportsTools: true, supportsReasoning: true, modelPath: 'Huihui-Qwen3.8-27B-abliterated-UD-DW-Q4_K_M.gguf', mmprojPath: 'huihui-qwen3.8-27b-mmproj-bf16.gguf' },
];

export const contextPresets = [16_384, 32_768, 65_536, 131_072, 262_144] as const;
