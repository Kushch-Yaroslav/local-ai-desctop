/**
 * Internal-only MiniCPM-V worker. This is deliberately absent from model-registry.ts,
 * so it cannot become a selectable Chat or Agent model.
 */
export const VISION_MODEL_LABEL = 'MiniCPM-V 4.5 8B';
export const DEFAULT_VISION_MODEL_ID = 'minicpm-v4.5:q4_K_M';
export const configuredVisionModelId = (): string => process.env.LOCAL_AI_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL_ID;
export const VISION_MODEL_CONFIGURATION = 'LOCAL_AI_VISION_MODEL';
