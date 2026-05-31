/**
 * EmbeddingService — обёртка над @xenova/transformers (ONNX, локально).
 *
 * Безопасность / приватность (см. CLAUDE.md, SECURITY.md):
 *   - Единственный сетевой вызов в runtime во всём проекте — однократная
 *     загрузка модели (~120MB) при ПЕРВОМ обращении к pipeline().
 *   - Модель кэшируется в `./.safeflow/models/` внутри проекта. Никаких
 *     глобальных путей.
 *   - Если модель ещё не скачана (needsDownload === true), вызывающий код
 *     обязан деградировать к FTS-only, а не молча тянуть сеть.
 */

import * as path from "node:path";
import * as fs from "node:fs";

const MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIM = 384;

/** Минимальная форма выхода feature-extraction pipeline. */
interface FeatureExtractionOutput {
  data: Float32Array | number[];
  dims: number[];
}

type FeatureExtractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<FeatureExtractionOutput>;

export class EmbeddingService {
  private pipelinePromise: Promise<FeatureExtractor> | null = null;
  private readonly modelCacheDir: string;

  constructor(safeflowDir: string) {
    this.modelCacheDir = path.join(safeflowDir, "models");
    fs.mkdirSync(this.modelCacheDir, { recursive: true });
  }

  /**
   * true, если модель ещё не загружена в локальный кэш. В этом режиме
   * вызывающий код НЕ должен инициировать загрузку без согласия пользователя.
   */
  needsDownload(): boolean {
    const modelPath = path.join(
      this.modelCacheDir,
      MODEL_ID.replace("/", path.sep),
    );
    return !fs.existsSync(modelPath);
  }

  private async getPipeline(): Promise<FeatureExtractor> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        const transformers = await import("@xenova/transformers");
        transformers.env.cacheDir = this.modelCacheDir;
        transformers.env.allowRemoteModels = true;
        transformers.env.allowLocalModels = true;
        const extractor = await transformers.pipeline(
          "feature-extraction",
          MODEL_ID,
          { quantized: true },
        );
        return extractor as unknown as FeatureExtractor;
      })();
    }
    return this.pipelinePromise;
  }

  /**
   * Возвращает по одному нормализованному вектору на каждый входной текст.
   * Бросает, если размерность модели не совпадает с EMBEDDING_DIM.
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const model = await this.getPipeline();
    const output = await model(texts, { pooling: "mean", normalize: true });
    const dim = output.dims[output.dims.length - 1];
    if (dim !== EMBEDDING_DIM) {
      throw new Error(`Expected dim ${EMBEDDING_DIM}, got ${dim}`);
    }
    const data =
      output.data instanceof Float32Array
        ? output.data
        : Float32Array.from(output.data);
    const result: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      result.push(data.slice(i * dim, (i + 1) * dim));
    }
    return result;
  }

  async embedOne(text: string): Promise<Float32Array> {
    const [v] = await this.embed([text]);
    if (!v) throw new Error("embedding produced no vector");
    return v;
  }
}
